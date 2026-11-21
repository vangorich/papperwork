"""W02: real Windows virtual-jobs -> workspace picker -> selective disk acknowledgment.

Use a fresh build-native-qa label, with the private watcher guard in the binary.
No printer, user spool, debugger, UI key injection, MCP adapter, or mock bridge.
--fixture-only creates and reads the two synthetic jobs without starting the GUI.
"""
import argparse
import base64
from contextlib import ExitStack
import hashlib
import json
import mmap
from pathlib import Path
import runpy
import subprocess
import sys
import tempfile
import uuid

ROOT = Path(__file__).resolve().parents[1]
QA = runpy.run_path(str(ROOT / 'scripts/verify-native-mcp-025.py'))
check, passed = QA['check'], QA['passed']
STAMPS = ('1700000000025', '1700000000026')  # The native picker displays the millisecond prefix, not the UUID.


def seed(directory):
    directory.mkdir(exist_ok=False)
    paths = [directory / f'{stamp}-{uuid.uuid4()}.pdf' for stamp in STAMPS]
    # Valid native queued IDs; the earlier file has ONE page, the later file TWO.
    # Reload and count both, so picker/ack assertions are not inferred from the generators.
    counts = QA['node']('''import {createRequire} from 'node:module'; import {readFileSync,writeFileSync} from 'node:fs';
      const {PDFDocument} = createRequire(import.meta.url)('pdf-lib'), results = [];
      for (const [i, file] of process.argv.slice(1).entries()) {
        const doc = await PDFDocument.create();
        for (let n=0; n<=i; n++) doc.addPage([240+20*i,220]).drawText(`QA JOB ${i+1} / PAGE ${n+1}`, {x:12,y:130,size:15});
        writeFileSync(file,await doc.save(),{flag:'wx'});
        results.push((await PDFDocument.load(readFileSync(file))).getPageCount());
      }
      console.log(JSON.stringify(results));''', *paths)
    check(json.loads(counts) == [1, 2], 'Generated jobs did not reopen with 1 and 2 pages')
    return paths


def sha(path):
    return hashlib.sha256(path.read_bytes()).digest()


def driver(exe, pid, window, action):
    def quote(p):
        return "'" + str(p).replace("'", "''") + "'"
    helper = quote(ROOT / 'scripts/native-inbox-uia-025.ps1')
    ps = (f'try {{ & ([ScriptBlock]::Create([IO.File]::ReadAllText({helper},[Text.Encoding]::UTF8))) '
          f'-AppId {pid} -WindowHandle {window} -Exe {quote(exe)} -Action {quote(action)} '
          '} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }')
    rc = subprocess.run(['powershell.exe','-NoLogo','-NoProfile','-NonInteractive','-STA','-EncodedCommand',
                         base64.b64encode(ps.encode('utf-16-le')).decode('ascii')], timeout=32).returncode
    check(rc == 0, f'UIA step {action} exited {rc}')


def acceptance(exe, env, box, spool):
    first, second = seed(spool)
    original = {p: sha(p) for p in (first, second)}
    def pending(*want):
        return set(spool.iterdir()) == set(want) and all(sha(p) == original[p] for p in want)
    check(pending(first, second), 'Did not seed exactly two fresh jobs')
    # The shared GUI launcher accepts a startup path. An empty directory is not a
    # supported document: neither job is passed on the command line or imported directly.
    empty = box / 'empty'; empty.mkdir()
    with QA['gui'](exe, empty, env) as (pid, window):
        def ui(action):
            driver(exe, pid, window, action)
        ui('cancel-first')
        ui('see-second')  # Must appear without pressing reopen; otherwise job 1 hides job 2.
        check(pending(first, second), 'Cancelling/peeking removed or changed a queued PDF')
        passed('cancelled first (1 page); second (2 pages) appeared automatically; both files unchanged')
        ui('add-second')
        QA['wait'](lambda: pending(first), 'only job 2 acknowledged, first still byte-identical')
        passed('second joined new 打印任务 1 (2 pages); only its own spool file was deleted')
        ui('reopen')
        check(pending(first), 'Reopening the postponed first job acknowledged it prematurely')
        ui('add-first')
        QA['wait'](lambda: pending(), 'first job acknowledged only after joining an existing workspace')
        ui('verify')  # Selected tab, 3 pages, no 打印任务 2, manual reopen empty.
        passed('manual reopen offered 打印任务 2; selected existing 打印任务 1 instead; 3 pages, queue empty')


def guard(exe):
    # Older builds can poll the live legacy printer port even with a QA ID. Check
    # for the actual early-return diagnostic, not a guessed environment override.
    marker = b'Paperwork: external print watcher disabled for alternate app ID'
    with exe.open('rb') as f, mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ) as image:
        check(image.find(marker) >= 0, 'Missing alternate-ID print-watcher guard; refusing to launch')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('label', nargs='?'); parser.add_argument('--fixture-only', action='store_true')
    args = parser.parse_args()
    if bool(args.label) == args.fixture_only:
        parser.error('supply one QA label or --fixture-only')
    with ExitStack() as own:
        box = Path(tempfile.mkdtemp(prefix='paperwork-inbox-025-', dir=QA['BASE']['TEMP']))
        own.callback(QA['remove_ours'], box)
        if args.fixture_only:
            seed(box / 'virtual-jobs'); passed('synthetic queued PDFs reopened with 1 and 2 pages; native path NOT exercised'); return
        exe = QA['BASE']['qa_executable'](args.label)
        guard(exe)
        with QA['isolated_env'](exe, box) as env:
            ident = json.loads((exe.parent / 'qa-config.json').read_text('utf8'))['identifier']
            print(f'QA label {args.label}, isolated identifier {ident}', flush=True)
            acceptance(exe, env, box, Path(env['APPDATA']) / ident / 'virtual-jobs')
    passed('isolated GUI and newly created QA profiles cleaned up')


if __name__ == '__main__':
    # Redirected receipts must remain UTF-8 on a Chinese Windows desktop.
    sys.stdout.reconfigure(encoding='utf-8'); sys.stderr.reconfigure(encoding='utf-8')
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as e:
        sys.exit(f'FAIL: {e}')
