"""No OCR mock: synthetic A4 scan -> scoped WebView2 UI -> Windows OCR -> local text preview.
Fresh isolated QA executable label only. No real input paths, no API, no global clicks or clipboard.
"""
import argparse
from contextlib import ExitStack
import ctypes
import hashlib
import io
from pathlib import Path
import runpy
import tempfile

import fitz
from PIL import Image, ImageDraw, ImageFont

M=runpy.run_path(str(Path(__file__).with_name('verify-native-markdown-025.py')))
QA=M['QA']


def scan(file,rotation=0):
    img=Image.new('RGB',(1500,2121),'white'); g=ImageDraw.Draw(img)
    font=ImageFont.truetype('arial.ttf',60)
    g.text((120,220),'PAPER PROOF 72918',fill='black',font=font)
    g.text((120,380),'Local printed text only.',fill='black',font=font)
    if rotation: img=img.transpose({90:Image.Transpose.ROTATE_90,180:Image.Transpose.ROTATE_180,270:Image.Transpose.ROTATE_270}[rotation])
    b=io.BytesIO();img.save(b,format='PNG')
    with fitz.open() as d:
        size=(841.89,595.28) if rotation%180 else (595.28,841.89)
        p=d.new_page(width=size[0],height=size[1]);p.insert_image(p.rect,stream=b.getvalue());p.set_rotation(rotation);file.write_bytes(d.tobytes(deflate=True))
    with fitz.open(file) as d:assert len(d)==1 and not d[0].get_text().strip()


def run(label,rotation):
    exe=QA['BASE']['qa_executable'](label);M['INBOX']['guard'](exe)
    ctypes.windll.user32.SetProcessDPIAware()
    with tempfile.TemporaryDirectory(prefix='paperwork-real-ocr-',ignore_cleanup_errors=True) as tmp, ExitStack() as cleanup:
        root=Path(tmp);src=root/'Synthetic-scan.pdf';scan(src,rotation);before=hashlib.sha256(src.read_bytes()).digest();profile=root/'qa';profile.mkdir()
        ui=M['ui'];ui.__globals__['SOURCE']=src.name
        ui.__globals__['UIA']=M['UIA'].split("$close = '关闭 Markdown 导出'")[0]+r'''
[void](Need "关闭 $env:MDPROOF_SOURCE" 'Button')
if ($env:MDPROOF_STEP -eq 'ocr') {
    if(Control 'OCR 文字识别' 'Button'){Press 'OCR 文字识别' 'Button'}else{Press '更多工具' 'Button';Press 'OCR 文字识别' 'MenuItem'}
    Press '仅识别当前页' 'MenuItem'
    $receipt = WaitFor {
        foreach($el in $root.FindAll($scope,[System.Windows.Automation.Condition]::TrueCondition)) {
            $n=$el.Current.Name
            if($n -like 'OCR 已完成*' -or $n -like 'OCR 已停止*' -or $n -like '*页面识别失败*') { return $n }
        }
    } 'OCR completion or explicit failure'
    if($receipt -notlike 'OCR 已完成 1 页*' -or $receipt -like '*失败*') { throw $receipt }
} else {
    Press '导出 Markdown…' 'Button';Press '预览文字' 'Button'
    $v=(Need '本地预览文字' 'Edit').GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value
    if(($v -replace '\s','').ToUpperInvariant() -notlike '*PAPERPROOF72918*') { throw 'No recognized synthetic body in the local preview' }
}
'''
        with QA['isolated_env'](exe,profile) as env, QA['gui'](exe,src,env) as (pid,win):
            ui(exe,pid,win,'ocr');ui(exe,pid,win,'read')
        assert hashlib.sha256(src.read_bytes()).digest()==before
    print('PASS actual WebView2 -> Tauri -> Windows OCR, one raster-only A4 page; unique printed words and digits in local preview; source unchanged.',flush=True)

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('label');parser.add_argument('--rotation',type=int,choices=[0,90,180,270],default=0);args=parser.parse_args();run(args.label,args.rotation)
