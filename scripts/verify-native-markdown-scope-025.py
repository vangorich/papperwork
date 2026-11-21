"""A synthetic, highlighted PDF in an isolated WebView2 process. Drive only its UIA subtree and owned Save As. No real model, account, document or clipboard."""
from contextlib import ExitStack
import ctypes
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import runpy
import tempfile
from threading import Thread
import fitz

M = runpy.run_path(str(Path(__file__).with_name('verify-native-markdown-025.py')))
QA, check = M['QA'], M['check']
PREVIEW = '## 第 1 页\n\nWide pencil\n'
EDITED = '用户核对：Wide pencil\n'
ADOPTED = '## Checked\n\n已核对 Wide pencil.\n'
SRC = 'QA-local-marker.pdf'


def run(label='mdscoped3'):
    exe = QA['BASE']['qa_executable'](label); M['INBOX']['guard'](exe)
    root = Path(tempfile.mkdtemp(prefix='paperwork-md-scoped-', dir=QA['BASE']['TEMP']))
    source = root / SRC; out = root / 'export'; out.mkdir()
    doc = fitz.open(); p = doc.new_page(width=420, height=440)
    p.insert_text((30, 90), 'Before Wide pencil after', fontsize=15)
    p.insert_text((30, 140), 'NEVER INCLUDE NEIGHBOR', fontsize=13)
    mark = p.add_highlight_annot(p.search_for('Wide pencil')); mark.set_info(content='COMMENT NOT BODY'); mark.update()
    with source.open('xb') as f: f.write(doc.tobytes(deflate=True))
    doc.close(); original = QA['BASE']['sha256'](source); sent = []

    class Sink(BaseHTTPRequestHandler):
        def log_message(self, *_): pass
        def do_POST(self):
            if self.client_address[0] != '127.0.0.1' or self.path != '/v1/chat/completions' or self.headers.get('Authorization') != 'Bearer synthetic-only' or not 0 < int(self.headers.get('Content-Length') or 0) < 8000:
                self.send_error(403); return
            sent.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
            data=json.dumps({'choices':[{'finish_reason':'stop','message':{'role':'assistant','content':ADOPTED}}]},ensure_ascii=False).encode()
            self.send_response(200); self.send_header('Content-Type','application/json'); self.send_header('Content-Length',str(len(data))); self.end_headers(); self.wfile.write(data)

    ctypes.windll.user32.SetProcessDPIAware()
    with ExitStack() as cleanup:
        server=ThreadingHTTPServer(('127.0.0.1',0),Sink); cleanup.callback(server.server_close)
        worker=Thread(target=server.serve_forever,daemon=True); worker.start(); cleanup.callback(worker.join); cleanup.callback(server.shutdown)
        profile=root/'qa-host'; profile.mkdir(); cleanup.callback(QA['remove_ours'],profile)
        ui=M['ui']; ui.__globals__['SOURCE']=SRC
        ui.__globals__['UIA']=M['UIA'].split("$close = '关闭 Markdown 导出'")[0]+r'''
function ValueOf($name) { (Need $name 'Edit').GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern) }
function Field($name,$value) { (ValueOf $name).SetValue($value) }
if ($env:MDPROOF_STEP -eq 'start') {
    [void](Need "关闭 $env:MDPROOF_SOURCE" 'Button'); Press '导出 Markdown…' 'Button'
    (Need '已有高亮' 'RadioButton').GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select()
    Press '预览文字' 'Button'
    [void](WaitFor {
        $p = Control '本地预览文字' 'Edit'; if ($p) { return $p }
        foreach($el in $root.FindAll($scope,[System.Windows.Automation.Condition]::TrueCondition)) {
            $n=$el.Current.Name; if($n -like '*没有可导出的高亮*' -or $n -like '*无法可靠*') { throw $n }
            if($n -eq '本地预览文字') {
                if ($el.Current.ControlType.ProgrammaticName -ne 'ControlType.Edit') { throw ('QA preview exposed as '+$el.Current.ControlType.ProgrammaticName) }
                if ($el.Current.IsOffscreen) {
                    $scroll=$null
                    if ($el.TryGetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern,[ref]$scroll)) { $scroll.ScrollIntoView() }
                }
                # UIA may publish the Edit before React finishes enabling it. The next poll must still find the real, on-screen control.
            }
        }
    } 'local excerpt or exact UIA error')
    $v=(ValueOf '本地预览文字').Current.Value.Replace("`r`n","`n")
    if ($v -cne "## 第 1 页`n`nWide pencil`n") { throw 'Wrong excerpt from native highlight (or a nonselected word present)' }
    (Need 'API 辅助整理' 'CheckBox').GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Toggle()
    Field 'API 地址' 'http://127.0.0.1:PORT'; Field '模型' 'fixture-model'; Field 'API Key（可选）' 'synthetic-only'
    Field '本地预览文字' "用户核对：Wide pencil`n"; [void](Need '确认发送预览文字' 'Button')
} elseif ($env:MDPROOF_STEP -eq 'send') {
    Press '确认发送预览文字' 'Button'; [void](Need '采用 API 结果' 'Button')
} elseif ($env:MDPROOF_STEP -eq 'adopt') {
    Press '采用 API 结果' 'Button'; Press '选择保存位置' 'Button'
} else { throw 'Unsupported QA action' }
'''.replace('127.0.0.1:PORT','127.0.0.1:'+str(server.server_port))
        with QA['isolated_env'](exe,profile) as env, QA['gui'](exe,source,env) as (pid,hwnd):
            ui(exe,pid,hwnd,'start'); check(not sent and not list(out.iterdir()),'Opening, previewing or editing sent data or wrote a file')
            ui(exe,pid,hwnd,'send'); check(len(sent)==1 and set(sent[0])=={'model','messages'} and sent[0]['model']=='fixture-model','Unexpected request shape')
            messages=sent[0]['messages']; check([m['role'] for m in messages]==['system','user'] and messages[1]=={'role':'user','content':EDITED},'The request did not contain the exact approved preview')
            check(all(bad not in str(sent) for bad in (SRC,'Before','NEVER INCLUDE','COMMENT NOT BODY','data:image','application/pdf')),'Scope expanded');check(not list(out.iterdir()),'Suggestion saved without adoption')
            ui(exe,pid,hwnd,'adopt'); target=out/'checked.md';M['picker'](pid,hwnd,target,suggested_stem=source.stem+'-已有高亮')
            QA['wait'](lambda: target.is_file() and target.read_bytes()==ADOPTED.encode('utf8'),'adopted UTF-8 result on disk')
        check(len(sent)==1 and list(out.iterdir())==[target] and QA['BASE']['sha256'](source)==original,'Unexpected file, request or original modification')
    print('PASS isolated WebView2: dedicated toolbar, native curved Highlight → exact excerpt, edited preview → one loopback WinHTTP POST on confirmation only, adopted result → owned Save As → identical UTF-8; original unchanged.',flush=True)

if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--qa-label',default='mdscoped3',help='isolated build-native-qa label (not an EXE path)')
    run(parser.parse_args().qa_label)
