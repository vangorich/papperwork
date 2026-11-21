"""Open ONE explicitly supplied MSG read-only in an alternate-ID WebView2. No export,
API, clipboard, notes, screenshots, attachment access, printer or content logs. Windows only.
Usage: python -I -B scripts/verify-native-msg-open.py <QA-label> <path-to-authorized.msg>
"""
import base64, hashlib, json, os, runpy, subprocess, sys, tempfile
from contextlib import ExitStack
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INBOX = runpy.run_path(str(ROOT/'scripts'/'verify-native-inbox-025.py'))
QA = INBOX['QA']

# The adapter only queries the launched main window. Deliberately never print a UIA
# name, TextPattern result, exception containing input data, pixel, or HWND dump.
UIA = r'''
$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
$ae=[System.Windows.Automation.AutomationElement]; $scope=[System.Windows.Automation.TreeScope]::Descendants
$app=Get-Process -Id ([int]$env:PW_MSG_QA_PID); $root=$ae::FromHandle([IntPtr]([long]$env:PW_MSG_QA_HWND))
if ($app.Path -ne $env:PW_MSG_QA_EXE -or $root.Current.ProcessId -ne $app.Id -or $root.Current.ClassName -ne 'Tauri Window') {exit 11}
function Match($n) { [System.Windows.Automation.PropertyCondition]::new($ae::NameProperty,$n) }
$end=[DateTime]::UtcNow.AddSeconds(65)
while([DateTime]::UtcNow -lt $end){
 if($app.HasExited){exit 12}
 try {
  $tab=$root.FindFirst($scope,(Match ('关闭 '+$env:PW_MSG_QA_LEAF)))
  $stage=$root.FindFirst($scope,(Match 'PDF 预览工作区'))
  if($tab -and $stage){
   $layer=$stage.FindFirst($scope,(Match '可选择的 PDF 文本层'))
   if($layer){
    $labels=@('备忘录','发件人：','收件人：','主题：');$matched=0
    foreach($n in $labels){if($layer.FindFirst($scope,(Match $n))){$matched++}}
    # Inspect page geometry and selectable content in memory. Only booleans escape.
    $bounds=$layer.Current.BoundingRectangle
    if($matched -eq $labels.Count -and $bounds.Width -gt 0 -and $bounds.Height -gt 0){
      $portrait=[Math]::Abs($bounds.Height/$bounds.Width - 297/210) -lt .035
      $body=$false;$textCond=[System.Windows.Automation.PropertyCondition]::new($ae::ControlTypeProperty,[System.Windows.Automation.ControlType]::Text)
      foreach($el in $layer.FindAll($scope,$textCond)){if($el.Current.Name.Length -gt 20){$body=$true;break}}
      if($portrait -and $body){[Console]::WriteLine('{"opened":true,"portraitA4":true,"memoHeaders":true,"nonemptyTextLayer":true}');exit 0}
    }
   }
  }
 }catch [System.Windows.Automation.ElementNotAvailableException]{}
 Start-Sleep -Milliseconds 160
}
exit 13
'''

def main(label, candidate):
    import win32file, win32con
    source=Path(candidate).resolve(strict=True)
    if source.suffix.lower()!='.msg' or not 0 < source.stat().st_size <= 32*1024*1024: raise ValueError('Input must be a bounded MSG file')
    exe=QA['BASE']['qa_executable'](label); INBOX['guard'](exe)
    # Deny write/delete sharing throughout the entire native read and the post-check.
    with ExitStack() as stack:
        handle=win32file.CreateFile(str(source),win32con.GENERIC_READ,win32con.FILE_SHARE_READ,None,win32con.OPEN_EXISTING,win32con.FILE_ATTRIBUTE_NORMAL,None)
        stack.callback(handle.Close)
        digest=lambda: hashlib.sha256(source.read_bytes()).digest()
        before=digest(); box=Path(tempfile.mkdtemp(prefix='paperwork-private-msg-'));stack.callback(QA['remove_ours'],box)
        env=stack.enter_context(QA['isolated_env'](exe,box))
        # Keep normal Tauri IPC/local assets. The QA browser is denied external host resolution;
        # no external API is configured or invoked, no URLs/attachments are activated.
        env['WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS']='--disable-background-networking --disable-sync --no-proxy-server --host-resolver-rules="MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE *.localhost"'
        with QA['gui'](exe,source,env) as (pid,hwnd):
            args=['powershell.exe','-NoLogo','-NoProfile','-NonInteractive','-STA','-EncodedCommand',base64.b64encode(UIA.encode('utf-16-le')).decode()]
            result=subprocess.run(args,cwd=ROOT,env={**env,'PW_MSG_QA_EXE':str(exe),'PW_MSG_QA_PID':str(pid),'PW_MSG_QA_HWND':str(hwnd),'PW_MSG_QA_LEAF':source.name},capture_output=True,timeout=82)
            if result.returncode: raise RuntimeError('Native memo view did not pass the structural UIA check (step '+str(result.returncode)+'); original content not logged')
            receipt=json.loads(result.stdout.decode('utf8').strip()); assert receipt==dict(opened=True,portraitA4=True,memoHeaders=True,nonemptyTextLayer=True)
        assert digest()==before,'Input hash changed'
    print(json.dumps({**receipt,'originalHashUnchanged':True,'readOnlyFileLock':True,'savedCopy':False,'apiUsed':False,'screenshots':False}))
if __name__=='__main__':
    if len(sys.argv)!=3: raise SystemExit('Usage: verify-native-msg-open.py QA-label authorized.msg')
    try: main(sys.argv[1],sys.argv[2])
    except Exception as e:
        # No exception text from parsers, OS dialogs, UIA text, or file paths in a report.
        print('FAIL: private MSG verification did not pass ('+type(e).__name__+')', file=sys.stderr);sys.exit(1)
