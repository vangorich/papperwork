import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  hasCompletePdfMarkers,
  resolveVirtualPrinterOutputFile,
  VIRTUAL_PRINT_CAPTURE_DEBOUNCE_MS,
  VIRTUAL_PRINT_STABILITY_POLL_MS,
  VIRTUAL_PRINT_STABLE_SAMPLES,
  VIRTUAL_PRINTER_NAME,
} from './virtualPrinter'

const source = readFileSync(new URL('../build/virtual-printer.ps1', import.meta.url), 'utf8')

describe('virtual printer setup script', () => {
  it('registers with user-scoped paths and no elevation commands', () => {
    expect(source).toContain('Add-Printer -Name $printerName')
    expect(source).toContain('Remove-Printer -Name $printerName')
    expect(source).toContain('$env:APPDATA')
    expect(source).toContain('HKCU:')
    expect(source).toContain('--background')
    expect(source).toContain(VIRTUAL_PRINTER_NAME)
    expect(source).not.toMatch(/ProgramData|Set-Acl|Enable-WindowsOptionalFeature|wevtutil|Register-ScheduledTask|\brunas\b|-Verb\s+RunAs/i)
  })

  it('uses a valid file port and a fast, complete-PDF capture policy', () => {
    const userData = path.join('C:\\Users\\reader', 'AppData', 'Roaming', 'Paperwork PDF Studio')
    const filePort = 'C:\\Users\\reader\\AppData\\Roaming\\Paperwork PDF Studio\\PrintInbox\\PaperworkPrint.pdf'
    expect(resolveVirtualPrinterOutputFile(userData, filePort)).toBe(path.normalize(filePort))
    expect(resolveVirtualPrinterOutputFile(userData, 'PORTPROMPT:')).toBe(path.join(userData, 'PrintInbox', 'PaperworkPrint.pdf'))
    expect(VIRTUAL_PRINT_CAPTURE_DEBOUNCE_MS).toBeLessThanOrEqual(100)
    expect(VIRTUAL_PRINT_STABILITY_POLL_MS).toBeLessThanOrEqual(100)
    expect(VIRTUAL_PRINT_STABLE_SAMPLES).toBeGreaterThanOrEqual(2)
    expect(hasCompletePdfMarkers(Buffer.from('%PDF-1.7'), Buffer.from('body\n%%EOF\n'))).toBe(true)
    expect(hasCompletePdfMarkers(Buffer.from('%PDF-1.7'), Buffer.from('partial body'))).toBe(false)
  })

  it.skipIf(process.platform !== 'win32')('generates valid Windows PowerShell', () => {
    const base64 = Buffer.from(source, 'utf16le').toString('base64')
    const command = `$source=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${base64}')); $tokens=$null; $errors=$null; [Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors) > $null; if($errors.Count){$errors | Out-String | Write-Error; exit 1}`
    expect(() => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command])).not.toThrow()
  })
})
