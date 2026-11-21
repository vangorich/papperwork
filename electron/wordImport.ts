import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const WORD_TO_PDF_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$word = $null
$document = $null
try {
  $word = New-Object -ComObject Word.Application
  $word.Visible = $false
  $word.DisplayAlerts = 0
  $document = $word.Documents.Open($env:PAPERWORK_WORD_INPUT, $false, $true)
  $document.ExportAsFixedFormat($env:PAPERWORK_WORD_OUTPUT, 17)
} finally {
  if ($null -ne $document) { $document.Close([ref]$false) }
  if ($null -ne $word) { $word.Quit() }
  if ($null -ne $document) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($document) }
  if ($null -ne $word) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($word) }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}
`

/** Uses the user's installed Microsoft Word to preserve pagination and layout. */
export async function convertWordToPdfDesktopFile(inputPath: string) {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'paperwork-word-'))
  const outputPath = path.join(temporaryDirectory, 'converted.pdf')
  try {
    await execFileAsync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command', WORD_TO_PDF_SCRIPT,
    ], {
      timeout: 120_000,
      windowsHide: true,
      env: {
        ...process.env,
        PAPERWORK_WORD_INPUT: path.normalize(inputPath),
        PAPERWORK_WORD_OUTPUT: outputPath,
      },
      maxBuffer: 1024 * 1024,
    })
    const [bytes, info] = await Promise.all([fs.readFile(outputPath), fs.stat(inputPath)])
    return {
      path: '',
      name: `${path.basename(inputPath, path.extname(inputPath))}.pdf`,
      type: 'pdf' as const,
      bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      size: bytes.byteLength,
      createdAt: info.birthtime.toISOString(),
      modifiedAt: info.mtime.toISOString(),
      accessedAt: info.atime.toISOString(),
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`无法转换 Word 文档。请确认已安装桌面版 Microsoft Word，且文件未被占用。${detail ? `\n${detail}` : ''}`)
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined)
  }
}
