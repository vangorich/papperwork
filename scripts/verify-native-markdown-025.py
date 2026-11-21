"""M01: use the private mdproof WebView2 host, File > Export Markdown and Windows Save As.
No command-line output path, mock bridge, debugger, global input or production profile.
The only retained files are synthetic evidence in a newly allocated TEMP directory.
"""
import base64
from contextlib import ExitStack
import ctypes
from io import BytesIO
import json
import os
from pathlib import Path
import re
import runpy
import subprocess
import sys
import tempfile
from urllib.parse import quote, unquote

import fitz
from PIL import Image
import win32con as c
import win32event
import win32file
import win32gui as g
import win32process

SCRIPTS = Path(__file__).resolve().parent
INBOX = runpy.run_path(str(SCRIPTS / 'verify-native-inbox-025.py'))
QA = INBOX['QA']
check, wait, passed = QA['check'], QA['wait'], QA['passed']
READER = runpy.run_path(str(SCRIPTS / 'verify-native-reader.py'))
SOURCE = 'QA-M01-palette.pdf'
TITLE, CAPTION = 'Field notes on the color proof', 'Teal at left. Amber at right.'
HIDDEN = 'UNPAINTED CONTROL WORDS'
LEFT, RIGHT = (18, 132, 138), (232, 154, 45)


def fixture(source):
    tile = Image.new('RGB', (64, 40), LEFT)
    tile.paste(RIGHT, (32, 0, 64, 40))
    png = BytesIO(); tile.save(png, 'PNG')
    with fitz.open() as pdf:
        p = pdf.new_page(width=420, height=300)
        p.insert_text((32, 42), TITLE, fontsize=20)
        p.insert_image(fitz.Rect(32, 64, 224, 184), stream=png.getvalue())
        p.insert_text((32, 221), CAPTION, fontsize=15)
        p.insert_text((32, 260), HIDDEN, fontsize=12, render_mode=3)
        with source.open('xb') as f:
            f.write(pdf.tobytes(deflate=True))
    # A text-only extractor DOES see the negative control; a rendered page does not.
    with fitz.open(source) as pdf:
        p = pdf[0]
        check(p.get_text().splitlines() == [TITLE, CAPTION, HIDDEN], 'Unexpected input text layer')
        render = p.get_pixmap().pil_image().convert('RGB')
        check(render.crop((28, 240, 385, 270)).getextrema() == ((255, 255),) * 3, 'Negative control is painted')
        check([render.getpixel(xy) for xy in [(80, 100), (175, 100)]] == [LEFT, RIGHT], 'Wrong input figure')


# Invoke UIA patterns inside the exact spawned HWND. Never use desktop/root lookups, coordinate
# clicks or foreground keystrokes. PowerShell 5.1 receives Unicode via -EncodedCommand.
UIA = r'''
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$app = Get-Process -Id ([int]$env:MDPROOF_PID)
$ae = [System.Windows.Automation.AutomationElement]
$root = $ae::FromHandle([IntPtr]([long]$env:MDPROOF_HWND))
if ($app.Path -ne $env:MDPROOF_EXE -or $app.ProcessName -ne 'Paperwork-QA' -or
    $root.Current.ProcessId -ne $app.Id -or $root.Current.ClassName -ne 'Tauri Window') { throw 'Not the private QA window' }
$scope = [System.Windows.Automation.TreeScope]::Descendants
$until = [DateTime]::UtcNow.AddSeconds(32)
function Control($name, $kind) {
    $prop = $ae::NameProperty; $value = $name
    if ($kind -eq 'CheckBox') { $prop = $ae::ControlTypeProperty; $value = [System.Windows.Automation.ControlType]::CheckBox }
    $cond = [System.Windows.Automation.PropertyCondition]::new($prop,$value)
    foreach ($el in $root.FindAll($scope,$cond)) {
        if ($el.Current.ControlType.ProgrammaticName -eq "ControlType.$kind" -and $el.Current.IsEnabled -and
            !$el.Current.IsOffscreen -and $el.Current.Name.StartsWith($name)) { return $el }
    }
}
function WaitFor($probe, $description) {
    do {
        if ($app.HasExited) { throw 'QA host exited' }
        try { $value = & $probe; if ($value) { return $value } }
        catch [System.Windows.Automation.ElementNotAvailableException] { }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $until)
    throw "QA $env:MDPROOF_STEP timed out: $description"
}
function Need($name,$kind) { WaitFor { Control $name $kind } $name }
function Press($name,$kind) {
    $el = Need $name $kind; $pattern = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)) { $pattern.Invoke(); return }
    if ($el.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern,[ref]$pattern)) { $pattern.Expand(); return }
    throw "No accessible action for $name"
}
function CheckPattern { (Need '同时导出插图' 'CheckBox').GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern) }
$close = '关闭 Markdown 导出'
if ($env:MDPROOF_STEP -eq 'after-cancel') {
    [void](Need '选择保存位置' 'Button')  # The native chooser actually returned and busy cleared.
    if ((CheckPattern).Current.ToggleState -ne 'On') { throw 'Lost image option on picker cancellation' }
    Press $close 'Button'
}
[void](WaitFor { !(Control $close 'Button') } 'Markdown dialog closed')
[void](Need "关闭 $env:MDPROOF_SOURCE" 'Button')
if ($env:MDPROOF_STEP -in @('ready','after-save','after-cancel')) { return }
if (Control '文件操作' 'Button') { Press '文件操作' 'Button' }
else { Press '更多工具' 'Button'; Press '文件操作' 'MenuItem' }
# Narrow ribbons can have an outer File group containing another File submenu.
$command = '导出 Markdown…'
do {
    if (Control $command 'MenuItem') { break }
    if (Control '文件操作' 'MenuItem') { Press '文件操作' 'MenuItem' }
    Start-Sleep -Milliseconds 100
} while ([DateTime]::UtcNow -lt $until)
Press $command 'MenuItem'
[void](Need $close 'Button')
$box = CheckPattern
if ($box.Current.ToggleState -ne 'Off') { throw 'New export did not start without images' }
if ($env:MDPROOF_STEP -in @('pictures','cancel')) {
    $box.Toggle(); [void](WaitFor { (CheckPattern).Current.ToggleState -eq 'On' } 'image checkbox on')
}
Press '选择保存位置' 'Button'
'''


def ui(exe, pid, hwnd, step):
    ps = 'try {\n' + UIA + '\n} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }'
    env = dict(os.environ, MDPROOF_EXE=str(exe), MDPROOF_PID=str(pid), MDPROOF_HWND=str(hwnd),
               MDPROOF_STEP=step, MDPROOF_SOURCE=SOURCE)
    command = base64.b64encode(ps.encode('utf-16-le')).decode('ascii')
    rc = subprocess.run(['powershell.exe', '-NoProfile', '-NoLogo', '-NonInteractive', '-STA', '-EncodedCommand', command],
                        env=env, timeout=45).returncode
    check(rc == 0, f'UIA step {step} exited {rc}')


def picker(pid, main, target, cancel=False, suggested_stem=None, *, extension='.md', wait_seconds=25):
    check(extension in ('.md','.pdf') and target.suffix.lower()==extension, 'Unexpected test destination type')
    def ours(h, klass):
        return (h and g.IsWindow(h) and g.IsWindowVisible(h) and win32process.GetWindowThreadProcessId(h)[1] == pid
                and g.GetClassName(h) == klass)

    def popup():
        h = g.GetWindow(main, 6)  # GW_ENABLEDPOPUP: only the popup of this owner, never other apps.
        return h if ours(h, '#32770') and g.GetWindow(h, c.GW_OWNER) == main else None

    def text(h):
        buf = ctypes.create_unicode_buffer(32768)
        g.SendMessageTimeout(h, c.WM_GETTEXT, len(buf), ctypes.addressof(buf), c.SMTO_ABORTIFHUNG, 2000)
        return buf.value

    dlg = wait(popup, 'owned Windows Save As', wait_seconds)
    title = text(dlg)
    specific_title = '导出 Markdown（仅创建新文件）' if extension=='.md' else '另存为新副本（不能替换已有文件）'
    check(title in ('另存为', 'Save As', specific_title), 'Unexpected owned dialog; not acting')
    def filename():
        matches = []
        def visit(h, _):
            if ours(h, 'Edit') and g.GetDlgCtrlID(h) == 1001 and ours(g.GetParent(h), 'ComboBox'):
                matches.append(h)
            return True
        g.EnumChildWindows(dlg, visit, None)
        return matches[0] if len(matches) == 1 else None

    edit = wait(filename, 'synthetic filename Edit#1001')
    check(re.fullmatch(re.escape(suggested_stem or Path(SOURCE).stem) + '(?:' + re.escape(extension) + ')?', text(edit)), 'Wrong suggested filename')
    control_id = c.IDCANCEL if cancel else c.IDOK
    button = g.GetDlgItem(dlg, control_id)
    check(ours(button, 'Button') and re.sub(r'\(&.\)|&', '', text(button)) in
          (('取消', 'Cancel') if cancel else ('保存', 'Save')), 'Not the owned Save/Cancel button')
    check(target.is_absolute() and not target.exists() and g.IsWindowEnabled(edit), 'Not a fresh destination')
    buf = ctypes.create_unicode_buffer(str(target))
    g.SendMessageTimeout(edit, c.WM_SETTEXT, 0, ctypes.addressof(buf), c.SMTO_ABORTIFHUNG, 2000)
    check(text(edit) == str(target) and popup() == dlg and g.GetDlgItem(dlg, control_id) == button
          and g.IsWindowEnabled(button) and not target.exists(), 'Filename readback failed; not acting')
    g.PostMessage(button, c.BM_CLICK, 0, 0)
    wait(lambda: not g.IsWindow(dlg) or not g.IsWindowVisible(dlg), 'native chooser dismissal')
    print(f"Owned #32770 '{title}'; Edit#1001 → {target.name}; {'Cancel' if cancel else 'Save'}", flush=True)


def tree(out):
    return {p.relative_to(out).as_posix(): (QA['BASE']['sha256'](p) if p.is_file() else None) for p in out.rglob('*')}


def verify_md(path, pictures):
    md = wait(lambda: path.is_file() and path.read_text('utf-8'), 'published UTF-8 Markdown')
    href = quote(f'{path.stem}-images/figure-001.png')
    figure = f'![第 1 页插图]({href})'
    lines = [line.removeprefix('### ') for line in md.splitlines() if line]
    check(lines == ['## 第 1 页', TITLE, *([figure] if pictures else []), CAPTION] and HIDDEN not in md,
          f'{path.name}: unexpected visible text, order or image link: {md!r}')
    if pictures:
        # Follow the actual link only AFTER checking it is the expected relative path.
        link, = re.findall(r'!\[[^\]\n]*\]\(([^)\n]+)\)', md)
        with Image.open(path.parent / unquote(link)) as im:
            check(im.format == 'PNG' and im.size == (64, 40), 'Referenced file is not the 64×40 PNG')
            px = im.convert('RGB')
            check([px.getpixel(pos) for pos in [(16, 20), (48, 20)]] == [LEFT, RIGHT], 'PNG does not match the painted figure')
        return link


def watch_output(out, stack):
    flags = c.FILE_NOTIFY_CHANGE_FILE_NAME | c.FILE_NOTIFY_CHANGE_DIR_NAME | c.FILE_NOTIFY_CHANGE_SIZE | c.FILE_NOTIFY_CHANGE_LAST_WRITE
    handle = win32file.FindFirstChangeNotification(str(out), True, flags)
    stack.callback(win32file.FindCloseChangeNotification, handle)
    return handle


def main(label='mdproof'):
    exe = QA['BASE']['qa_executable'](label)
    INBOX['guard'](exe)  # Refuse hosts compiled before the alternate-ID print-watcher early return.
    ident = json.loads((exe.parent / 'qa-config.json').read_text('utf-8'))['identifier']
    box = Path(tempfile.mkdtemp(prefix='paperwork-mdproof-', dir=QA['BASE']['TEMP']))
    out = box / 'exports'; out.mkdir()
    source = box / SOURCE; fixture(source); original = QA['BASE']['sha256'](source)
    plain, illustrated, cancelled = [out / name for name in ('text-only.md', '新色样-v2.md', 'not-saved.md')]
    ctypes.windll.user32.SetProcessDPIAware()
    print(f'mdproof: {ident}; private fixture and evidence: {box}', flush=True)
    with ExitStack() as resources:
        profile = box / 'qa-host'; profile.mkdir(); resources.callback(QA['remove_ours'], profile)
        with QA['isolated_env'](exe, profile) as env, QA['gui'](exe, source, env) as (pid, window):
            def step(name):
                ui(exe, pid, window, name)
            step('ready')
            def painted():
                check(g.IsWindow(window) and win32process.GetWindowThreadProcessId(window)[1] == pid
                      and g.GetClassName(window) == 'Tauri Window', 'Private QA reader window disappeared')
                im = READER['capture'](window)
                return im if all(READER['paint_match'](im, rgb) for rgb in (LEFT, RIGHT)) else None
            wait(painted, 'both fixture colors on the actual reader stage', 25).save(box / 'reader.png')
            step('plain'); picker(pid, window, plain); step('after-save')
            verify_md(plain, False)
            check(set(tree(out)) == {plain.name}, 'Text-only export wrote a sidecar or extra file')
            passed('text-only: two visible lines, no unpainted control, image link or sidecar')
            with ExitStack() as positive:
                watched = watch_output(out, positive)
                step('pictures'); picker(pid, window, illustrated); step('after-save')
                check(win32event.WaitForSingleObject(watched, 1000) == win32event.WAIT_OBJECT_0, 'Directory change monitor missed a real save')
            href = verify_md(illustrated, True)
            baseline = tree(out)
            check(set(baseline) == {plain.name, illustrated.name, f'{illustrated.stem}-images', unquote(href)}, 'Unexpected disk entries after save')
            passed(f'renamed images export: {href} decoded as a 64×40 PNG with the original teal and amber pixels')
            watched = watch_output(out, resources)
            step('cancel'); picker(pid, window, cancelled, cancel=True); step('after-cancel')
        # Include native return, app modal dismissal AND termination of the private GUI/job.
        check(win32event.WaitForSingleObject(watched, 350) == win32event.WAIT_TIMEOUT and tree(out) == baseline,
              'Cancel created, renamed, removed or wrote an export entry')
        check(QA['BASE']['sha256'](source) == original, 'Input PDF was modified')
    passed(f'cancel: no export-directory change notification; same filenames and hashes; original PDF SHA-256 {original}')
    print(f'Evidence: {box} (no app or WebView2 profiles retained)', flush=True)


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8'); sys.stderr.reconfigure(encoding='utf-8')
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--qa-label', default='mdproof', help='isolated build-native-qa label (not an EXE path)')
    main(parser.parse_args().qa_label)
