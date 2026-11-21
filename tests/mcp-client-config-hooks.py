"""Execute only a synthetic NSIS shell using the real installer hooks. Never run a product setup.
Windows: python -I tests/mcp-client-config-hooks.py [--codex C:\\...\\codex.exe]
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import tomllib

ROOT = Path(__file__).resolve().parents[1]
HOOK = ROOT / 'src-tauri/nsis/mcp-client-config.nsh'
KEY = 'paperwork-pdf'

# PROFILE and LOCAL are compile-time literals inside a new scratch directory. No registry,
# shell folders, shortcuts, file associations, app binary execution or product uninstaller.
SHELL = r'''
Unicode true
RequestExecutionLevel user
SilentInstall silent
SilentUnInstall silent
AutoCloseWindow true
Name "Isolated Paperwork registration test"
OutFile "${SCRATCH}\hook-shell.exe"
!include LogicLib.nsh
!include FileFunc.nsh
LoadLanguageFile "${NSISDIR}\Contrib\Language files\English.nlf"
LoadLanguageFile "${NSISDIR}\Contrib\Language files\SimpChinese.nlf"
!define PW_MCP_PROFILE "${SCRATCH}\profile"
!define PW_MCP_LOCAL "${SCRATCH}\local"
!define MAINBINARYNAME "stand-in"
!define INSTALLMODE "currentUser"
!define ARCH "x64"
Var PassiveMode
Var UpdateMode
!include "${HOOK}"
Section
  StrCpy $PassiveMode 1
  StrCpy $INSTDIR "${SCRATCH}\old dir"
  ${GetOptions} "$CMDLINE" "/MOVED=" $0
  ${If} $0 == "1"
    StrCpy $INSTDIR "${SCRATCH}\升级 path"
  ${EndIf}
  ClearErrors
  ${GetOptions} "$CMDLINE" "/UPGRADE" $UpdateMode
  ${IfNot} ${Errors}
    StrCpy $UpdateMode 1
  ${EndIf}
  WriteUninstaller "$INSTDIR\hook-uninstall.exe"
  !insertmacro NSIS_HOOK_POSTINSTALL
SectionEnd
Section Uninstall
  StrCmp $INSTDIR "${SCRATCH}\old dir" safe
  StrCmp $INSTDIR "${SCRATCH}\升级 path" safe
  SetErrorLevel 23
  Quit
  safe:
  ClearErrors
  ${GetOptions} "$CMDLINE" "/UPGRADE" $UpdateMode
  ${IfNot} ${Errors}
    StrCpy $UpdateMode 1
  ${EndIf}
  !insertmacro NSIS_HOOK_POSTUNINSTALL
SectionEnd
'''


def check_codex(codex, config, exe, *, missing=False):
    # Config-only subcommands. Do not invoke a server, open a listener, inherit any auth
    # or run in a project whose user .codex directory could override this fixture.
    profile = config.parent.parent
    env = {k: os.environ[k] for k in ('SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATH', 'PATHEXT') if k in os.environ}
    env.update(HOME=str(profile), USERPROFILE=str(profile), CODEX_HOME=str(config.parent),
               APPDATA=str(profile), LOCALAPPDATA=str(profile.parent / 'local'), TEMP=str(profile), TMP=str(profile),
               XDG_CONFIG_HOME=str(profile), XDG_CACHE_HOME=str(profile), XDG_STATE_HOME=str(profile),
               HOMEDRIVE=profile.drive, HOMEPATH=str(profile)[len(profile.drive):],
               NO_COLOR='1', DO_NOT_TRACK='1')
    result = subprocess.run([codex, 'mcp', 'list', '--json'], cwd=profile, env=env, capture_output=True,
                            check=True, timeout=20)
    servers = {s['name']: s for s in json.loads(result.stdout)}
    assert 'fixture-only' in servers and not servers.keys() - {'fixture-only', KEY}, servers.keys()
    if missing:
        assert KEY not in servers
    else:
        transport = servers[KEY]['transport']
        assert transport['type'] == 'stdio' and transport['command'] == str(exe) and transport['args'] == ['--pdf-mcp']
        assert 'PAPERWORK_MCP_REGISTRATION' in transport['env']


def verify(codex=None):
    if codex is not None:
        codex = Path(codex).resolve(strict=True)
    compiler = os.environ.get('PAPERWORK_TEST_MAKENSIS') or shutil.which('makensis') or Path(os.environ['LOCALAPPDATA']) / 'tauri/NSIS/makensis.exe'
    with tempfile.TemporaryDirectory(prefix='paperwork-hook-test-') as tmp:
        root = Path(tmp)
        home, local = root / 'profile', root / 'local'
        old, new = root / 'old dir', root / '升级 path'
        for d in (home, local, old, new, home / '.codex', home / '.gemini'):
            d.mkdir()
        claude, config, gemini = home / '.claude.json', home / '.codex/config.toml', home / '.gemini/settings.json'
        claude.write_bytes(b'{"mcpServers":{"other":{}}}\n')
        config.write_bytes(b'# unrelated\r\n[mcp_servers.fixture-only]\r\ncommand="synthetic-not-a-program"\r\nargs=[]\r\n')
        gemini.write_bytes(b'{"mcpServers":{"paperwork-pdf":{"command":"user collision"}}}\n')
        originals = [p.read_bytes() for p in (claude, config, gemini)]
        for d in (old, new):
            (d / 'stand-in.exe').write_bytes(b'Not an executable. Do not launch.')
        script = root / 'hook-shell.nsi'
        script.write_text(SHELL, encoding='utf-8-sig')
        build_env = dict(os.environ, CARGO_NET_OFFLINE='true')
        subprocess.run(['powershell.exe', '-NoProfile', '-File', ROOT / 'scripts/with-x64-env.ps1', compiler,
                        '/V2', f'/DSCRATCH={root}', f'/DHOOK={HOOK}', script], check=True, cwd=ROOT, env=build_env)
        shell = root / 'hook-shell.exe'

        def run(*flags):
            subprocess.run([shell, '/S', *flags], cwd=root, check=True, timeout=30)

        def remove(d, *flags):
            # _?= is NSIS's raw, unquoted trailing argument (it may contain spaces).
            subprocess.run(subprocess.list2cmdline([str(d / 'hook-uninstall.exe'), '/S', *flags]) + ' _?=' + str(d),
                           cwd=root, check=True, timeout=30)

        def snapshot():
            return [p.read_bytes() for p in (claude, config, gemini)]

        for flags in ((), ('/REGISTERPDFMCP=0',), ('/NOTE=C:/path/REGISTERPDFMCP=1',)):
            run(*flags)  # Only an explicit opt-in may create the first entry or receipt.
            assert snapshot() == originals and not list(local.iterdir())
        run('/REGISTERPDFMCP=1')
        first = snapshot()
        assert first[:2] != originals[:2] and first[2] == originals[2]
        assert json.loads(first[0])['mcpServers'][KEY]['command'] == str(old / 'stand-in.exe')
        assert tomllib.loads(first[1].decode())['mcp_servers'][KEY]['args'] == ['--pdf-mcp']
        if codex:
            check_codex(codex, config, old / 'stand-in.exe')
        run('/REGISTERPDFMCP=1')
        assert snapshot() == first
        remove(old, '/UPGRADE=1')
        assert snapshot() == first
        run('/MOVED=1', '/UPGRADE=1')
        moved = snapshot()
        assert json.loads(moved[0])['mcpServers'][KEY]['command'] == str(new / 'stand-in.exe')
        assert tomllib.loads(moved[1].decode())['mcp_servers'][KEY]['command'] == str(new / 'stand-in.exe')
        assert moved[2] == originals[2]
        if codex:
            check_codex(codex, config, new / 'stand-in.exe')
        remove(old)
        assert snapshot() == moved
        remove(new)
        assert snapshot() == originals and not list(local.rglob('*.json'))
        if codex:
            check_codex(codex, config, new / 'stand-in.exe', missing=True)
        print('PASS: actual hooks in TEMP: silent consent, create, repeat, upgrade, collision, stale and current uninstall')
        if codex:
            print('PASS: installed Codex mcp list --json reads stdio command + args before/after path upgrade and removal')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--codex', help='absolute path to the installed native Codex CLI')
    verify(**vars(parser.parse_args()))
