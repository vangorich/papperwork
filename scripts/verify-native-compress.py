"""Save a compressed synthetic PDF via Windows Save As and reopen that exact copy."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
TEMP = Path(os.environ['TEMP']).resolve()


def qa_executable(label):
    if not re.fullmatch(r'[A-Za-z0-9_-]+', label):
        raise ValueError('Invalid QA label')
    marker = json.loads((ROOT / '.work-notes' / f'025-qa-{label}.json').read_text('utf8'))
    folder = Path(marker['folder']).resolve(strict=True)
    exe = Path(marker['exe']).resolve(strict=True)
    prefix = 'paperwork-native-qa-'
    expected_id = 'studio.paperwork.qa' + folder.name.removeprefix(prefix).replace('_', 'x')
    if (folder.parent != TEMP or not folder.name.startswith(prefix) or
            exe != folder / 'Paperwork-QA.exe' or marker['identifier'] != expected_id):
        raise ValueError('Expected an isolated build-native-qa executable and identifier')
    return exe


def drive(exe, document, target, kind):
    def quote(value):
        return "'" + str(value).replace("'", "''") + "'"

    # Separate profiles and process handles: reopening cannot reuse the original tab.
    with tempfile.TemporaryDirectory(dir=target.parent, prefix='webview-', ignore_cleanup_errors=True) as profile:
        app = subprocess.Popen([str(exe), str(document)], cwd=ROOT,
                               env={**os.environ, 'WEBVIEW2_USER_DATA_FOLDER': profile})
        try:
            print(f'Isolated QA {kind} PID {app.pid}', flush=True)
            script = quote(ROOT / 'scripts' / 'native-compress-uia.ps1')
            ps = (f'try {{ & ([ScriptBlock]::Create([IO.File]::ReadAllText({script},[Text.Encoding]::UTF8))) '
                  f'-AppId {app.pid} -OutputPath {quote(target)} -Kind {kind} '
                  '} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }')
            encoded = base64.b64encode(ps.encode('utf-16-le')).decode('ascii')
            subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encoded],
                           cwd=ROOT, check=True, timeout=155)
            return app.pid
        finally:
            if app.poll() is None:
                app.terminate()  # only the process handle we created
                app.wait(timeout=12)


def read_copy(target):
    # Use the project's installed PDF.js reader. An /Outlines key alone is not a working bookmark.
    js = """
        import { readFileSync } from 'node:fs';
        import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
        const doc = await getDocument({data: new Uint8Array(readFileSync(process.argv[1])), isEvalSupported: false, verbosity: 0}).promise;
        try {
            const text = await (await doc.getPage(1)).getTextContent();
            const [mark] = await doc.getOutline() || [];
            const dest = typeof mark?.dest === 'string' ? await doc.getDestination(mark.dest) : mark?.dest;
            const page = !dest ? null : 1 + (Number.isInteger(dest[0]) ? dest[0] : await doc.getPageIndex(dest[0]));
            console.log(JSON.stringify({pages: doc.numPages, text: text.items.map(x => x.str).join(' ').trim(), bookmarkTitle: mark?.title, bookmarkPage: page}));
        } finally { await doc.destroy(); }
    """
    receipt = json.loads(subprocess.check_output(['node', '--input-type=module', '-e', js, str(target)], cwd=ROOT, timeout=20))
    if receipt != dict(pages=1, text='SEARCHABLE NATIVE PROOF', bookmarkTitle='Proof', bookmarkPage=1):
        raise RuntimeError(f'Saved copy lost page, text or bookmark: {receipt}')
    return receipt


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main(label):
    exe = qa_executable(label)
    box = Path(tempfile.mkdtemp(prefix='paperwork-compress-proof-', dir=TEMP))
    source, target = box / 'QA-proof.pdf', box / 'fresh-copy.pdf'
    subprocess.run(['node', str(ROOT / 'scripts/make-compression-proof.cjs'), str(source)], cwd=ROOT, check=True)
    initial, before = source.stat().st_size, sha256(source)
    save_pid = drive(exe, source, target, 'compress')
    written = target.stat().st_size
    if not 0 < written < initial:
        raise RuntimeError('No smaller copy at the explicitly chosen path')
    saved_hash = sha256(target)
    reopen_pid = drive(exe, target, target, 'reopen')
    contents = read_copy(target)
    after = sha256(source)
    if before != after or saved_hash != sha256(target):
        raise RuntimeError('Original or saved bytes changed during the proof')
    print(json.dumps(dict(native=True, savePid=save_pid, reopenPid=reopen_pid, source=str(source), target=str(target),
                          initial=initial, written=written, originalUnchanged=True, sourceSha256Before=before,
                          sourceSha256After=after, copySha256=saved_hash, bookmark=True, **contents)))


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit('Usage: verify-native-compress.py <QA build label>')
    main(sys.argv[1])
