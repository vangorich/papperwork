; Build for the target, not the build machine. The temporary helper is not a service,
; is never registered as a command, and does not require Rust on the end user's PC.
!define PW_MCP_SOURCE "${__FILEDIR__}"
; Compile-time paths only. The test shell substitutes its own freshly created TEMP tree.
; There is no runtime installer option redirecting registration to another profile.
!define /ifndef PW_MCP_PROFILE "$PROFILE"
!define /ifndef PW_MCP_LOCAL "$LOCALAPPDATA"
!macro PW_MCP_BUILD
  !ifndef PW_MCP_EXE
    !if "${INSTALLMODE}" != "currentUser"
      !error "PDF MCP registration requires a current-user installer"
    !endif
    !if "${ARCH}" == "x64"
      !define PW_MCP_TRIPLE "x86_64-pc-windows-msvc"
    !else if "${ARCH}" == "arm64"
      !define PW_MCP_TRIPLE "aarch64-pc-windows-msvc"
    !else
      !error "Unsupported PDF MCP helper architecture: ${ARCH}"
    !endif
    !define PW_MCP_TARGET "${PW_MCP_SOURCE}\..\target\mcp-client-config"
    !system 'cargo rustc --locked --release --target ${PW_MCP_TRIPLE} --manifest-path "${PW_MCP_SOURCE}\Cargo.toml" --target-dir "${PW_MCP_TARGET}" -- -C target-feature=+crt-static' = 0
    !define PW_MCP_EXE "${PW_MCP_TARGET}\${PW_MCP_TRIPLE}\release\paperwork-mcp-client-config.exe"
  !endif
!macroend

LangString PW_MCP_Ask 2052 "为此 Windows 用户已检测到的 Claude Code、Codex、Gemini CLI 注册本地 PDF 工具？注册不会共享任何文档；每份文档仍须在 Paperwork 中授权。选择“否”仅维护此前已注册的条目。"
LangString PW_MCP_Ask 1033 "Register local PDF tools for the Claude Code, Codex and Gemini CLI profiles detected for this Windows user? Registration shares no documents. Each document still needs a grant in Paperwork. Choose No to maintain previously registered entries only."
LangString PW_MCP_Skipped 2052 "部分 PDF 工具配置未更改。请查看安装详细信息；如配置被占用，可关闭客户端后重试。"
LangString PW_MCP_Skipped 1033 "Some PDF tool registrations were left unchanged. See the installer details; if a client has locked its settings, close it and retry."

!macro PW_MCP_RUN MODE
  !insertmacro PW_MCP_BUILD
  InitPluginsDir
  File "/oname=$PLUGINSDIR\paperwork-mcp-client-config.exe" "${PW_MCP_EXE}"
  nsExec::ExecToLog /TIMEOUT=30000 '"$PLUGINSDIR\paperwork-mcp-client-config.exe" ${MODE} "${PW_MCP_PROFILE}" "${PW_MCP_LOCAL}" "$INSTDIR\${MAINBINARYNAME}.exe"'
  Pop $R9
  ${If} $R9 != 0
    DetailPrint "$(PW_MCP_Skipped) ($R9)"
    ${IfNot} ${Silent}
    ${AndIf} $PassiveMode != 1
    ${AndIf} $UpdateMode != 1
      MessageBox MB_OK|MB_ICONINFORMATION "$(PW_MCP_Skipped)"
    ${EndIf}
  ${EndIf}
  Delete "$PLUGINSDIR\paperwork-mcp-client-config.exe"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  Push $R8
  Push $R9
  StrCpy $R8 refresh
  ; A silent/passive upgrade maintains owned entries only. Unattended first-time
  ; registration requires the explicit /REGISTERPDFMCP=1 installer argument.
  ClearErrors
  ${GetParameters} $R9
  ; Search at an unquoted argument boundary, not inside /D=C:/some/path.
  ${GetOptions} " $R9" " /REGISTERPDFMCP=" $R9
  ${If} $R9 == "1"
    StrCpy $R8 install
  ${ElseIfNot} ${Silent}
  ${AndIf} $PassiveMode != 1
  ${AndIf} $UpdateMode != 1
    ${If} ${FileExists} "${PW_MCP_PROFILE}\.claude.json"
    ${OrIf} ${FileExists} "${PW_MCP_PROFILE}\.claude\*.*"
    ${OrIf} ${FileExists} "${PW_MCP_PROFILE}\.codex\*.*"
    ${OrIf} ${FileExists} "${PW_MCP_PROFILE}\.gemini\*.*"
      MessageBox MB_YESNO|MB_DEFBUTTON2|MB_ICONQUESTION "$(PW_MCP_Ask)" /SD IDNO IDNO pw_mcp_apply
      StrCpy $R8 install
    ${EndIf}
  ${EndIf}
  pw_mcp_apply:
  !insertmacro PW_MCP_RUN $R8
  Pop $R9
  Pop $R8
  ClearErrors
!macroend

; After the app is actually removed, not before a cancellable running-app check.
; Receipts live outside Tauri's optionally cleared app-data directory.
!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode != 1
    Push $R9
    !insertmacro PW_MCP_RUN uninstall
    Pop $R9
    ClearErrors
  ${EndIf}
!macroend
