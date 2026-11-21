"""Verify real Windows app pixels without enabling DevTools in a shipping binary.
Requires Python, Pillow and pywin32 on the test machine only. Use the synthetic
fixtures from verify-workbench.cjs / tests/ofdFixture.ts, never personal files.
"""
import argparse
import ctypes
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import warnings

from PIL import Image
import win32gui
import win32process
import win32ui


def own_window(pid, electron):
    windows = []
    def visit(hwnd, _):
        if win32process.GetWindowThreadProcessId(hwnd)[1] != pid or not win32gui.IsWindowVisible(hwnd):
            return
        kind = win32gui.GetClassName(hwnd)
        if kind == ('Chrome_WidgetWin_1' if electron else 'Tauri Window'):
            windows.append(hwnd)
    win32gui.EnumWindows(visit, None)
    return windows[0] if windows else None


def capture(hwnd):
    left, top, right, bottom = win32gui.GetWindowRect(hwnd)
    w, h = right - left, bottom - top
    if w <= 1 or h <= 1:
        raise RuntimeError('The synthetic test window was minimized')
    hdc = win32gui.GetWindowDC(hwnd)
    src = win32ui.CreateDCFromHandle(hdc)
    dst = src.CreateCompatibleDC()
    bmp = win32ui.CreateBitmap()
    try:
        bmp.CreateCompatibleBitmap(src, w, h)
        dst.SelectObject(bmp)
        if not ctypes.windll.user32.PrintWindow(hwnd, dst.GetSafeHdc(), 2):
            raise RuntimeError('Cannot capture the test window')
        return Image.frombytes('RGB', (w, h), bmp.GetBitmapBits(True), 'raw', 'BGRX')
    finally:
        dst.DeleteDC()
        src.DeleteDC()
        win32gui.ReleaseDC(hwnd, hdc)
        win32gui.DeleteObject(bmp.GetHandle())


def paint_match(im, rgb, welcome=False):
    w, h = im.size
    # Exclude the sidebar, notifications and status bar; only document pixels count.
    sample = (im.crop((int(w*.24), int(h*.16), int(w*.97), int(h*.90))) if not welcome else im).resize((240, 150))
    return sum(n for n, color in sample.getcolors(240*150) or [] if max(abs(a-b) for a,b in zip(color,rgb)) < 15) >= (30 if not welcome else 110)


def wait_for(fn, proc, what, timeout=55):
    due = time.monotonic() + timeout
    while True:
        if proc.poll() is not None:
            raise RuntimeError('Test app exited; close other running instances of the same product first.')
        result = fn()
        if result:
            return result
        if time.monotonic() >= due:
            raise RuntimeError('Timed out waiting for '+what)
        time.sleep(.04)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--exe', required=True, type=Path)
    parser.add_argument('--pdf', required=True, type=Path)
    parser.add_argument('--ofd', type=Path)
    parser.add_argument('--screenshot', type=Path)
    parser.add_argument('--electron', action='store_true')
    args = parser.parse_args()
    assert args.exe.is_file() and args.pdf.is_file() and (args.ofd is None or args.ofd.is_file())
    ctypes.windll.user32.SetProcessDPIAware()
    tmp = Path(tempfile.mkdtemp(prefix='paperwork-native-paint-'))
    env = dict(os.environ, WEBVIEW2_USER_DATA_FOLDER=str(tmp/'profile')); env.pop('ELECTRON_RUN_AS_NODE', None)
    base = [str(args.exe.resolve())] + ([f'--user-data-dir={tmp / "profile"}'] if args.electron else [])
    extras = []; proc = subprocess.Popen(base, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        hwnd = wait_for(lambda: own_window(proc.pid, args.electron), proc, 'our own application window')
        def image_with(rgb, welcome=False):
            im = capture(hwnd)
            return im if paint_match(im, rgb, welcome) else None
        # The legacy shell has different chrome; wait for real non-uniform content there too.
        wait_for(lambda: len(capture(hwnd).resize((80,60)).getcolors(4800) or []) > 70, proc, 'painted application chrome')
        def open_and_verify(file, color):
            start = time.perf_counter()
            extras.append(subprocess.Popen(base+[str(file.resolve())], env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL))
            im = wait_for(lambda: image_with(color), proc, 'document color marker on the main stage')
            return im, round((time.perf_counter()-start)*1000)
        im, ms = open_and_verify(args.pdf,(117,33,184))
        print(f'{"Electron" if args.electron else "Tauri/WebView2"}: actual PDF pixels in {ms} ms, {args.pdf.stat().st_size} bytes; successful second-instance delivery',flush=True)
        if args.ofd:
            before = hashlib.sha256(args.ofd.read_bytes()).digest()
            im, ms = open_and_verify(args.ofd,(210,36,42))
            assert image_with((24,96,176)) and hashlib.sha256(args.ofd.read_bytes()).digest()==before
            print(f'OFD: red path and blue page template rendered in {ms} ms; original bytes unchanged',flush=True)
        if args.screenshot:
            im.save(args.screenshot)
    finally:
        for p in [*extras,proc]:
            if p.poll() is None:
                p.terminate();p.wait(timeout=8)
        for i in range(12):
            try:
                shutil.rmtree(tmp);break
            except PermissionError:
                time.sleep(.15)
        else:
            warnings.warn('The temporary WebView profile is still in use: '+str(tmp))

if __name__ == '__main__':
    main()
