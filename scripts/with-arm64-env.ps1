# Run from a normal x64 PowerShell. No elevation, VS setup or persistent environment changes.
#   .\scripts\with-arm64-env.ps1 cargo build --target aarch64-pc-windows-msvc --release
#   .\scripts\with-arm64-env.ps1 npm.cmd run build:arm64
# The per-user overlay supplies VC 14.44 ARM64 tools/CRT and Windows SDK 26100 ARM64 libs.
# PDF_FACTORY_ARM64_ROOT can point to another copy (VC\Tools\MSVC and SDK\Lib below it).
param([string]$Program)
$ErrorActionPreference = 'Stop'
if (!$Program) { throw 'Usage: with-arm64-env.ps1 PROGRAM [ARG ...]' }
$CommandArgs = $args

$root = $env:PDF_FACTORY_ARM64_ROOT
if (!$root) { $root = Join-Path $env:LOCALAPPDATA 'PDF-Factory\arm64-msvc' }
$vcVersion = '14.44.35207'
$kitVersion = '10.0.26100.0'
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$header = & $vswhere -products '*' -prerelease -find "VC\Tools\MSVC\$vcVersion\include\vcruntime.h" | Select-Object -First 1
if (!$header) { throw "Missing x64 MSVC $vcVersion host tools/headers" }
$hostVc = (Get-Item -LiteralPath $header).Directory.Parent.FullName
$roots = 'HKLM:\SOFTWARE\Wow6432Node\Microsoft\Windows Kits\Installed Roots', 'HKLM:\SOFTWARE\Microsoft\Windows Kits\Installed Roots'
$kit = Get-ItemProperty -LiteralPath $roots -ErrorAction SilentlyContinue | Where-Object KitsRoot10 | Select-Object -First 1 -ExpandProperty KitsRoot10
if (!$kit) { throw 'Windows 10/11 SDK not registered' }
$inc = Join-Path $kit "Include\$kitVersion"
$bin = Join-Path $kit "bin\$kitVersion\x64"
$hostLib = Join-Path $kit "Lib\$kitVersion"
$vc = Join-Path $root "VC\Tools\MSVC\$vcVersion"
$cross = Join-Path $vc 'bin\Hostx64\arm64'
$sdkLib = Join-Path $root "SDK\Lib\$kitVersion"
$libs = "$vc\lib\arm64", "$sdkLib\um\arm64", "$sdkLib\ucrt\arm64"
foreach ($file in @("$cross\cl.exe", "$cross\link.exe", "$cross\lib.exe", "$($libs[0])\msvcrt.lib", "$($libs[0])\libcmt.lib", "$($libs[1])\kernel32.lib", "$($libs[2])\ucrt.lib", "$hostVc\bin\Hostx64\x64\link.exe", "$hostLib\um\x64\kernel32.lib", "$inc\um\Windows.h", "$inc\ucrt\stdio.h", "$bin\rc.exe")) {
    if (!(Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing toolchain file: $file" }
}

# Cargo runs build scripts and proc macros on x64. Global LIB/PATH must remain x64;
# native ARM64 search paths go only to Rust's explicit --target build. Unit separators
# preserve paths containing spaces. Carry existing environment flags forward.
$flags = if ($env:CARGO_ENCODED_RUSTFLAGS) { $env:CARGO_ENCODED_RUSTFLAGS -split [char]31 }
         elseif ($env:RUSTFLAGS) { -split $env:RUSTFLAGS }
         elseif ($env:CARGO_TARGET_AARCH64_PC_WINDOWS_MSVC_RUSTFLAGS) { -split $env:CARGO_TARGET_AARCH64_PC_WINDOWS_MSVC_RUSTFLAGS }
         elseif ($env:CARGO_BUILD_RUSTFLAGS) { -split $env:CARGO_BUILD_RUSTFLAGS }
$settings = @{
    PATH = "$hostVc\bin\Hostx64\x64;$bin;$env:PATH"
    LIB = "$hostVc\lib\x64;$hostLib\um\x64;$hostLib\ucrt\x64"
    INCLUDE = "$hostVc\include;$inc\ucrt;$inc\shared;$inc\um"
    CC_aarch64_pc_windows_msvc = "$cross\cl.exe"
    CXX_aarch64_pc_windows_msvc = "$cross\cl.exe"
    AR_aarch64_pc_windows_msvc = "$cross\lib.exe"
    CARGO_TARGET_AARCH64_PC_WINDOWS_MSVC_LINKER = "$cross\link.exe"
    CARGO_BUILD_TARGET = 'aarch64-pc-windows-msvc'
    CARGO_ENCODED_RUSTFLAGS = (@($libs | ForEach-Object { "-Lnative=$_" }) + @($flags | Where-Object { $_ })) -join [char]31
    VSLANG = '1033'
}
$saved = @{}
try {
    foreach ($key in $settings.Keys) {
        $saved[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
        [Environment]::SetEnvironmentVariable($key, $settings[$key], 'Process')
    }
    & $Program @CommandArgs
    $code = $LASTEXITCODE
} finally {
    foreach ($key in $saved.Keys) { [Environment]::SetEnvironmentVariable($key, $saved[$key], 'Process') }
}
exit $code
