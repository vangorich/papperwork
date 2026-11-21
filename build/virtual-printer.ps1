param(
  [Parameter(Mandatory = $true)][ValidateSet('Install', 'Uninstall')][string]$Action,
  [string]$Executable
)

$ErrorActionPreference = 'Stop'
$printerName = 'Paperwork PDF Studio'
$runValueName = 'Paperwork PDF Studio'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$outputFile = Join-Path $env:APPDATA 'Paperwork PDF Studio\PrintInbox\PaperworkPrint.pdf'
$inbox = Split-Path -Parent $outputFile

if ($Action -eq 'Uninstall') {
  Remove-ItemProperty -Path $runKey -Name $runValueName -ErrorAction SilentlyContinue
  try {
    $printer = Get-Printer -Name $printerName -ErrorAction SilentlyContinue
    if ($printer) { Remove-Printer -Name $printerName }
    $port = Get-PrinterPort -Name $outputFile -ErrorAction SilentlyContinue
    if ($port) { Remove-PrinterPort -Name $outputFile }
  }
  catch {
    # Policy can also deny removal to a standard user. Never block uninstall;
    # an administrator can remove an orphaned printer later.
    Write-Warning "Virtual printer could not be removed: $($_.Exception.Message)"
  }
  Remove-Item -LiteralPath $outputFile -Force -ErrorAction SilentlyContinue
  exit 0
}

if (-not $Executable -or -not (Test-Path -LiteralPath $Executable)) {
  Write-Output 'Paperwork executable was not found.'
  exit 2
}

New-Item -ItemType Directory -Path $inbox -Force | Out-Null
$failures = [System.Collections.Generic.List[string]]::new()

$driver = Get-PrinterDriver -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match '^Microsoft Print to PDF$' } |
  Select-Object -First 1
if (-not $driver) {
  $failures.Add('Microsoft Print to PDF is not enabled. The user installer will not enable Windows optional features.')
}
else {
  try {
    if (-not (Get-PrinterPort -Name $outputFile -ErrorAction SilentlyContinue)) {
      Add-PrinterPort -Name $outputFile | Out-Null
    }
    $printer = Get-Printer -Name $printerName -ErrorAction SilentlyContinue
    if ($printer) { Set-Printer -Name $printerName -PortName $outputFile }
    else { Add-Printer -Name $printerName -DriverName $driver.Name -PortName $outputFile }
    Set-Printer -Name $printerName -Comment 'Print directly into Paperwork PDF Studio'
  }
  catch {
    # Point-and-Print or printer-management policy commonly rejects creation by
    # standard users. Report a partial setup; never request elevation here.
    $failures.Add("Windows printer policy rejected registration: $($_.Exception.Message)")
  }
}

# HKCU Run starts the tray watcher in the signed-in user's normal desktop
# session. It needs no task scheduler access, stored credentials or elevation.
try {
  New-Item -Path $runKey -Force | Out-Null
  $runCommand = '"{0}" --background' -f $Executable
  New-ItemProperty -Path $runKey -Name $runValueName -Value $runCommand -PropertyType String -Force | Out-Null
}
catch {
  $failures.Add("Windows policy rejected the current-user startup entry: $($_.Exception.Message)")
}

if ($failures.Count) {
  # Exit 2 means Paperwork itself installed successfully, but Windows policy or
  # a missing built-in driver left virtual printing partially unavailable.
  # installer.nsh displays this message and deliberately continues installation.
  Write-Output ($failures -join ' ')
  exit 2
}

Write-Output "Virtual printer registered for the current user. Inbox: $inbox"
exit 0
