"""Probe the same isolated Tauri EXE as a GUI and a newline-JSON MCP server.

Windows, Python + pywin32, project-installed Node dependencies. No build/install.
Use a fresh build-native-qa label: never reuse or clean a pre-existing app profile.
--fixture-only checks the generated input without starting either native process.
"""
import argparse
import base64
from contextlib import contextmanager, ExitStack
import ctypes
import json
import mmap
import os
from pathlib import Path
import queue
import re
import runpy
import shutil
import subprocess
import sys
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
BASE = runpy.run_path(str(ROOT / 'scripts/verify-native-compress.py'))
SOURCE, TARGET = 'QA-mcp-025.pdf', 'approved-copy.pdf'
OLD, NEW, PEER, ADDED = 'Page 12', 'Page 34', 'Page 56', 'QA note'
TOOLS = {'list_documents', 'read_page', 'search', 'edit_document', 'describe_edits', 'request_export', 'export_status'}


def check(condition, why):
    if not condition:
        raise RuntimeError(why)


def passed(message):
    print('PASS:', message, flush=True)


def node(js, *args):
    return subprocess.check_output(['node', '--input-type=module', '-e', js, *map(str, args)], cwd=ROOT, timeout=18)


def make_fixture(source):
    # Same font, positions, two independently painted runs and equal-width digits as
    # src/lib/rewritePdfText.test.ts. No guessed stream bytes, OCR or replacement overlay.
    node('''import {createRequire} from 'node:module'; import {writeFileSync} from 'node:fs';
        const {PDFDocument, StandardFonts} = createRequire(import.meta.url)('pdf-lib');
        const doc = await PDFDocument.create(), font = await doc.embedFont(StandardFonts.Helvetica);
        for (const text of process.argv.slice(2)) {
          const page = doc.addPage([300, 200]);
          page.drawText(text, {font, x:20, y:130, size:16}); page.drawText('Footer', {font, x:20, y:40, size:12});
        }
        writeFileSync(process.argv[1], await doc.save(), {flag:'wx'});''', source, OLD, PEER)
    check(disk_pages(source) == [(0, [OLD, 'Footer'], 0), (0, [PEER, 'Footer'], 0)], 'Unexpected input PDF runs, images or rotation')


def disk_pages(path):
    check(0 < path.stat().st_size < 8 * 1024 * 1024, 'Missing or oversized PDF')
    data = node('''import {readFileSync} from 'node:fs'; import {getDocument, OPS} from 'pdfjs-dist/legacy/build/pdf.mjs';
        const doc = await getDocument({data:new Uint8Array(readFileSync(process.argv[1])), isEvalSupported:false, verbosity:0}).promise;
        try {
          if (doc.numPages !== 2) throw Error('Expected two pages on disk');
          const out = []; for (const n of [1,2]) { const p = await doc.getPage(n);
            const ops = await p.getOperatorList();
            out.push([p.rotate, (await p.getTextContent()).items.map(x=>x.str).filter(Boolean),
              ops.fnArray.filter(op=>op===OPS.paintImageXObject || op===OPS.paintInlineImageXObject).length]); }
          console.log(JSON.stringify(out));
        } finally { await doc.destroy() }''', path)
    return [tuple(page) for page in json.loads(data)]


def remove_ours(path):
    # WebView2 can briefly hold its profile after its host exits. Only called for
    # directories we atomically created; never delete an existing QA/production profile.
    for i in range(50):
        try:
            shutil.rmtree(path)
            return
        except FileNotFoundError:
            return
        except OSError as e:
            if i == 49 or e.winerror not in (5, 32, 33, 145):
                raise
            time.sleep(.12)


@contextmanager
def isolated_env(exe, box):
    from win32com.shell import shell, shellcon
    meta = json.loads((exe.parent / 'qa-config.json').read_text('utf8'))
    suffix = exe.parent.name.removeprefix('paperwork-native-qa-').replace('_', 'x')
    identifier = 'studio.paperwork.qa' + suffix
    check(meta['identifier'] == identifier and re.fullmatch('[a-z0-9]+', suffix), 'Not the generated QA config')
    with exe.open('rb') as f, mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ) as image:
        check(image.find(identifier.encode('ascii')) != -1, 'QA identifier missing from the executable')
    # Tauri resolves a Windows known folder; --pdf-mcp resolves APPDATA. Merely
    # overriding APPDATA splits them. Reserve ONLY the matching isolated-ID leaves.
    roaming, local = [Path(shell.SHGetFolderPath(0, k, None, 0)) for k in (shellcon.CSIDL_APPDATA, shellcon.CSIDL_LOCAL_APPDATA)]
    with ExitStack() as own:
        for parent in dict.fromkeys((roaming, local)):
            leaf = parent / identifier
            try:
                leaf.mkdir()
            except FileExistsError:
                raise RuntimeError(f'Use a fresh QA label; refusing pre-existing profile {leaf}') from None
            own.callback(remove_ours, leaf)
        env = {k:v for k,v in os.environ.items() if not k.upper().startswith('WEBVIEW2_')}
        yield dict(env, APPDATA=str(roaming), WEBVIEW2_USER_DATA_FOLDER=str(box / 'webview'))


@contextmanager
def gui(exe, source, env):
    import win32con, win32event, win32gui, win32job, win32process
    # Assign the still-suspended process: no WebView child can escape cleanup by
    # being created before assignment. No image-name kill or desktop enumeration.
    job = win32job.CreateJobObject(None, 'Paperwork-QA-' + os.urandom(16).hex())
    settings = win32job.QueryInformationJobObject(job, win32job.JobObjectExtendedLimitInformation)
    settings['BasicLimitInformation']['LimitFlags'] |= win32job.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    win32job.SetInformationJobObject(job, win32job.JobObjectExtendedLimitInformation, settings)
    proc, thread, pid, tid = win32process.CreateProcess(str(exe), subprocess.list2cmdline([str(exe), str(source)]),
        None, None, False, win32con.CREATE_SUSPENDED, env, str(source.parent), win32process.STARTUPINFO())
    try:
        win32job.AssignProcessToJobObject(job, proc)
        win32process.ResumeThread(thread)
        print(f'Isolated QA GUI PID {pid}', flush=True)
        def own_main():
            check(win32event.WaitForSingleObject(proc, 0) == win32event.WAIT_TIMEOUT, 'QA GUI exited before opening our fixture')
            handles = []
            def visit(h, _):
                if win32gui.GetClassName(h) == 'Tauri Window' and win32gui.IsWindowVisible(h) and win32process.GetWindowThreadProcessId(h)[1] == pid:
                    handles.append(h)
                return True
            win32gui.EnumThreadWindows(tid, visit, None)
            return next(iter(handles), None)
        yield pid, wait(own_main, 'window of launched GUI', 40)
    finally:
        # Also terminate the original handle if assignment failed before ResumeThread.
        job.Close()
        if win32event.WaitForSingleObject(proc, 1200) == win32event.WAIT_TIMEOUT:
            win32process.TerminateProcess(proc, 1)
        win32event.WaitForSingleObject(proc, 4000)
        thread.Close(); proc.Close()


def wait(probe, description, seconds=12):
    end = time.monotonic() + seconds
    while True:
        value = probe()
        if value:
            return value
        if time.monotonic() >= end:
            raise TimeoutError(f'Timed out waiting for {description}')
        time.sleep(.12)


def uia(exe, pid, window, action):
    # Windows PowerShell 5.1's -File otherwise reads BOM-less UTF-8 as ANSI.
    def quoted(s):
        return "'" + str(s).replace("'", "''") + "'"
    helper = quoted(ROOT / 'scripts/native-mcp-uia-025.ps1')
    ps = (f'try {{ & ([ScriptBlock]::Create([IO.File]::ReadAllText({helper},[Text.Encoding]::UTF8))) '
          f'-AppId {pid} -WindowHandle {window} -Exe {quoted(exe)} -Action {action} '
          '} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }')
    subprocess.run(['powershell.exe','-NoLogo','-NoProfile','-NonInteractive','-STA','-EncodedCommand',
                    base64.b64encode(ps.encode('utf-16-le')).decode('ascii')], check=True, timeout=34)


def save_dialog(pid, main, target):
    import win32con as c, win32gui as g, win32process as p
    def owned(h, cls):
        return h and g.IsWindow(h) and p.GetWindowThreadProcessId(h)[1] == pid and g.GetClassName(h) == cls and g.IsWindowVisible(h)
    def popup():
        h = g.GetWindow(main, 6)  # GW_ENABLEDPOPUP: only this owner's popup (or itself)
        return h if owned(h, '#32770') and g.GetWindow(h, c.GW_OWNER) == main else None
    dlg = wait(popup, 'owned Save As dialog', 30)
    check(re.match(r'^(另存为|Save As\b)', g.GetWindowText(dlg)), 'Owned popup is not Save As')
    def filename():
        edits = []
        def visit(h, _):
            if owned(h, 'Edit') and g.GetDlgCtrlID(h) == 1001 and owned(g.GetParent(h), 'ComboBox'):
                edits.append(h)
            return True
        g.EnumChildWindows(dlg, visit, None)
        return edits[0] if len(edits) == 1 else None
    edit = wait(filename, 'filename Edit#1001'); save = g.GetDlgItem(dlg, 1)
    def control_text(h):
        buf = ctypes.create_unicode_buffer(32768)
        g.SendMessageTimeout(h, c.WM_GETTEXT, len(buf), ctypes.addressof(buf), c.SMTO_ABORTIFHUNG, 2000)
        return buf.value
    check(owned(save, 'Button') and re.sub(r'\(&.\)|&', '', control_text(save)) in ('保存','Save'), 'Not the owned Save button')
    check(re.fullmatch(r'QA-mcp-025-导出副本(?:\.pdf)?', control_text(edit)), 'Not the suggested synthetic copy')
    check(not target.exists() and g.IsWindowEnabled(edit), 'Destination is not fresh or control disabled')
    buf = ctypes.create_unicode_buffer(str(target))
    g.SendMessageTimeout(edit, c.WM_SETTEXT, 0, ctypes.addressof(buf), c.SMTO_ABORTIFHUNG, 2000)
    check(control_text(edit) == str(target) and popup() == dlg and g.GetDlgItem(dlg, 1) == save and
          g.IsWindowEnabled(save) and not target.exists(), 'QA filename readback failed; did not save')
    g.PostMessage(save, c.BM_CLICK, 0, 0)


class ToolDenied(RuntimeError):
    pass


class Stdio:
    def __init__(self, process):
        self.process, self.seq, self.lines = process, 0, queue.Queue(2)
        def read():
            limit = 1024 * 1024 + 4096
            while True:
                line = process.stdout.readline(limit + 1)
                self.lines.put(line)
                if not line or len(line) > limit:
                    return
        threading.Thread(target=read, daemon=True).start()

    def send(self, msg):
        self.process.stdin.write((json.dumps(dict(jsonrpc='2.0', **msg), separators=(',', ':')) + '\n').encode('utf8'))
        self.process.stdin.flush()

    def rpc(self, method, **params):
        self.seq += 1
        self.send(dict(id=self.seq, method=method, params=params))
        name = params.get('name', method)
        try:
            line = self.lines.get(timeout=22)
        except queue.Empty:
            raise TimeoutError(f'No stdio response to {name}; no edit will be retried') from None
        check(line.endswith(b'\n') and len(line) <= 1024*1024+4096, f'EOF/oversize/unterminated reply to {name}')
        reply = json.loads(line.decode('utf8'))
        check(reply.get('jsonrpc') == '2.0' and reply.get('id') == self.seq and 'error' not in reply,
              f'Invalid JSON-RPC response to {name}: {str(reply)[:350]}')
        return reply['result']

    def call(self, name, **args):
        result = self.rpc('tools/call', name=name, arguments=args)
        item, = result['content']
        check(item['type'] == 'text', f'Invalid MCP content for {name}')
        if result.get('isError') is True:
            raise ToolDenied(f'{name}: {item["text"]}')
        return json.loads(item['text'])

    def denied(self, reason, name, **args):
        try:
            self.call(name, **args)
        except ToolDenied as e:
            check(re.search(reason, str(e)), f'Unexpected denial: {e}')
            return
        raise RuntimeError(f'{name} succeeded but should have been denied')


@contextmanager
def stdio(exe, env, cwd):
    proc = subprocess.Popen([str(exe), '--pdf-mcp'], env=env, cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW)
    try:
        print(f'Isolated QA stdio PID {proc.pid}', flush=True)
        yield Stdio(proc)
        proc.stdin.close()
        check(proc.wait(timeout=4) == 0, 'Stdio adapter did not exit cleanly on EOF')
    finally:
        if proc.poll() is None:
            proc.kill(); proc.wait(timeout=4)
        proc.stdin.close(); proc.stdout.close()


def acceptance(m, ui, source, target, save, cancel_only):
    digest = BASE['sha256'](source)
    def unchanged(copied=False):
        check(BASE['sha256'](source) == digest, 'Original bytes changed on disk')
        check(set(source.parent.iterdir()) == ({source, target} if copied else {source}), 'Unexpected files in the private documents directory')
    def documents():
        return m.call('list_documents')['documents']
    def grant(access):
        d, = documents()
        check(d['name'] == source.name and d['access'] == access and d['pageCount'] == 2 and d['revision'], 'Unexpected grant')
        return d['documentId']
    def page(n, text, absent=None):
        p = m.call('read_page', documentId=doc, page=n)
        check(p['page'] == n and p['documentId'] == doc and p['revision'] and p['citation'] == f'{source.name} · 第 {n} 页', 'Incorrect document/page citation')
        check(text in p['text'] and (not absent or absent not in p['text']), f'Unexpected cited page {n}: {p["text"][:400]}')
        return p
    def edit(before, **op):
        r = m.call('edit_document', documentId=doc, revision=before['revision'], operation=op)
        check(r['documentId'] == doc and r['applied'] is True and r['storedOnDisk'] is False and r['revision'] != before['revision'], f'Invalid edit receipt for {op["kind"]}')
        unchanged()
        return r['revision']
    def export():
        req = m.call('request_export', documentId=doc, format='pdf', pages=[1,2])
        check(req['state'] == 'pending' and req['requiresUserConfirmation'] is True and req['requestId'], 'Export did not require human confirmation')
        rid = req['requestId']
        check(status(rid) == 'pending', 'Export not pending before UI choice')
        unchanged()
        return rid
    def status(rid):
        r = m.call('export_status', documentId=doc, requestId=rid)
        check(r['requestId'] == rid and set(r) <= {'requestId','state','error'}, 'Invalid export status or leaked destination')
        check(r['state'] != 'failed', f'Export failed: {r.get("error")}')
        return r['state']

    hello = m.rpc('initialize', protocolVersion='2025-06-18', capabilities={}, clientInfo={'name':'qa-025','version':'1'})
    check(hello['protocolVersion'] == '2025-06-18' and 'tools' in hello['capabilities'] and hello['serverInfo']['name'] == 'paperwork-pdf', 'MCP handshake failed')
    m.send({'method':'notifications/initialized'})
    tools = m.rpc('tools/list')['tools']
    check(len(tools) == len(TOOLS) and {t['name'] for t in tools} == TOOLS, 'Unexpected MCP tool surface')
    check(documents() == [], 'Fresh fixture was implicitly shared')
    passed('initialized, seven expected tools, open PDF has no grant')

    ui('read'); doc = grant('read'); first_id = doc
    p1 = page(1, OLD, PEER); p2 = page(2, PEER, OLD)
    match, = m.call('search', documentId=doc, query=PEER)['matches']
    check(match['page'] == 2 and PEER in match['excerpt'], 'Search returned the wrong page')
    add = dict(kind='add_object', objectType='text', page=2, text=ADDED, fontSize=10, box=dict(x=.48,y=.53,width=.4,height=.12))
    m.denied('只授权了阅读|只读|read.only', 'edit_document', documentId=doc, revision=p2['revision'], operation=add)
    check(page(2, PEER, ADDED)['revision'] == p2['revision'] and not p2['objects'], 'Read-only denial mutated document')
    passed('read-only grant, two page citations, search, edit denied and revision unchanged')

    ui('edit'); doc = grant('edit')
    check(first_id != doc, 'Old grant survived reauthorization')
    m.denied('未授权|撤销|revok', 'read_page', documentId=first_id, page=1)
    old = page(2, PEER); edit(old, **add)
    stale_op = dict(kind='rotate_page', page=2, degrees=90)
    m.denied('版本|revision', 'edit_document', documentId=doc, revision=old['revision'], operation=stale_op)
    marked = page(2, ADDED)
    obj, = marked['objects']; check(obj['type'] == 'text' and 'text' not in obj and obj['id'], 'Object metadata must not repeat page text')
    edit(marked, **stale_op)
    rotated = page(2, PEER); turned, = rotated['objects']
    check(turned['id'] == obj['id'] and turned['box'] != obj['box'], 'Page rotation did not move its text object')
    edit(rotated, kind='reorder_pages', order=[2,1])
    check(page(1, PEER, OLD)['objects'][0]['id'] == obj['id'], 'Reordered page lost its edit')
    before = page(2, OLD, PEER)
    rev = edit(before, kind='replace_native_text', page=2, find=OLD, replacement=NEW)
    replaced = page(2, NEW, OLD)
    check(replaced['revision'] == rev and not replaced['objects'], 'New text appeared as an overlay, not a native replacement')
    passed('revision-checked add/rotate/reorder/native replacement; stale edit denied; original unchanged')

    rid = export(); ui('reject')
    wait(lambda: status(rid) == 'cancelled', 'cancelled export'); unchanged()
    passed('human rejected pending export: cancelled, no new file or original write')
    # Exercise UI undo even if the machine cannot automate a native Save As dialog.
    ui('undo'); restored = page(2, OLD, NEW)
    check(restored['revision'] != rev and page(1, PEER)['objects'][0]['id'] == obj['id'], 'UI undo did not restore just the native edit')
    passed('UI undo restored original printed run and retained earlier edits')

    if not cancel_only:
        edit(restored, kind='replace_native_text', page=2, find=OLD, replacement=NEW)
        rid = export(); ui('approve'); save()
        wait(lambda: status(rid) == 'saved', 'saved export'); unchanged(copied=True)
        (r1, t1, images1), (r2, t2, images2) = disk_pages(target)
        check(r1 == 90 and r2 == 0 and PEER in t1 and images1 == 1 and images2 == 0 and t2 == [NEW, 'Footer'] and OLD not in t1,
              f'Saved copy is missing its text snapshot or reordered/native content: {[(r1,t1,images1),(r2,t2,images2)]}')
        passed(f'approved copy reopened from disk: rotations {r1}/{r2}, text snapshot and {NEW!r}; source SHA-256 unchanged')
        ui('close')
    else:
        print('SKIP: approved copy / disk verification (--cancel-only)', flush=True)
    ui('revoke')
    check(documents() == [], 'Revoked document still listed')
    m.denied('未授权|撤销|revok', 'read_page', documentId=doc, page=1)
    unchanged(copied=not cancel_only)
    passed('revoked ID cannot read; fresh list empty')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('label', nargs='?', help='.work-notes/025-qa-<label>.json')
    parser.add_argument('--fixture-only', action='store_true', help='only generate and independently read the two-page fixture')
    parser.add_argument('--cancel-only', action='store_true', help='explicitly omit approved-copy proof; still test human rejection, undo and revoke')
    args = parser.parse_args()
    if args.fixture_only == bool(args.label) or args.fixture_only and args.cancel_only:
        parser.error('supply one QA label or --fixture-only')
    with ExitStack() as own:
        box = Path(tempfile.mkdtemp(prefix='paperwork-mcp-025-', dir=BASE['TEMP']))
        own.callback(remove_ours, box)
        docs = box / 'documents'; docs.mkdir()
        source, target = docs / SOURCE, docs / TARGET
        make_fixture(source)
        passed('constructed Helvetica fixture read from disk (two native runs per page)')
        if args.fixture_only:
            return
        exe = BASE['qa_executable'](args.label)
        with isolated_env(exe, box) as env, gui(exe, source, env) as (pid, window):
            def ui(action):
                uia(exe, pid, window, action)
            ui('ready')
            with stdio(exe, env, docs) as m:
                acceptance(m, ui, source, target, lambda: save_dialog(pid, window, target), args.cancel_only)


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as exc:
        sys.exit(f'FAIL: {exc}')
