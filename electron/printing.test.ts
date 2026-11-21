import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const mainSource = readFileSync(new URL('./main.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const preloadSource = readFileSync(new URL('./preload.ts', import.meta.url), 'utf8')

describe('native printing source contracts', () => {
  it('exposes system printer discovery through IPC', () => {
    expect(mainSource).toContain("ipcMain.handle('print:get-printers'")
    expect(mainSource).toContain('webContents.getPrintersAsync()')
    expect(mainSource).toContain('name: printer.name')
    expect(preloadSource).toContain("getPrinters: () => ipcRenderer.invoke('print:get-printers')")
  })

  it('imports only top-level PDF files and naturally sorts their names', () => {
    const handler = mainSource.slice(
      mainSource.indexOf("ipcMain.handle('files:open-pdf-folder'"),
      mainSource.indexOf("ipcMain.handle('files:save'"),
    )

    expect(handler).toContain("properties: ['openDirectory']")
    expect(handler).toContain('fs.readdir(directory, { withFileTypes: true })')
    expect(handler).toContain("entry.isFile() && path.extname(entry.name).toLowerCase() === '.pdf'")
    expect(handler).toContain("localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' })")
    expect(handler).not.toMatch(/recursive\s*:\s*true/)
  })

  it('keeps batch selections lightweight and reads PDF bytes on demand', () => {
    expect(mainSource).toContain("ipcMain.handle('files:open-pdf-files-for-print'")
    expect(mainSource).toContain("ipcMain.handle('files:open-pdf-folder-for-print'")
    expect(mainSource).toContain("ipcMain.handle('files:read-pdf-for-print'")
    expect(preloadSource).toContain("openPdfFilesForPrint: (multiple = true)")
    expect(preloadSource).toContain("openPdfFolderForPrint: ()")
    expect(preloadSource).toContain("readPdfFileForPrint: (path: string)")

    const lightweightHandler = mainSource.slice(
      mainSource.indexOf("ipcMain.handle('files:open-pdf-folder-for-print'"),
      mainSource.indexOf("ipcMain.handle('files:read-pdf-for-print'"),
    )
    expect(lightweightHandler).toContain('printPdfReferenceFromPath')
    expect(lightweightHandler).not.toContain('desktopFileFromPath')
  })

  it('prints pre-rasterized page images, never the Chromium PDF viewer', () => {
    expect(preloadSource).toContain("ipcRenderer.invoke('print:pages'")
    expect(mainSource).toContain("ipcMain.handle('print:pages'")
    expect(preloadSource).not.toContain('print:pdf')
    expect(mainSource).not.toContain("ipcMain.handle('print:pdf'")
    // The old path loaded the PDF into a hidden window's PDF viewer, which
    // re-encoded CJK fonts at print time (garbled) and raced the plugin
    // pipeline (all-black pages). The new contract: plain DOM <img> pages.
    expect(mainSource).toContain('<section class="page"')
    expect(mainSource).toContain('object-fit: contain')
    expect(mainSource).toContain('paintWhenInitiallyHidden: true')
    expect(mainSource).toContain('img.decode()')
  })

  it('validates rasterized page payloads before spooling', () => {
    expect(mainSource).toContain('打印页面数量无效')
    expect(mainSource).toContain('打印页面数据无效')
    expect(mainSource).toContain('page.png instanceof Uint8Array')
  })

  it('prints silently only when a native device name is supplied', () => {
    expect(mainSource).toContain("const deviceName = typeof payload.deviceName === 'string' && payload.deviceName.trim()")
    expect(mainSource).toContain('silent: Boolean(deviceName)')
    expect(mainSource).toContain('deviceName,')
  })

  it('falls back to the system print dialog when no device name is supplied', () => {
    expect(mainSource).toContain('silent: Boolean(deviceName)')
    expect(mainSource).toMatch(/typeof payload\.deviceName === 'string' && payload\.deviceName\.trim\(\)\s*\n\s*\? payload\.deviceName\s*\n\s*: undefined/)
  })

  it('keeps a Chrome-style safety inset on default margins and full-bleed otherwise', () => {
    expect(mainSource).toContain("const marginType = ['default', 'none', 'printableArea'].includes(payload.margins)")
    expect(mainSource).toContain("? payload.margins\n    : 'default'")
    expect(mainSource).toContain("const safeInsetPx = marginType === 'default' ? 16 : 0")
    expect(mainSource).toContain('padding: ${safeInsetPx}px')
    expect(mainSource).toContain('box-sizing: border-box')
    expect(mainSource).toContain('margins: { marginType },')
  })
})
