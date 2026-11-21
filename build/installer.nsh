; These registrations are per-user and never change Windows default-app choices.
!define PAPERWORK_APPLICATION "Software\Classes\Applications\Paperwork PDF Studio.exe"
!define PAPERWORK_MUICACHE "Software\Classes\Local Settings\Software\Microsoft\Windows\Shell\MuiCache"

; The per-user installer never requests elevation. Printer creation is best
; effort because Windows policy can reserve printer management for admins.
!macro customInstall
  WriteRegStr HKCU "${PAPERWORK_APPLICATION}" "FriendlyAppName" "Paperwork PDF Studio"
  WriteRegStr HKCU "${PAPERWORK_APPLICATION}\shell\open\command" "" '$\"$INSTDIR\Paperwork PDF Studio.exe$\" $\"%1$\"'
  ; Repair only this installed executable's cached Electron branding.
  WriteRegStr HKCU "${PAPERWORK_MUICACHE}" "$INSTDIR\Paperwork PDF Studio.exe.FriendlyAppName" "Paperwork PDF Studio"
  WriteRegStr HKCU "${PAPERWORK_MUICACHE}" "$INSTDIR\Paperwork PDF Studio.exe.ApplicationCompany" "PDF Factory"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  nsExec::ExecToStack 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\virtual-printer.ps1" -Action Install -Executable "$INSTDIR\Paperwork PDF Studio.exe"'
  Pop $0
  Pop $1
  StrCmp $0 "0" paperwork_printer_done
  DetailPrint "Virtual printer setup was skipped (exit $0): $1"
  MessageBox MB_ICONEXCLAMATION|MB_OK "Paperwork PDF Studio 已安装，但 Windows 策略不允许当前用户注册虚拟打印机。软件仍可正常打开和导入 PDF。$\r$\n$\r$\n详细信息：$1"
  paperwork_printer_done:
!macroend

!macro customUnInstall
  ; Another installation with the same executable name may now own this key.
  ReadRegStr $0 HKCU "${PAPERWORK_APPLICATION}\shell\open\command" ""
  ${If} $0 == '$\"$INSTDIR\Paperwork PDF Studio.exe$\" $\"%1$\"'
    ReadRegStr $1 HKCU "${PAPERWORK_APPLICATION}" "FriendlyAppName"
    ${If} $1 == "Paperwork PDF Studio"
      DeleteRegValue HKCU "${PAPERWORK_APPLICATION}" "FriendlyAppName"
    ${EndIf}
    DeleteRegValue HKCU "${PAPERWORK_APPLICATION}\shell\open\command" ""
    ; Never recursively remove a key: other values/verbs must survive.
    DeleteRegKey /ifempty HKCU "${PAPERWORK_APPLICATION}\shell\open\command"
    DeleteRegKey /ifempty HKCU "${PAPERWORK_APPLICATION}\shell\open"
    DeleteRegKey /ifempty HKCU "${PAPERWORK_APPLICATION}\shell"
    DeleteRegKey /ifempty HKCU "${PAPERWORK_APPLICATION}"
    DeleteRegValue HKCU "${PAPERWORK_MUICACHE}" "$INSTDIR\Paperwork PDF Studio.exe.FriendlyAppName"
    DeleteRegValue HKCU "${PAPERWORK_MUICACHE}" "$INSTDIR\Paperwork PDF Studio.exe.ApplicationCompany"
    System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  ${EndIf}
  nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\virtual-printer.ps1" -Action Uninstall'
!macroend
