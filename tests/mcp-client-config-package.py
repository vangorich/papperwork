"""Compile and inspect a scratch Tauri NSIS bundle. Never run setup or the extracted files.
Usage (Windows): python -I tests/mcp-client-config-package.py x64|arm64 [prebuilt-GUI.exe]
"""
import os
from pathlib import Path
import platform
import re
import shutil
import struct
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
ARCHES = {'x64': ('x86_64-pc-windows-msvc', 0x8664), 'arm64': ('aarch64-pc-windows-msvc', 0xaa64)}


def verify(arch, gui=None):
    triple, machine = ARCHES[arch]
    target = ROOT / 'src-tauri' / 'target'
    source = Path(gui) if gui else target / triple / 'release' / 'paperwork-studio.exe'
    helper_name = 'paperwork-mcp-client-config.exe'
    wrapper = ['powershell.exe', '-NoProfile', '-File', ROOT / 'scripts' / f'with-{arch}-env.ps1']
    if platform.machine().casefold() in ('arm64', 'aarch64'):
        wrapper = []  # Native ARM64 CI has its normal MSVC environment.
    with tempfile.TemporaryDirectory(prefix='paperwork-nsis-test-') as tmp:
        scratch = Path(tmp)
        release = scratch / triple / 'release'
        release.mkdir(parents=True)
        shutil.copyfile(source, release / 'paperwork-studio.exe')
        env = dict(os.environ, CARGO_TARGET_DIR=str(scratch), CARGO_NET_OFFLINE='true', CI='true')
        build = subprocess.run([*wrapper, 'node', ROOT / 'node_modules/@tauri-apps/cli/tauri.js', 'bundle',
                                '--ci', '--no-sign', '--no-binary-patching', '--bundles', 'nsis', '--target', triple],
                               cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        if build.returncode:
            raise RuntimeError(build.stdout.decode('utf-8', errors='replace')[-6000:])
        (bundle,) = (release / 'bundle/nsis').glob('*-setup.exe')
        extracted = scratch / 'unpacked'
        extracted.mkdir()
        # The standalone 7za shipped by electron-builder lacks the NSIS reader.
        seven = os.environ.get('PAPERWORK_TEST_7Z') or shutil.which('7z') or Path(os.environ['ProgramFiles']) / '7-Zip/7z.exe'
        subprocess.run([seven, 'x', bundle,
                        '-o' + str(extracted), '-ir!' + helper_name], cwd=ROOT, check=True, stdout=subprocess.DEVNULL)
        (member,) = extracted.rglob(helper_name)
        compiled = target / 'mcp-client-config' / triple / 'release' / helper_name
        payload = member.read_bytes()
        assert payload == compiled.read_bytes(), 'packaged helper differs from compiled helper'
        offset = struct.unpack_from('<I', payload, 0x3c)[0]
        assert payload[offset:offset + 4] == b'PE\0\0' and struct.unpack_from('<H', payload, offset + 4)[0] == machine
        # Inspect the trusted build output (not an executable from the extracted archive).
        imports = subprocess.check_output([*wrapper, 'dumpbin.exe', '/nologo', '/dependents', compiled], cwd=ROOT)
        dlls = {s.decode('ascii').lower() for s in re.findall(rb'(?im)^\s*([a-z0-9_.-]+\.dll)\s*$', imports)}
        system = {'kernel32.dll', 'ktmw32.dll', 'ntdll.dll', 'bcryptprimitives.dll'}
        assert 'ktmw32.dll' in dlls and all(s in system or s.startswith('api-ms-win-') for s in dlls), dlls
        print(f'{arch}: embedded {len(payload)} bytes, PE {machine:04X}; imports: {", ".join(sorted(dlls))}')


if __name__ == '__main__':
    verify(*sys.argv[1:])
