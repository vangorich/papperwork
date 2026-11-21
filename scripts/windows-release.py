"""Stage both production targets offline; publish a verified local candidate by a create-only rename.
Run with python -I. No installations, app launches, Git operations or network publication.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import shutil
import subprocess
import sys
import tempfile
import tomllib

import pefile

ROOT = Path(__file__).resolve().parents[1]
NOTES = ROOT / '.work-notes'
RELEASES = ROOT / 'release-tauri'
TARGETS = [('x64', 'x86_64-pc-windows-msvc', 0x8664), ('arm64', 'aarch64-pc-windows-msvc', 0xaa64)]

def require(condition, why):
    if not condition: raise RuntimeError(why)

def sha(path):
    with path.open('rb') as f: return hashlib.file_digest(f, 'sha256').hexdigest()

def dump(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + '\n', encoding='utf-8')

def inputs():
    files = ['package.json','package-lock.json','index.html','vite.config.ts','postcss.config.js','tailwind.config.ts','tsconfig.json',
             'build/qpdf-engine.mjs','build/qpdf-engine.d.mts','build/icon.ico','build/icon.png','src-tauri/Cargo.toml','src-tauri/Cargo.lock','src-tauri/tauri.conf.json','src-tauri/build.rs',
             'src-tauri/native-support/Cargo.toml','src-tauri/native-support/Cargo.lock','scripts/with-arm64-env.ps1','scripts/with-x64-env.ps1','scripts/verify-brand-pe.py','scripts/windows-release.py']
    for folder in ['src','public','src-tauri/src','src-tauri/native-support/src','src-tauri/capabilities','src-tauri/permissions','src-tauri/nsis']:
        files.extend(p.relative_to(ROOT).as_posix() for p in (ROOT/folder).rglob('*') if p.is_file() and 'target' not in p.relative_to(ROOT).parts)
    files.extend(p.relative_to(ROOT).as_posix() for p in (ROOT/'scripts').glob('mcp-client-config*.rs'))
    return {name:sha(ROOT/name) for name in sorted(set(files))}

def released():
    out={}
    for d in RELEASES.iterdir():
        if not d.is_dir() or not re.fullmatch(r'\d+\.\d+\.\d+',d.name): continue
        for line in (d/'SHA256SUMS.txt').read_text('ascii').splitlines():
            digest, leaf=line.split(None,1); path=d/leaf.strip()
            require(path.parent==d and sha(path)==digest.lower(), f'Prior release checksum differs: {path.name}')
        out.update({p.relative_to(RELEASES).as_posix():sha(p) for p in d.iterdir() if p.is_file()})
    return out

def version():
    lock=json.loads((ROOT/'package-lock.json').read_bytes()); cfg=json.loads((ROOT/'src-tauri/tauri.conf.json').read_bytes())
    vs=[json.loads((ROOT/'package.json').read_bytes())['version'],lock['version'], lock['packages']['']['version'],cfg['version'],
        tomllib.loads((ROOT/'src-tauri/Cargo.toml').read_text('utf8'))['package']['version'],next(p['version'] for p in tomllib.loads((ROOT/'src-tauri/Cargo.lock').read_text('utf8'))['package'] if p['name']=='paperwork-studio')]
    require(len(set(vs))==1 and re.fullmatch(r'\d+\.\d+\.\d+',vs[0]),'Version/lock mismatch')
    require(cfg['identifier']=='studio.paperwork.pdf' and cfg['productName']=='Paperwork PDF Studio','Not the production identifier')
    return vs[0]

def verify_pair(base, setup, helper, machine, ver, seven):
    branding=runpy.run_path(str(ROOT/'scripts/verify-brand-pe.py'))['verify']
    info={}
    for key,p in [('standalone',base),('installer',setup)]:
        icon=branding(p)
        require(icon['firstGroup']['matching']==[16,24,32,48,64,128,256],'Book icon frames incomplete')
        with pefile.PE(str(p)) as pe:
            props={k.decode():v.decode('utf-8') for group in pe.FileInfo for entry in group if entry.Key==b'StringFileInfo' for table in entry.StringTable for k,v in table.entries.items()}
            require(props.get('ProductName')=='Paperwork PDF Studio' and props.get('ProductVersion')==props.get('FileVersion')==ver,'PE branding/version mismatch')
            if key=='standalone': require(pe.FILE_HEADER.Machine==machine,'Wrong application architecture')
            info[key]={'bytes':p.stat().st_size,'sha256':sha(p),'machine':hex(pe.FILE_HEADER.Machine),'iconSizes':icon['firstGroup']['matching'],'version':ver,'certificateTable':bool(pe.OPTIONAL_HEADER.DATA_DIRECTORY[4].Size)}
    listing=subprocess.run([seven,'l','-slt','-ba','-sccUTF-8',str(setup)],capture_output=True,check=True).stdout.decode('utf8')
    paths=[s[7:] for s in listing.splitlines() if s.startswith('Path = ')]
    def member(name):
        matches=[p for p in paths if p.replace('\\','/').split('/')[-1]==name]
        require(len(matches)==1,f'Expected exactly one installer member: {name} (found {matches})')
        return subprocess.run([seven,'x','-so',str(setup),matches[0]],capture_output=True,check=True).stdout
    installed=member(base.name); raw=base.read_bytes(); marker=b'__TAURI_BUNDLE_TYPE_VAR_UNK'
    require(raw.count(marker)==1 and installed==raw.replace(marker,b'__TAURI_BUNDLE_TYPE_VAR_NSS',1),'Installer app differs outside Tauri bundle marker')
    h=member(helper.name);require(h==helper.read_bytes(),'Installer MCP helper differs from target build')
    with pefile.PE(data=h) as pe:
        imports=sorted({entry.dll.decode('ascii').lower() for entry in pe.DIRECTORY_ENTRY_IMPORT})
        require(pe.FILE_HEADER.Machine==machine and all(x.startswith('api-ms-win-') or x in {'kernel32.dll','ntdll.dll','bcryptprimitives.dll','bcrypt.dll','ktmw32.dll','advapi32.dll'} for x in imports),'MCP helper machine or dependencies unexpected')
    info['installedApplicationSha256']=hashlib.sha256(installed).hexdigest();info['mcpHelper']={'sha256':hashlib.sha256(h).hexdigest(),'machine':hex(machine),'systemImports':imports}
    return info

def stage(ver):
    seven=shutil.which('7z') or os.environ.get('SEVENZIP');require(seven and Path(seven).is_file(),'Set SEVENZIP to the local 7-Zip executable')
    NOTES.mkdir(exist_ok=True); rc=Path(tempfile.mkdtemp(prefix='rc-'+ver+'-',dir=NOTES)); payload=rc/'payload';payload.mkdir(); print('Staging:',rc,flush=True)
    start=inputs(); dump(rc/'inputs.json',start); dump(rc/'previous.json',released())
    target=ROOT/'src-tauri/target';env=dict(os.environ,CARGO_TARGET_DIR=str(target),CARGO_NET_OFFLINE='true');env.setdefault('CARGO_BUILD_JOBS','7')
    for k in ['TAURI_CONFIG','NODE_PATH','WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS']:env.pop(k,None)
    results={}
    for arch,triple,machine in TARGETS:
        log=rc/(arch+'.log');cmd=['powershell.exe','-NoProfile','-File',str(ROOT/'scripts'/f'with-{arch}-env.ps1'),'npm.cmd','run','build:'+arch]
        with log.open('wb') as f: code=subprocess.run(cmd,cwd=ROOT,env=env,stdout=f,stderr=subprocess.STDOUT).returncode
        require(code==0, f'{arch} build failed ({code}): '+log.read_text('utf8',errors='replace')[-3000:]);require(inputs()==start,'Source changed during build; stage again before publication')
        base=target/triple/'release';app=base/'paperwork-studio.exe';setup=base/'bundle/nsis'/f'Paperwork PDF Studio_{ver}_{arch}-setup.exe'
        results[arch]=verify_pair(app,setup,target/'mcp-client-config'/triple/'release/paperwork-mcp-client-config.exe',machine,ver,seven)
        for p,suffix in [(app,''),(setup,'-setup')]:shutil.copyfile(p,payload/f'Paperwork-{ver}-windows-{arch}{suffix}.exe')
        print(f'{arch}: checked version, icon, app, installer payload and registration helper.',flush=True)
    sums={f.name:sha(f) for f in sorted(payload.glob('*.exe'))};require(len(sums)==4,'Expected four executables')
    (payload/'SHA256SUMS.txt').write_bytes(''.join(f'{h}  {k}\n' for k,h in sums.items()).encode('ascii'))
    dump(payload/'release.json',{'version':ver,'architectures':results,'frozenInputs':len(start),'inputsSha256':sha(rc/'inputs.json')}); dump(rc/'payload-hashes.json',{p.name:sha(p) for p in payload.iterdir()});print(rc.name,flush=True)

def publish(ver, candidate):
    rc=(NOTES/candidate).resolve(); require(rc.parent==NOTES.resolve() and rc.name.startswith(f'rc-{ver}-'),'Not a candidate directory')
    require(inputs()==json.loads((rc/'inputs.json').read_bytes()),'Frozen source no longer matches the candidate')
    require(released()==json.loads((rc/'previous.json').read_bytes()),'Previous editions changed')
    payload=rc/'payload';checks=json.loads((rc/'payload-hashes.json').read_bytes());require({p.name:sha(p) for p in payload.iterdir()}==checks,'Staged release changed')
    for leaf in ['README.md','使用说明.md']:
        require((ROOT/'docs/verification'/ver/leaf).is_file(),f'Missing release documentation: {leaf}')
    shutil.copyfile(ROOT/'docs/verification'/ver/'使用说明.md',payload/'使用说明.md')
    require(not (RELEASES/ver).exists(),'Destination is not new')
    os.rename(payload,RELEASES/ver) # Same-volume, create-only on Windows. No partially populated release folder.
    print('Published locally:',RELEASES/ver,flush=True)

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('action',choices=['stage','publish']);parser.add_argument('candidate',nargs='?');args=parser.parse_args();ver=version()
    require(os.name=='nt' and not (RELEASES/ver).exists(),'Windows and a new version directory required')
    if args.action=='stage': require(not args.candidate,'Stage allocates its own directory');stage(ver)
    else: require(args.candidate,'Pass the reviewed candidate name');publish(ver,args.candidate)
