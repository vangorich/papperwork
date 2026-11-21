import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const installerInclude = readFileSync(new URL('../build/installer.nsh', import.meta.url), 'utf8')
const repairPath = fileURLToPath(new URL('../build/repair-windows-branding.ps1', import.meta.url))
const repairScript = readFileSync(repairPath, 'utf8')
const quotedInstallCommand = String.raw`'$\"$INSTDIR\Paperwork PDF Studio.exe$\" $\"%1$\"'`

describe('Windows installer permissions', () => {
  it('installs for the current user without elevation', () => {
    expect(packageJson.build.nsis.perMachine).toBe(false)
    expect(packageJson.build.nsis.allowElevation).toBe(false)
    expect(installerInclude).toContain('virtual-printer.ps1')
    expect(installerInclude).not.toMatch(/runas|UAC::RunElevated|RequestExecutionLevel\s+(admin|highest)|\bAbort\b/i)
    expect(JSON.stringify(packageJson.build.extraResources)).toContain('virtual-printer.ps1')
  })

  it('registers an explicit friendly name and quoted installed command only in HKCU', () => {
    const install = installerInclude.split('!macro customInstall')[1].split('!macroend')[0]
    expect(install).toContain('WriteRegStr HKCU "${PAPERWORK_APPLICATION}" "FriendlyAppName" "Paperwork PDF Studio"')
    expect(install).toContain(`WriteRegStr HKCU "\${PAPERWORK_APPLICATION}\\shell\\open\\command" "" ${quotedInstallCommand}`)
    expect(install).toContain('"$INSTDIR\\Paperwork PDF Studio.exe.FriendlyAppName" "Paperwork PDF Studio"')
    expect(install).toContain('"$INSTDIR\\Paperwork PDF Studio.exe.ApplicationCompany" "PDF Factory"')
    expect(install).toContain('shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)')
    expect(install).toContain('-Action Install -Executable "$INSTDIR\\Paperwork PDF Studio.exe"')
  })

  it('guards uninstall cleanup by the exact installed command and preserves other values', () => {
    const uninstall = installerInclude.split('!macro customUnInstall')[1].split('!macroend')[0]
    const guard = '${If} $0 == ' + quotedInstallCommand
    expect(uninstall).toContain('ReadRegStr $0 HKCU "${PAPERWORK_APPLICATION}\\shell\\open\\command" ""')
    expect(uninstall).toContain(guard)
    const guardedCleanup = uninstall.slice(uninstall.indexOf(guard), uninstall.lastIndexOf('${EndIf}'))
    expect(guardedCleanup).toContain('${If} $1 == "Paperwork PDF Studio"')
    expect(guardedCleanup).toContain('DeleteRegValue HKCU "${PAPERWORK_APPLICATION}\\shell\\open\\command" ""')
    expect(guardedCleanup).toContain('"$INSTDIR\\Paperwork PDF Studio.exe.FriendlyAppName"')
    expect(guardedCleanup).toContain('"$INSTDIR\\Paperwork PDF Studio.exe.ApplicationCompany"')
    expect(uninstall.match(/^\s*DeleteRegKey .*$/gm)).toHaveLength(4)
    expect(uninstall).not.toMatch(/DeleteRegKey\s+(?!\/ifempty)/)
    expect(uninstall).toContain('-Action Uninstall')
  })

  it('keeps repair writes behind WhatIf after executable and registration validation', () => {
    const boundary = repairScript.indexOf('if ($PSCmdlet.ShouldProcess(')
    const validation = repairScript.slice(0, boundary)
    expect(validation).toContain('SupportsShouldProcess = $true')
    expect(validation).toContain('[Parameter(Mandatory = $true)]')
    expect(validation).toContain('Get-Item -LiteralPath $Executable')
    expect(validation).toContain("$version.ProductName -cne 'Paperwork PDF Studio'")
    expect(validation).toContain("$expectedCommand = '\"{0}\" \"%1\"' -f $executablePath")
    expect(validation).toContain("[string] $commandKey.GetValue(''), $expectedCommand, [StringComparison]::OrdinalIgnoreCase")
    expect(validation).not.toMatch(/\.SetValue\(|\.CreateSubKey\(|OpenSubKey\([^\n]*, \$true\)|::SHChangeNotify\(/)
    const writes = repairScript.slice(boundary)
    expect(writes.match(/\.SetValue\(/g)).toHaveLength(3)
    expect(writes).toContain('$executablePath.FriendlyAppName')
    expect(writes).toContain('$executablePath.ApplicationCompany')
    expect(writes).toContain('::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)')
  })

  it('does not change defaults, clear broad caches, elevate, or restart Explorer', () => {
    for (const source of [installerInclude, repairScript]) {
      expect(source).not.toMatch(/UserChoice|HKLM|HKEY_LOCAL_MACHINE|Registry\]::LocalMachine|Stop-Process|taskkill|Remove-Item|DeleteSubKeyTree|Clear-Item|runas/i)
    }
    for (const line of installerInclude.split('\n').filter(line => /^\s*(WriteReg|DeleteReg|ReadReg)/.test(line))) {
      expect(line).toContain(' HKCU ')
    }
  })

  it.skipIf(process.platform !== 'win32')('parses the repair script without executing it or writing registry values', () => {
    const escapedPath = repairPath.replaceAll("'", "''")
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$tokens = $null; $errors = $null; $ast = [System.Management.Automation.Language.Parser]::ParseFile('${escapedPath}', [ref]$tokens, [ref]$errors); if ($errors.Count) { throw ($errors | Out-String) }`,
    ], { encoding: 'utf8' })
  })
})
