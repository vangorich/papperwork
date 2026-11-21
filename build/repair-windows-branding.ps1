# Repairs only current-user branding for one explicitly selected installation.
# Example (preview first):
# .\repair-windows-branding.ps1 -Executable 'D:\Program Files\Paperwork PDF Studio\Paperwork PDF Studio.exe' -WhatIf
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string] $Executable
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'This repair is supported only on Windows.'
}
if (-not [IO.Path]::IsPathRooted($Executable)) {
    throw 'Supply the absolute path of the installed executable.'
}
$file = Get-Item -LiteralPath $Executable -Force
if ($file -isnot [IO.FileInfo] -or $file.Name -ine 'Paperwork PDF Studio.exe') {
    throw 'The selected file must be Paperwork PDF Studio.exe.'
}
$executablePath = $file.FullName
$version = [Diagnostics.FileVersionInfo]::GetVersionInfo($executablePath)
if ($version.ProductName -cne 'Paperwork PDF Studio') {
    throw 'ProductName does not identify Paperwork PDF Studio; no changes made.'
}

$applicationKey = 'Software\Classes\Applications\Paperwork PDF Studio.exe'
$muiCacheKey = 'Software\Classes\Local Settings\Software\Microsoft\Windows\Shell\MuiCache'
$expectedCommand = '"{0}" "%1"' -f $executablePath
$commandKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("$applicationKey\shell\open\command")
try {
    if ($null -eq $commandKey -or -not [string]::Equals(
        [string] $commandKey.GetValue(''), $expectedCommand, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The current-user registered open command does not match this installation; no changes made.'
    }
} finally {
    if ($null -ne $commandKey) { $commandKey.Dispose() }
}

# One approval boundary covers every write and the shell notification. WhatIf
# still performs the read-only identity checks above, but never opens writable keys.
if ($PSCmdlet.ShouldProcess($executablePath, 'Repair current-user application and MuiCache branding')) {
    $application = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($applicationKey, $true)
    try {
        $application.SetValue('FriendlyAppName', 'Paperwork PDF Studio', [Microsoft.Win32.RegistryValueKind]::String)
    } finally {
        if ($null -ne $application) { $application.Dispose() }
    }
    $muiCache = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($muiCacheKey)
    try {
        $muiCache.SetValue("$executablePath.FriendlyAppName", 'Paperwork PDF Studio', [Microsoft.Win32.RegistryValueKind]::String)
        $muiCache.SetValue("$executablePath.ApplicationCompany", 'PDF Factory', [Microsoft.Win32.RegistryValueKind]::String)
    } finally {
        if ($null -ne $muiCache) { $muiCache.Dispose() }
    }

    if (-not ('PaperworkBranding.Shell' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace PaperworkBranding {
    public static class Shell {
        [DllImport("shell32.dll")]
        public static extern void SHChangeNotify(uint eventId, uint flags, IntPtr item1, IntPtr item2);
    }
}
'@
    }
    [PaperworkBranding.Shell]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)
    Write-Output "Repaired current-user branding for $executablePath. Reopen the Windows Open with dialog to verify."
}
