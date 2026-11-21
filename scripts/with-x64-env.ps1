# Optional x64 build wrapper for machines where Rust finds link.exe but not kernel32.lib.
# Run from the repository root: .\scripts\with-x64-env.ps1 npm.cmd run build:x64
param([Parameter(Mandatory,Position=0)][string]$Program,
      [Parameter(Position=1,ValueFromRemainingArguments)][string[]]$CommandArgs)
$ErrorActionPreference='Stop'
$pf=${env:ProgramFiles(x86)}
$vswhere=Join-Path $pf 'Microsoft Visual Studio\Installer\vswhere.exe'
$vc=@(& $vswhere -products '*' -prerelease -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath) |
  ForEach-Object { Get-ChildItem (Join-Path $_ 'VC\Tools\MSVC') -Directory -ErrorAction SilentlyContinue } |
  Where-Object { (Test-Path (Join-Path $_.FullName 'bin\Hostx64\x64\cl.exe')) -and (Test-Path (Join-Path $_.FullName 'lib\x64\msvcrt.lib')) } |
  Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
$registry='HKLM:\SOFTWARE\Wow6432Node\Microsoft\Windows Kits\Installed Roots','HKLM:\SOFTWARE\Microsoft\Windows Kits\Installed Roots'
$kit=@(Get-ItemProperty $registry -ErrorAction SilentlyContinue | Select-Object -ExpandProperty KitsRoot10 -ErrorAction SilentlyContinue) + @((Join-Path $pf 'Windows Kits\10'))
$lib=$kit | Select-Object -Unique | ForEach-Object { Get-ChildItem (Join-Path $_ 'Lib') -Directory -ErrorAction SilentlyContinue } |
  Where-Object { (Test-Path (Join-Path $_.FullName 'um\x64\kernel32.lib')) -and (Test-Path (Join-Path $_.FullName 'ucrt\x64\ucrt.lib')) } |
  Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
if (!$vc -or !$lib) { throw 'Install Visual Studio C++ x64 build tools and a Windows 10/11 SDK first.' }
$vc=$vc.FullName; $sdk=$lib.Parent.Parent.FullName; $version=$lib.Name; $include=Join-Path $sdk "Include\$version"
$settings=@{
  PATH="$vc\bin\Hostx64\x64;$sdk\bin\$version\x64;$env:PATH"
  LIB="$vc\lib\x64;$($lib.FullName)\um\x64;$($lib.FullName)\ucrt\x64"
  INCLUDE="$vc\include;$include\ucrt;$include\shared;$include\um;$include\winrt;$include\cppwinrt"
  CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER="$vc\bin\Hostx64\x64\link.exe"
}
$saved=@{}
try {
  foreach($k in $settings.Keys){$saved[$k]=[Environment]::GetEnvironmentVariable($k,'Process');[Environment]::SetEnvironmentVariable($k,$settings[$k],'Process')}
  & $Program @CommandArgs; $code=$LASTEXITCODE
} finally {foreach($k in $saved.Keys){[Environment]::SetEnvironmentVariable($k,$saved[$k],'Process')}}
exit $code
