import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, safeStorage, screen, shell, Tray } from 'electron'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { promises as fs, existsSync, readFileSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import os from 'node:os'
import { Worker } from 'node:worker_threads'
import {
  hasCompletePdfMarkers,
  resolveVirtualPrinterOutputFile,
  VIRTUAL_PRINT_CAPTURE_DEBOUNCE_MS,
  VIRTUAL_PRINT_MAX_STABILITY_POLLS,
  VIRTUAL_PRINT_STABILITY_POLL_MS,
  VIRTUAL_PRINT_STABLE_SAMPLES,
  VIRTUAL_PRINTER_NAME,
} from './virtualPrinter'
import { getOcrCapabilities, getOcrStatus, type OcrPageInput, type OcrRecognitionResult } from './ocr'
import { testOcrConnection } from './ocrConnections'
import { convertWordToPdfDesktopFile } from './wordImport'
import { TRAY_ICON_PNG_DATA_URL } from './trayIcon'
import type { ElectronicSealInventory } from './electronicSeals'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const execFileAsync = promisify(execFile)
const INTERNAL_CLIPBOARD_FORMAT = 'application/x-paperwork-pdf-studio'
const backgroundMode = process.argv.includes('--background')
let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let printerInstalled = false
let inboxWatcher: FSWatcher | null = null
let captureTimer: ReturnType<typeof setTimeout> | undefined
let capturing = false
let watcherEnabled = false
let virtualPrinterReady: Promise<boolean> | null = null
let quitting = false
let detectedPrinterPort: string | undefined
let sealInventory: Promise<ElectronicSealInventory> | undefined
// Unsaved-changes close guard state. workspaceDirty mirrors the renderer's
// revision counter and re-arms the guard on new edits; closeConfirmed is the
// one-shot token set when the renderer answers window:close-decision after
// its styled per-file save prompt (or immediately when nothing is dirty).
let workspaceDirty = false
let closeConfirmed = false
// Tracks whether a renderer is around to answer app:close-request. Closing
// before first load (or after a crash) must not hang on a reply that can
// never come — such a window holds no saveable work anyway.
let rendererLive = false
// Session-reset handshake for tray parking: the window hides only after the
// renderer confirms it dropped the browse area's documents (or the fallback
// fires). Merge workspaces and the print queue survive the hide.
let sessionResetInFlight = false
let sessionResetResolve: (() => void) | undefined

let ocrWorker: Worker | undefined
let nextOcrRequestId = 1
type PendingOcrRequest = {
  resolve: (result: OcrRecognitionResult) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
  worker?: Worker
}

const pendingOcrRequests = new Map<number, PendingOcrRequest>()

function rejectPendingOcrRequests(error: Error, worker?: Worker) {
  for (const [id, pending] of pendingOcrRequests) {
    if (worker && pending.worker !== worker) continue
    clearTimeout(pending.timeout)
    pending.reject(error)
    pendingOcrRequests.delete(id)
  }
}

function getOcrWorker() {
  if (ocrWorker) return ocrWorker
  const worker = new Worker(pathToFileURL(path.join(__dirname, 'ocrWorker.js')), {
    workerData: {
      modelDirectory: app.isPackaged
        ? path.join(process.resourcesPath, 'ocr')
        : path.join(app.getAppPath(), 'resources', 'ocr'),
    },
  })
  worker.on('message', (message: { id?: number; result?: OcrRecognitionResult; error?: string }) => {
    if (typeof message.id !== 'number') return
    const pending = pendingOcrRequests.get(message.id)
    if (!pending) return
    pendingOcrRequests.delete(message.id)
    clearTimeout(pending.timeout)
    if (message.error) pending.reject(new Error(message.error))
    else if (message.result) pending.resolve(message.result)
    else pending.reject(new Error('OCR 工作线程返回了无效结果'))
  })
  worker.on('error', (error) => {
    if (ocrWorker === worker) ocrWorker = undefined
    rejectPendingOcrRequests(error, worker)
    void worker.terminate().catch(() => {})
  })
  worker.on('exit', (code) => {
    if (ocrWorker === worker) ocrWorker = undefined
    if (code !== 0) {
      rejectPendingOcrRequests(
        new Error(`OCR 工作线程异常退出（${code}），本地引擎已重置，请重试`),
        worker,
      )
    }
  })
  ocrWorker = worker
  return worker
}

function recognizeOcrPageInWorker(payload: unknown) {
  const id = nextOcrRequestId++
  return new Promise<OcrRecognitionResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      const pending = pendingOcrRequests.get(id)
      if (!pending) return
      pendingOcrRequests.delete(id)
      const worker = pending.worker
      if (worker && ocrWorker === worker) ocrWorker = undefined
      pending.reject(new Error('OCR 识别超时，本地引擎已自动重启，请重试当前页'))
      if (worker) {
        rejectPendingOcrRequests(
          new Error('OCR 工作线程已自动重启，请重试未完成的页面'),
          worker,
        )
        void worker.terminate().catch(() => {})
      }
    }, 180_000)
    const pending: PendingOcrRequest = { resolve, reject, timeout }
    pendingOcrRequests.set(id, pending)
    try {
      const worker = getOcrWorker()
      pending.worker = worker
      const data = (payload as Partial<OcrPageInput> | null)?.data
      const transferable = data instanceof Uint8Array
        && data.buffer instanceof ArrayBuffer
        ? [data.buffer]
        : []
      worker.postMessage({ id, payload }, transferable)
    } catch (error) {
      const pending = pendingOcrRequests.get(id)
      if (pending) clearTimeout(pending.timeout)
      pendingOcrRequests.delete(id)
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

const printerOutputFile = () => resolveVirtualPrinterOutputFile(app.getPath('userData'), detectedPrinterPort)
const printQueueDirectory = () => path.join(app.getPath('userData'), 'VirtualPrintQueue')
const getSealInventory = () => sealInventory ??= import('./electronicSeals').then(({ ElectronicSealInventory }) =>
  new ElectronicSealInventory(path.join(app.getPath('userData'), 'ElectronicSeals')))

type WindowState = { bounds?: { x: number; y: number; width: number; height: number }; isMaximized?: boolean }
const windowStateFile = () => path.join(app.getPath('userData'), 'window-state.json')
let cachedWindowState: WindowState | null | undefined
let windowStateTimer: ReturnType<typeof setTimeout> | undefined

/**
 * Last normal (non-maximized) bounds plus the maximized flag, persisted across
 * restarts. loadWindowState must stay lazy: screen is only usable after ready.
 */
function loadWindowState(): WindowState | null {
  if (cachedWindowState !== undefined) return cachedWindowState
  try {
    const raw = JSON.parse(readFileSync(windowStateFile(), 'utf8')) as WindowState
    const b = raw?.bounds
    const visible = (value: NonNullable<WindowState['bounds']>) => screen.getAllDisplays().some((display) => {
      const area = display.workArea
      const overlapX = Math.max(0, Math.min(value.x + value.width, area.x + area.width) - Math.max(value.x, area.x))
      const overlapY = Math.max(0, Math.min(value.y + value.height, area.y + area.height) - Math.max(value.y, area.y))
      return overlapX >= 100 && overlapY >= 100
    })
    const valid = b && [b.x, b.y, b.width, b.height].every(Number.isFinite)
      && b.width >= 920 && b.height >= 640 && visible(b)
    cachedWindowState = valid
      ? { bounds: b, isMaximized: raw.isMaximized === true }
      : { isMaximized: raw?.isMaximized === true }
  } catch {
    cachedWindowState = null
  }
  return cachedWindowState
}

function snapshotWindowState(win: BrowserWindow): WindowState | undefined {
  if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return undefined
  // getNormalBounds (not getBounds): while maximized this is the restore rect —
  // exactly what unmaximize should return to, even after a restart.
  return { bounds: win.getNormalBounds(), isMaximized: win.isMaximized() }
}

function saveWindowState(win: BrowserWindow) {
  const snapshot = snapshotWindowState(win)
  if (!snapshot) return
  cachedWindowState = snapshot
  if (windowStateTimer) clearTimeout(windowStateTimer)
  windowStateTimer = setTimeout(() => {
    windowStateTimer = undefined
    try {
      writeFileSync(windowStateFile(), JSON.stringify(cachedWindowState))
    } catch (error) {
      console.error('Window state save failed:', error)
    }
  }, 500)
}

function flushWindowState(win: BrowserWindow) {
  if (windowStateTimer) {
    clearTimeout(windowStateTimer)
    windowStateTimer = undefined
  }
  const snapshot = snapshotWindowState(win)
  if (snapshot) cachedWindowState = snapshot
  if (!cachedWindowState) return
  try {
    writeFileSync(windowStateFile(), JSON.stringify(cachedWindowState))
  } catch (error) {
    console.error('Window state save failed:', error)
  }
}

type DesktopFileType = 'pdf' | 'ofd' | 'image'
type ExportFileFormat = 'pdf' | 'png' | 'jpeg' | 'docx'
const supportedFileExtensions = new Set(['.pdf', '.ofd', '.png', '.jpg', '.jpeg'])
const exportFormats: Record<ExportFileFormat, { extension: string; label: string }> = {
  pdf: { extension: 'pdf', label: 'PDF 文档' },
  png: { extension: 'png', label: 'PNG 图片' },
  jpeg: { extension: 'jpg', label: 'JPEG 图片' },
  docx: { extension: 'docx', label: 'Word 图片文档' },
}

function safeExportName(value: unknown, format: ExportFileFormat) {
  const profile = exportFormats[format]
  const raw = typeof value === 'string' ? path.basename(value.trim()) : ''
  const stem = raw.replace(/\.[^.]+$/, '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim().slice(0, 120)
  return `${stem || 'Paperwork-export'}.${profile.extension}`
}

type PdfPasswordHistoryEntry = {
  id: string
  password: string
  documents: string[]
  fingerprint?: string
  createdAt: string
  lastUsedAt: string
}

const PDF_PASSWORD_HISTORY_LIMIT = 30
const PDF_PASSWORD_DOCUMENT_LIMIT = 6
const pdfPasswordHistoryFile = () => path.join(app.getPath('userData'), 'pdf-password-history.json')
const safePasswordDocumentName = (value: unknown) => typeof value === 'string'
  ? [...path.basename(value)]
      .filter((character) => {
        const code = character.charCodeAt(0)
        return code > 31 && code !== 127
      })
      .join('')
      .trim()
      .slice(0, 160)
  : ''

function validPasswordHistoryEntry(value: unknown): value is PdfPasswordHistoryEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Partial<PdfPasswordHistoryEntry>
  return typeof entry.id === 'string'
    && typeof entry.password === 'string'
    && entry.password.length > 0
    && entry.password.length <= 512
    && Array.isArray(entry.documents)
    && entry.documents.every((name) => typeof name === 'string')
    && typeof entry.createdAt === 'string'
    && typeof entry.lastUsedAt === 'string'
}

async function readPdfPasswordHistory(): Promise<PdfPasswordHistoryEntry[]> {
  if (!safeStorage.isEncryptionAvailable()) return []
  try {
    const envelope = JSON.parse(await fs.readFile(pdfPasswordHistoryFile(), 'utf8')) as { encrypted?: unknown }
    if (typeof envelope.encrypted !== 'string' || !envelope.encrypted) return []
    const decoded = JSON.parse(safeStorage.decryptString(Buffer.from(envelope.encrypted, 'base64'))) as unknown
    if (!Array.isArray(decoded)) return []
    return decoded.filter(validPasswordHistoryEntry)
      .map((entry) => ({
        ...entry,
        documents: entry.documents.map(safePasswordDocumentName).filter(Boolean).slice(0, PDF_PASSWORD_DOCUMENT_LIMIT),
        fingerprint: typeof entry.fingerprint === 'string' ? entry.fingerprint.slice(0, 256) : undefined,
      }))
      .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt))
      .slice(0, PDF_PASSWORD_HISTORY_LIMIT)
  } catch {
    return []
  }
}

async function writePdfPasswordHistory(entries: PdfPasswordHistoryEntry[]) {
  if (!safeStorage.isEncryptionAvailable()) return false
  const encrypted = safeStorage.encryptString(JSON.stringify(entries.slice(0, PDF_PASSWORD_HISTORY_LIMIT))).toString('base64')
  await fs.writeFile(pdfPasswordHistoryFile(), JSON.stringify({ encrypted }), { mode: 0o600 })
  return true
}

function validateDesktopFilePath(filePath: string) {
  if (!path.isAbsolute(filePath)) throw new Error('File path must be absolute')
  const normalizedPath = path.normalize(filePath)
  if (!supportedFileExtensions.has(path.extname(normalizedPath).toLowerCase())) {
    throw new Error('Unsupported file extension')
  }
  return normalizedPath
}

function validatePrintPdfPath(filePath: unknown) {
  if (typeof filePath !== 'string') throw new Error('File path must be a string')
  const normalizedPath = validateDesktopFilePath(filePath)
  if (path.extname(normalizedPath).toLowerCase() !== '.pdf') throw new Error('Only PDF files can be printed')
  return normalizedPath
}

/** Return metadata only so a large batch does not enter renderer memory at once. */
async function printPdfReferenceFromPath(filePath: string) {
  const normalizedPath = validatePrintPdfPath(filePath)
  const stats = await fs.stat(normalizedPath)
  if (!stats.isFile()) throw new Error('The selected path is not a file')
  return {
    path: normalizedPath,
    name: path.basename(normalizedPath),
    size: stats.size,
    createdAt: stats.birthtime.toISOString(),
    modifiedAt: stats.mtime.toISOString(),
    accessedAt: stats.atime.toISOString(),
  }
}

/** Read a supported file and its metadata inside the privileged main process. */
async function desktopFileFromPath(filePath: string, name = path.basename(filePath)) {
  const normalizedPath = validateDesktopFilePath(filePath)
  const stats = await fs.stat(normalizedPath)
  if (!stats.isFile()) throw new Error('The selected path is not a file')
  const type: DesktopFileType = /\.ofd$/i.test(normalizedPath) ? 'ofd' : /\.(png|jpe?g)$/i.test(normalizedPath) ? 'image' : 'pdf'
  if(type==='ofd' && stats.size>96*1024*1024)throw new Error('OFD：文件超过 96 MiB 导入上限')
  return {
    path: normalizedPath,
    name,
    type,
    bytes: new Uint8Array(await fs.readFile(normalizedPath)),
    size: stats.size,
    createdAt: stats.birthtime.toISOString(),
    modifiedAt: stats.mtime.toISOString(),
    accessedAt: stats.atime.toISOString(),
  }
}

function showMainWindow() {
  if (!mainWindow) createWindow(true)
  if (mainWindow?.isMinimized()) mainWindow.restore()
  mainWindow?.show()
  mainWindow?.focus()
}

/**
 * Windows "Open with" / file-association launches hand the document path to us
 * as a plain argv entry. The first instance reads its own argv; every later
 * double-click arrives through second-instance. Anything that is not an
 * existing supported file (flags, the project dir in dev) is ignored.
 */
function extractOpenFileArg(argv: string[], workingDirectory?: string) {
  for (const arg of argv.slice(app.isPackaged ? 1 : 2)) {
    if (!arg || arg.startsWith('-')) continue
    // second-instance forwards relative paths against the OTHER process's
    // launch directory; resolve there, not against our own cwd.
    const resolved = path.resolve(workingDirectory ?? process.cwd(), arg)
    if (supportedFileExtensions.has(path.extname(resolved).toLowerCase()) && existsSync(resolved)) return resolved
  }
}

/** token → path for every open request main pushed to the renderer.
 * files:open-path resolves only a live token, and only once. */
const openableExternalPaths = new Map<string, string>()
/** The one delivery still awaiting a renderer ack; resent (same token) on
 * every renderer-ready ping so a pre-listener speculative send can't lose it. */
let pendingOpenToken: string | undefined

function deliverOpenFile(filePath: string) {
  const token = randomUUID()
  openableExternalPaths.set(token, filePath)
  pendingOpenToken = token
  sendPendingOpenFile()
}

function sendPendingOpenFile() {
  const token = pendingOpenToken
  if (!token) return
  const filePath = openableExternalPaths.get(token)
  if (!filePath) {
    pendingOpenToken = undefined
    return
  }
  if (!mainWindow) createWindow(true)
  if (!mainWindow) return
  const send = () => {
    if (pendingOpenToken === token) {
      mainWindow?.webContents.send('files:open-requested', { token, path: filePath })
    }
  }
  if (mainWindow.webContents.isLoadingMainFrame()) mainWindow.webContents.once('did-finish-load', send)
  else send()
}

function ensureTray() {
  if (tray) return
  const icon = nativeImage.createFromDataURL(TRAY_ICON_PNG_DATA_URL)
  tray = new Tray(icon.resize({ width: 16, height: 16 }))
  tray.setToolTip(`${VIRTUAL_PRINTER_NAME} · 虚拟打印机正在监听`)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 Paperwork PDF Studio', click: showMainWindow },
    { type: 'separator' },
    {
      label: '退出应用（停止本次监听）',
      click: () => {
        quitting = true
        app.quit()
      },
    },
  ]))
  tray.on('click', showMainWindow)
}

/**
 * Park the window in the tray with a fresh browse area. Closing the window
 * means "close every browsed PDF" for this app — the next time the window is
 * shown the reader must come up empty instead of resurrecting the previous
 * session. Merge workspaces and the print queue are user-built state and
 * survive the hide untouched. The renderer remounts its editor workspace on
 * app:session-reset and acks; we hide only after that ack so a virtual-print
 * job arriving mid-reset can never import into an editor about to be wiped.
 * The timeout is a wedge guard.
 */
function hideWindowWithFreshSession(win: BrowserWindow) {
  if (sessionResetInFlight) return
  sessionResetInFlight = true
  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    sessionResetInFlight = false
    sessionResetResolve = undefined
    // The close that parked us consumed the one-shot confirmation; re-arm so
    // the next close asks the renderer again.
    closeConfirmed = false
    if (!win.isDestroyed()) win.hide()
  }
  sessionResetResolve = finish
  win.webContents.send('app:session-reset')
  setTimeout(finish, 1500)
}

function createWindow(show = true) {
  const state = loadWindowState()
  mainWindow = new BrowserWindow({
    show,
    ...(state?.bounds ?? { width: 1460, height: 940 }),
    minWidth: 920,
    minHeight: 640,
    frame: false,
    backgroundColor: '#f3f1ec',
    // Packaged builds take the exe-embedded icon; only dev needs a file.
    ...(app.isPackaged ? {} : { icon: path.join(__dirname, '../build/icon.png') }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // OCR page preparation is coordinated by the renderer. Keep that queue
      // moving when the window is covered or the user switches applications.
      backgroundThrottling: false,
    },
  })
  if (state?.isMaximized) mainWindow.maximize()

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('did-finish-load', () => { rendererLive = true })
  mainWindow.webContents.on('did-start-loading', () => { rendererLive = false })
  // A crashed or hung renderer can never answer the close request; without
  // clearing the flag every close would preventDefault and wait forever.
  mainWindow.webContents.on('render-process-gone', () => { rendererLive = false })
  mainWindow.webContents.on('unresponsive', () => { rendererLive = false })
  mainWindow.webContents.on('responsive', () => { rendererLive = true })

  mainWindow.on('close', (event) => {
    // The renderer owns the close decision: it shows its styled save prompt
    // only when a workspace is actually dirty (unmodified files never get
    // one), walks each dirty file one by one, and answers with
    // window:close-decision. Without a live renderer there is nothing that
    // could prompt or save — let the close through instead of hanging.
    if (!closeConfirmed && rendererLive && mainWindow) {
      event.preventDefault()
      // A quit (tray 退出应用 / Cmd+Q) can arrive while the window is parked
      // hidden in the tray: the prompt must be on screen to be answerable.
      if (!mainWindow.isVisible()) mainWindow.show()
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.webContents.send('app:close-request')
      return
    }
    // Closing the editor should not tear down a working virtual-printer
    // watcher. Keep the lightweight main process in the tray so the next job
    // opens the same window without another cold start — but reset the
    // session first so no browsed document survives the window close.
    if (!quitting && watcherEnabled) {
      event.preventDefault()
      if (mainWindow) hideWindowWithFreshSession(mainWindow)
    }
  })
  mainWindow.on('resize', () => mainWindow && saveWindowState(mainWindow))
  mainWindow.on('move', () => mainWindow && saveWindowState(mainWindow))
  mainWindow.on('maximize', () => mainWindow && saveWindowState(mainWindow))
  mainWindow.on('unmaximize', () => mainWindow && saveWindowState(mainWindow))
  mainWindow.on('close', () => mainWindow && flushWindowState(mainWindow))
  mainWindow.on('closed', () => {
    mainWindow = null
    workspaceDirty = false
    closeConfirmed = false
    rendererLive = false
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    void mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }

}

async function inspectVirtualPrinter() {
  if (process.platform !== 'win32') return { installed: false as const }
  try {
    const command = `$printer = Get-Printer -Name '${VIRTUAL_PRINTER_NAME}' -ErrorAction SilentlyContinue; if ($printer) { [PSCustomObject]@{ installed = $true; portName = [string]$printer.PortName } | ConvertTo-Json -Compress } else { '{"installed":false}' }`
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true })
    const result = JSON.parse(stdout.trim()) as { installed?: unknown; portName?: unknown }
    return {
      installed: result.installed === true,
      portName: typeof result.portName === 'string' ? result.portName : undefined,
    }
  } catch {
    return { installed: false as const }
  }
}

function stopVirtualPrinterWatcher() {
  watcherEnabled = false
  inboxWatcher?.close()
  inboxWatcher = null
  if (captureTimer) clearTimeout(captureTimer)
  captureTimer = undefined
}

function signalVirtualPrintJob() {
  showMainWindow()
  const send = () => mainWindow?.webContents.send('virtual-printer:job-ready')
  if (mainWindow?.webContents.isLoadingMainFrame()) mainWindow.webContents.once('did-finish-load', send)
  else send()
}

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))

async function isCompletePdfFile(filePath: string, size: number) {
  if (size <= 10) return false
  const file = await fs.open(filePath, 'r')
  const header = Buffer.alloc(5)
  const tailLength = Math.min(size, 4096)
  const tail = Buffer.alloc(tailLength)
  try {
    await Promise.all([
      file.read(header, 0, header.length, 0),
      file.read(tail, 0, tail.length, size - tailLength),
    ])
  } finally {
    await file.close()
  }
  return hasCompletePdfMarkers(header, tail)
}

async function capturePrintOutput() {
  if (capturing) return
  capturing = true
  try {
    const outputFile = printerOutputFile()
    let previousSignature = ''
    let stableSamples = 0
    let stable = false
    for (let attempt = 0; attempt < VIRTUAL_PRINT_MAX_STABILITY_POLLS; attempt += 1) {
      const stats = await fs.stat(outputFile).catch(() => undefined)
      if (!stats) return
      const signature = `${stats.size}:${stats.mtimeMs}`
      // Count the initial snapshot as the first sample; two identical samples
      // therefore confirm stability after one short polling interval.
      stableSamples = signature === previousSignature ? stableSamples + 1 : 1
      previousSignature = signature
      if (stableSamples >= VIRTUAL_PRINT_STABLE_SAMPLES) {
        // Stable size/mtime avoids racing the spooler, while the EOF marker
        // prevents a temporarily paused partial write from being imported.
        if (await isCompletePdfFile(outputFile, stats.size)) {
          stable = true
          break
        }
        stableSamples = 0
      }
      await wait(VIRTUAL_PRINT_STABILITY_POLL_MS)
    }
    if (!stable) {
      schedulePrintCapture()
      return
    }
    const queueDirectory = printQueueDirectory()
    await fs.mkdir(queueDirectory, { recursive: true })
    const queuedFile = path.join(queueDirectory, `${Date.now()}-${randomUUID()}.pdf`)
    try {
      await fs.rename(outputFile, queuedFile)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
      await fs.copyFile(outputFile, queuedFile)
      await fs.unlink(outputFile)
    }
    signalVirtualPrintJob()
  } catch (error) {
    console.error('Virtual printer capture failed:', error)
    schedulePrintCapture()
  } finally {
    capturing = false
  }
}

function schedulePrintCapture() {
  if (!watcherEnabled) return
  if (captureTimer) clearTimeout(captureTimer)
  captureTimer = setTimeout(() => {
    captureTimer = undefined
    void capturePrintOutput()
  }, VIRTUAL_PRINT_CAPTURE_DEBOUNCE_MS)
}

async function startVirtualPrinterWatcher() {
  stopVirtualPrinterWatcher()
  const inbox = path.dirname(printerOutputFile())
  await fs.mkdir(inbox, { recursive: true })
  await fs.mkdir(printQueueDirectory(), { recursive: true })
  inboxWatcher = watch(inbox, { persistent: true }, (_event, filename) => {
    if (!filename || filename.toLowerCase() === path.basename(printerOutputFile()).toLowerCase()) schedulePrintCapture()
  })
  watcherEnabled = true
  ensureTray()
  schedulePrintCapture()
}

function ensureVirtualPrinterReady() {
  virtualPrinterReady ??= (async () => {
    const printer = await inspectVirtualPrinter()
    printerInstalled = printer.installed
    detectedPrinterPort = printer.portName
    if (printerInstalled) {
      await startVirtualPrinterWatcher().catch((error) => console.error('Virtual printer watcher failed:', error))
    }
    return printerInstalled
  })()
  return virtualPrinterReady
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) app.quit()
app.on('second-instance', (_event, argv, workingDirectory) => {
  showMainWindow()
  // A double-clicked document while we are already running: the new process
  // hands us its argv and quits; open the file in the existing window.
  const requested = extractOpenFileArg(argv, workingDirectory)
  if (requested) deliverOpenFile(requested)
})

// Taskbar grouping, jump lists and notifications key off the AppUserModelID;
// without it Windows falls back to Electron's generic identity.
app.setAppUserModelId('studio.paperwork.pdf')

app.whenReady().then(async () => {
  // The renderer provides the compact Paperwork title bar. Removing Electron's
  // generic File/Edit/View/Window/Help menu avoids duplicate and dead actions.
  Menu.setApplicationMenu(null)
  const printerReady = ensureVirtualPrinterReady()
  if (backgroundMode) {
    if (!await printerReady) app.quit()
    else createWindow(false)
  } else {
    // The printer probe launches PowerShell and may take hundreds of milliseconds.
    // Load the UI immediately; the renderer's status request shares this promise.
    createWindow(true)
    // A document passed on our own command line (file association / Open with).
    const requested = extractOpenFileArg(process.argv)
    if (requested) deliverOpenFile(requested)
  }
  app.on('activate', () => BrowserWindow.getAllWindows().length || createWindow())
})

// The renderer subscribes to files:open-requested after React mounts, which is
// later than did-finish-load; it pings us when the listener is actually up.
ipcMain.on('app:renderer-ready', sendPendingOpenFile)

// The renderer acks a delivered token once its handler owns it; only then
// does the resend loop stop. Duplicate deliveries share the token and are
// deduped renderer-side, so repeats are harmless.
ipcMain.on('files:open-ack', (_event, acked: unknown) => {
  if (typeof acked === 'string' && acked === pendingOpenToken) pendingOpenToken = undefined
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && !watcherEnabled) app.quit()
})

app.on('before-quit', () => {
  quitting = true
})

// Teardown lives in will-quit, not before-quit: the renderer's close guard
// can preventDefault the window close, which aborts the whole quit — tearing
// down the watcher/tray in before-quit would strand the app half-dead when
// the user cancels the save prompt.
app.on('will-quit', () => {
  stopVirtualPrinterWatcher()
  void ocrWorker?.terminate()
  ocrWorker = undefined
  rejectPendingOcrRequests(new Error('应用正在退出'))
  tray?.destroy()
  tray = null
})

ipcMain.handle('virtual-printer:status', async () => {
  await ensureVirtualPrinterReady()
  return {
    supported: process.platform === 'win32',
    installed: printerInstalled,
    printerName: VIRTUAL_PRINTER_NAME,
    portName: detectedPrinterPort,
  }
})

ipcMain.on('window:minimize', (event) => BrowserWindow.fromWebContents(event.sender)?.minimize())
ipcMain.on('window:toggle-maximize', (event) => {
  const window = BrowserWindow.fromWebContents(event.sender)
  if (!window) return
  window.isMaximized() ? window.unmaximize() : window.maximize()
})
ipcMain.on('window:close', (event) => BrowserWindow.fromWebContents(event.sender)?.close())
ipcMain.on('workspace:dirty-changed', (_event, dirty: unknown) => {
  workspaceDirty = dirty === true
  // New edits after a confirmed close invalidate the confirmation.
  if (workspaceDirty) closeConfirmed = false
})
ipcMain.on('window:close-decision', (event, proceed: unknown) => {
  if (proceed !== true) {
    // The user cancelled the save prompt, which also aborted any in-flight
    // quit (our preventDefault cancels it) — restore tray-hide semantics so
    // the next close parks the window again instead of quitting outright.
    quitting = false
    return
  }
  closeConfirmed = true
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win && !win.isDestroyed()) win.close()
})
ipcMain.on('clipboard:write-internal-token', (_event, token: unknown) => {
  if (typeof token !== 'string' || !token.startsWith('paperwork:') || token.length > 160) return
  clipboard.writeBuffer(INTERNAL_CLIPBOARD_FORMAT, Buffer.from(token, 'utf8'))
})
ipcMain.on('clipboard:read-internal-token', (event) => {
  event.returnValue = clipboard.readBuffer(INTERNAL_CLIPBOARD_FORMAT).toString('utf8')
})
ipcMain.on('app:session-reset-done', () => sessionResetResolve?.())

ipcMain.handle('virtual-printer:take-jobs', async (_event, excludedIds: unknown = []) => {
  if (!Array.isArray(excludedIds) || !excludedIds.every(id => typeof id === 'string')) throw new Error('无效的打印任务编号')
  const excluded = new Set(excludedIds)
  const directory = printQueueDirectory()
  await fs.mkdir(directory, { recursive: true })
  const id = (await fs.readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.endsWith('.pdf') && !excluded.has(entry.name))
    .map(entry => entry.name).sort()[0]
  if (!id) return []
  const filePath = path.join(directory, id)
  const file = await desktopFileFromPath(filePath)
  return [{
    ...file,
    id,
    name: `打印任务-${id.slice(0, 13)}.pdf`,
  }]
})

ipcMain.handle('virtual-printer:ack-jobs', async (_event, ids: unknown) => {
  if (!Array.isArray(ids) || !ids.every(id => typeof id === 'string' && path.basename(id) === id && id.endsWith('.pdf'))) throw new Error('无效的打印任务编号')
  const directory = printQueueDirectory()
  for (const id of ids) {
    try { await fs.unlink(path.join(directory, id)) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
})

ipcMain.handle('files:open', async (_event, options?: { pdfOnly?:boolean; maxReadBytes?:number; images?: boolean; documents?: boolean; multiple?: boolean }) => {
  const extensions = options?.pdfOnly ? ['pdf'] : ['pdf','ofd']
  if (!options?.pdfOnly && options?.images) extensions.push('png', 'jpg', 'jpeg')
  if (!options?.pdfOnly && options?.documents) extensions.push('doc', 'docx')
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: options?.multiple ? ['openFile', 'multiSelections'] : ['openFile'],
    filters: [{
      name: options?.pdfOnly ? 'PDF 文档' : options?.documents ? 'PDF、OFD、图片与 Word 文档' : options?.images ? 'PDF、OFD 与图片' : 'PDF 与 OFD 文档',
      extensions,
    }],
  })
  if (result.canceled) return []
  if(options?.maxReadBytes && (await Promise.all(result.filePaths.map(p=>fs.stat(p)))).some(s=>s.size>options.maxReadBytes!))throw Error('所选 PDF 超过压缩上限 96 MiB，未读取内容。')
  if(options?.pdfOnly && result.filePaths.some(v=>path.extname(v).toLowerCase()!=='.pdf'))throw Error('请选择 PDF 文件')
  return Promise.all(result.filePaths.map((filePath) => ['.doc', '.docx'].includes(path.extname(filePath).toLowerCase())
    ? convertWordToPdfDesktopFile(filePath)
    : desktopFileFromPath(filePath)))
})

ipcMain.handle('files:open-pdf-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory'] })
  if (result.canceled || !result.filePaths[0]) return []

  const directory = path.normalize(result.filePaths[0])
  if (!path.isAbsolute(directory) || !(await fs.stat(directory)).isDirectory()) {
    throw new Error('The selected path is not a directory')
  }

  const entries = (await fs.readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && ['.pdf','.ofd'].includes(path.extname(entry.name).toLowerCase()))
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' }))

  const files = []
  // Read sequentially: Promise.all would temporarily hold every Buffer plus every Uint8Array.
  for (const entry of entries) files.push(await desktopFileFromPath(path.join(directory, entry.name)))
  return files
})

ipcMain.handle('files:open-pdf-files-for-print', async (_event, multiple = true) => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: multiple ? ['openFile', 'multiSelections'] : ['openFile'],
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  })
  if (result.canceled) return []
  return Promise.all(result.filePaths.map((filePath) => printPdfReferenceFromPath(filePath)))
})

ipcMain.handle('files:open-pdf-folder-for-print', async () => {
  const result = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory'] })
  if (result.canceled || !result.filePaths[0]) return []

  const directory = path.normalize(result.filePaths[0])
  if (!path.isAbsolute(directory) || !(await fs.stat(directory)).isDirectory()) {
    throw new Error('The selected path is not a directory')
  }
  const entries = (await fs.readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === '.pdf')
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' }))

  const files = []
  for (const entry of entries) files.push(await printPdfReferenceFromPath(path.join(directory, entry.name)))
  return files
})

ipcMain.handle('files:read-pdf-for-print', async (_event, filePath: unknown) => {
  const normalizedPath = validatePrintPdfPath(filePath)
  return desktopFileFromPath(normalizedPath)
})

ipcMain.handle('files:open-path', async (_event, token: unknown) => {
  if (typeof token !== 'string') throw new Error('Token must be a string')
  // One-shot: only tokens main itself offered via files:open-requested resolve,
  // and only once. This keeps the handler from becoming an arbitrary file read.
  const filePath = openableExternalPaths.get(token)
  if (!filePath) throw new Error('Path was not offered to this window')
  openableExternalPaths.delete(token)
  return desktopFileFromPath(filePath)
})

ipcMain.handle('files:show-item-in-folder', async (_event, filePath: unknown) => {
  if (typeof filePath !== 'string' || !filePath.trim() || !path.isAbsolute(filePath)) return false
  try {
    await fs.access(filePath)
    shell.showItemInFolder(path.normalize(filePath))
    return true
  } catch {
    return false
  }
})

ipcMain.handle('shell:open-external', async (_event, rawUrl: unknown) => {
  if (typeof rawUrl !== 'string') return false
  const url = new URL(rawUrl)
  if (url.protocol !== 'https:') return false
  await shell.openExternal(url.toString())
  return true
})

ipcMain.handle('files:save', async (_event, payload: { bytes: Uint8Array; suggestedName: string; createOnly?: boolean }) => {
  const result = await dialog.showSaveDialog(mainWindow!, {
    defaultPath: payload.suggestedName,
    filters: [{ name: 'PDF 文档', extensions: ['pdf'] }],
  })
  if (result.canceled || !result.filePath) return null
  const target = /\.pdf$/i.test(result.filePath) ? result.filePath : `${result.filePath}.pdf`
  await fs.writeFile(target, Buffer.from(payload.bytes), { flag: payload.createOnly ? 'wx' : 'w' })
  return target
})

ipcMain.handle('files:save-export', async (_event, payload: {
  bytes: Uint8Array
  suggestedName: string
  format: ExportFileFormat
}) => {
  const profile = exportFormats[payload.format]
  if (!profile) throw new Error('Unsupported export format')
  const result = await dialog.showSaveDialog(mainWindow!, {
    defaultPath: safeExportName(payload.suggestedName, payload.format),
    filters: [{ name: profile.label, extensions: [profile.extension] }],
  })
  if (result.canceled || !result.filePath) return null
  const selectedExtension = path.extname(result.filePath).toLowerCase()
  const hasExpectedExtension = selectedExtension === `.${profile.extension}`
    || payload.format === 'jpeg' && selectedExtension === '.jpeg'
  const target = hasExpectedExtension
    ? result.filePath
    : `${result.filePath}.${profile.extension}`
  await fs.writeFile(target, Buffer.from(payload.bytes))
  return target
})

ipcMain.handle('files:overwrite-pdf', async (_event, payload: { bytes: Uint8Array; filePath: string }) => {
  if (typeof payload.filePath !== 'string' || !path.isAbsolute(payload.filePath) || path.extname(payload.filePath).toLowerCase() !== '.pdf') {
    throw new Error('只能保存到已打开的本地 PDF 文件')
  }
  const filePath = path.normalize(payload.filePath)
  // Write-then-rename so a crash mid-write can never leave a truncated file
  // where the user's original document was.
  const tempPath = `${filePath}.tmp-${process.pid}`
  try {
    await fs.writeFile(tempPath, Buffer.from(payload.bytes))
    await fs.rename(tempPath, filePath)
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined)
    throw error
  }
  return filePath
})

ipcMain.handle('files:saveMany', async (_event, payload: { files: { name: string; bytes: Uint8Array }[] }) => {
  const result = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory', 'createDirectory'] })
  if (result.canceled || !result.filePaths[0]) return null
  const targets = payload.files.map((file, index) => path.join(result.filePaths[0], path.basename(file.name.trim()) || `Paperwork-export-${index + 1}`))
  if (new Set(targets.map(p => p.toLocaleLowerCase())).size !== targets.length || targets.some(p => existsSync(p))) {
    throw new Error('导出目标已有同名文件或清单中存在重名项，请选择空文件夹。')
  }
  for (const [i, file] of payload.files.entries()) await fs.writeFile(targets[i], Buffer.from(file.bytes), { flag: 'wx' })
  return result.filePaths[0]
})

ipcMain.handle('print:get-printers', async () => {
  if (!mainWindow || mainWindow.isDestroyed()) return []
  return (await mainWindow.webContents.getPrintersAsync()).map((printer) => ({
    name: printer.name,
    displayName: printer.displayName,
    description: printer.description || undefined,
    status: printer.status,
    isDefault: printer.isDefault,
  }))
})

ipcMain.handle('pdf-passwords:load', () => readPdfPasswordHistory())
ipcMain.handle('pdf-passwords:remember', async (_event, raw: unknown) => {
  if (!raw || typeof raw !== 'object') return readPdfPasswordHistory()
  const input = raw as Record<string, unknown>
  const password = typeof input.password === 'string' ? input.password.slice(0, 512) : ''
  const documentName = safePasswordDocumentName(input.fileName)
  const fingerprint = typeof input.fingerprint === 'string' ? input.fingerprint.slice(0, 256) : undefined
  if (!password || !documentName) return readPdfPasswordHistory()
  const now = new Date().toISOString()
  const entries = await readPdfPasswordHistory()
  const previous = entries.find((entry) => entry.password === password)
  const next: PdfPasswordHistoryEntry = previous
    ? {
        ...previous,
        documents: [documentName, ...previous.documents.filter((name) => name !== documentName)]
          .slice(0, PDF_PASSWORD_DOCUMENT_LIMIT),
        fingerprint: fingerprint ?? previous.fingerprint,
        lastUsedAt: now,
      }
    : {
        id: randomUUID(),
        password,
        documents: [documentName],
        fingerprint,
        createdAt: now,
        lastUsedAt: now,
      }
  const updated = [next, ...entries.filter((entry) => entry.id !== next.id)]
    .slice(0, PDF_PASSWORD_HISTORY_LIMIT)
  await writePdfPasswordHistory(updated)
  return updated
})
ipcMain.handle('pdf-passwords:remove', async (_event, id: unknown) => {
  if (typeof id !== 'string') return readPdfPasswordHistory()
  const updated = (await readPdfPasswordHistory()).filter((entry) => entry.id !== id)
  await writePdfPasswordHistory(updated)
  return updated
})
ipcMain.handle('pdf-passwords:clear', async () => {
  await writePdfPasswordHistory([])
  return []
})

ipcMain.handle('ocr:status', () => getOcrStatus())
ipcMain.handle('ocr:capabilities', () => getOcrCapabilities())
ipcMain.handle('ocr:recognize-page', (_event, payload: unknown) => recognizeOcrPageInWorker(payload))
ipcMain.handle('ocr:test-connection', async (_event, provider: unknown, settings: unknown) => {
  if (provider === 'local') {
    const status = await getOcrStatus()
    return { ok: status.available, message: status.available ? `${status.model} 本地模型可用` : status.error || '本地模型缺失' }
  }
  if (provider !== 'tencent' && provider !== 'custom') return { ok: false, message: '不支持的 OCR 服务' }
  return testOcrConnection(provider, settings && typeof settings === 'object' ? settings : {})
})
ipcMain.handle('ocr:load-secrets', async () => {
  if (!safeStorage.isEncryptionAvailable()) return {}
  try {
    const payload = JSON.parse(await fs.readFile(path.join(app.getPath('userData'), 'ocr-secrets.json'), 'utf8')) as { encrypted?: string }
    if (!payload.encrypted) return {}
    return JSON.parse(safeStorage.decryptString(Buffer.from(payload.encrypted, 'base64')))
  } catch {
    return {}
  }
})
ipcMain.handle('ocr:save-secrets', async (_event, raw: unknown) => {
  if (!safeStorage.isEncryptionAvailable() || !raw || typeof raw !== 'object') return false
  const input = raw as Record<string, unknown>
  const string = (value: unknown, max = 512) => typeof value === 'string' ? value.slice(0, max) : ''
  const secrets = {
    tencent: { secretId: string(input.secretId), secretKey: string(input.secretKey) },
    custom: { apiKey: string(input.apiKey) },
  }
  const encrypted = safeStorage.encryptString(JSON.stringify(secrets)).toString('base64')
  await fs.writeFile(path.join(app.getPath('userData'), 'ocr-secrets.json'), JSON.stringify({ encrypted }), { mode: 0o600 })
  return true
})

ipcMain.handle('seals:list', async () => (await getSealInventory()).list())
ipcMain.handle('seals:import', async () => {
  if (!mainWindow || mainWindow.isDestroyed()) return null
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: '电子章图片', extensions: ['png', 'jpg', 'jpeg'] }],
  })
  const filePath = result.filePaths[0]
  if (result.canceled || !filePath) return null
  const normalized = path.normalize(filePath)
  const extension = path.extname(normalized).toLowerCase()
  if (!['.png', '.jpg', '.jpeg'].includes(extension)) throw new Error('仅支持 PNG 或 JPEG 电子章图片')
  const stats = await fs.stat(normalized)
  if (!stats.isFile()) throw new Error('电子章路径不是文件')
  return (await getSealInventory()).import({
    bytes: new Uint8Array(await fs.readFile(normalized)),
    fileName: path.basename(normalized),
    name: path.basename(normalized, extension),
    sourcePath: normalized,
  })
})
ipcMain.handle('seals:read', async (_event, id: unknown) => {
  if (typeof id !== 'string') return null
  return (await getSealInventory()).read(id)
})
ipcMain.handle('seals:update', async (_event, id: unknown, patch: unknown) => {
  if (typeof id !== 'string' || !patch || typeof patch !== 'object') return null
  const value = patch as Record<string, unknown>
  return (await getSealInventory()).update(id, {
    name: typeof value.name === 'string' ? value.name : undefined,
    notes: typeof value.notes === 'string' ? value.notes : undefined,
  })
})
ipcMain.handle('seals:delete', async (_event, id: unknown) => {
  if (typeof id !== 'string') return false
  return (await getSealInventory()).remove(id)
})
ipcMain.handle('seals:inspect-pdf', async (_event, bytes: unknown) => {
  if (!(bytes instanceof Uint8Array)) throw new Error('签名检查需要 PDF 字节数据')
  if (!bytes.length || bytes.length > 1024 * 1024 * 1024) throw new Error('PDF 文件大小无效')
  const { inspectPdfSignatures } = await import('./electronicSeals')
  return inspectPdfSignatures(bytes)
})

ipcMain.handle('print:pages', async (_event, payload: {
  pages: { widthPt: number; heightPt: number; png: Uint8Array }[]
  copies: number
  duplex: string
  landscape: boolean
  collate: boolean
  pagesPerSheet: number
  scaleFactor: number
  color: boolean
  deviceName?: string
  margins: 'default' | 'none' | 'printableArea'
  paperSize?: 'auto' | 'a4' | 'a5' | 'b5' | 'letter' | 'legal'
  pageBorder?: boolean
}) => {
  // Pages arrive pre-rasterized by the renderer (white-composited PNG per
  // page). Printing plain DOM images sidesteps Chromium's PDF-viewer print
  // path, which re-encodes subset CJK fonts through GDI (garbled glyphs on
  // many drivers) and renders all-black from a hidden window (plugin race).
  const pages = Array.isArray(payload.pages) ? payload.pages : []
  if (!pages.length || pages.length > 5000) throw new Error('打印页面数量无效')
  for (const page of pages) {
    const valid = page && page.png instanceof Uint8Array && page.png.length > 0
      && page.png.length <= 64 * 1024 * 1024
      && Number.isFinite(page.widthPt) && Number.isFinite(page.heightPt)
      && page.widthPt > 0 && page.heightPt > 0
    if (!valid) throw new Error('打印页面数据无效')
  }
  const scalePercent = Number.isFinite(payload.scaleFactor)
    ? Math.min(150, Math.max(50, Number(payload.scaleFactor)))
    : 100
  const marginType = ['default', 'none', 'printableArea'].includes(payload.margins)
    ? payload.margins
    : 'default'
  // Chrome-style default ("fit to printable area"): keep a small safety inset
  // inside the exact-size sheet so physical printers never clip page edges.
  // 'printableArea' and 'none' opt into full-bleed output instead.
  const safeInsetPx = marginType === 'default' ? 16 : 0
  // Standard sheet dimensions in PDF points for the 纸张大小 option. 'auto'
  // keeps every PDF page's own size (the pre-existing behavior); a fixed size
  // makes every sheet uniform and lets object-fit scale the content.
  const PAPER_SIZES_PT: Record<string, [number, number]> = {
    a4: [595.28, 841.89],
    a5: [419.53, 595.28],
    b5: [498.9, 708.66],
    letter: [612, 792],
    legal: [612, 1008],
  }
  // hasOwn: a plain-object lookup would also match prototype members
  // ('constructor', '__proto__', …), turning junk input into a TypeError
  // instead of the 'auto' fallback.
  const fixedPaper = typeof payload.paperSize === 'string' && Object.hasOwn(PAPER_SIZES_PT, payload.paperSize)
    ? PAPER_SIZES_PT[payload.paperSize]
    : undefined
  const pageBorder = payload.pageBorder === true
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'paperwork-print-'))
  const printWindow = new BrowserWindow({
    show: false,
    // Hidden windows skip painting by default; force it so the compositor has
    // real frames for the spooler (hidden-window prints can come out black).
    paintWhenInitiallyHidden: true,
    webPreferences: { backgroundThrottling: false },
  })
  try {
    const sections: string[] = []
    const rules: string[] = []
    for (let index = 0; index < pages.length; index += 1) {
      const page = pages[index]
      const file = `page-${index}.png`
      await fs.writeFile(path.join(tempDir, file), Buffer.from(page.png))
      // Bake orientation into the sheet size so the landscape flag cannot
      // double-rotate already-landscape pages at the driver level.
      let widthPt: number
      let heightPt: number
      if (fixedPaper) {
        // Uniform sheets: orientation applies to the chosen paper, content
        // fits inside via object-fit regardless of the source page's shape.
        const rotateSheet = payload.landscape === true && fixedPaper[1] > fixedPaper[0]
        widthPt = rotateSheet ? fixedPaper[1] : fixedPaper[0]
        heightPt = rotateSheet ? fixedPaper[0] : fixedPaper[1]
      } else {
        const swap = payload.landscape === true && page.heightPt > page.widthPt
        widthPt = swap ? page.heightPt : page.widthPt
        heightPt = swap ? page.widthPt : page.heightPt
      }
      rules.push(`@page p${index} { size: ${widthPt.toFixed(2)}pt ${heightPt.toFixed(2)}pt; margin: 0 }`)
      sections.push(`<section class="page" style="page: p${index}; padding: ${safeInsetPx}px"><img src="${file}" alt="" style="max-width: ${scalePercent}%; max-height: ${scalePercent}%"></section>`)
    }
    const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Paperwork PDF Studio 打印</title><style>
html, body { margin: 0; padding: 0; background: #ffffff }
.page { width: 100vw; height: 100vh; box-sizing: border-box; page-break-after: always; display: flex; align-items: center; justify-content: center; overflow: hidden }
.page:last-of-type { page-break-after: auto }
.page img { display: block; object-fit: contain }
${pageBorder ? '.page img { outline: 0.75pt solid #9aa0a6; outline-offset: -0.75pt }' : ''}
${rules.join('\n')}
</style></head><body>
${sections.join('\n')}
</body></html>`
    await fs.writeFile(path.join(tempDir, 'print.html'), html)
    await printWindow.loadURL(pathToFileURL(path.join(tempDir, 'print.html')).toString())
    // Images are regular DOM content; decode them all before spooling so no
    // page can be captured blank.
    await printWindow.webContents.executeJavaScript(
      'Promise.all([...document.images].map((img) => img.decode().catch(() => undefined))).then(() => true)',
    )
    await new Promise<void>((resolve, reject) => {
      const deviceName = typeof payload.deviceName === 'string' && payload.deviceName.trim()
        ? payload.deviceName
        : undefined
      printWindow.webContents.print({
        silent: Boolean(deviceName),
        deviceName,
        copies: payload.copies,
        duplexMode: payload.duplex as 'simplex' | 'shortEdge' | 'longEdge',
        landscape: false,
        collate: payload.collate,
        pagesPerSheet: payload.pagesPerSheet,
        scaleFactor: 100,
        color: payload.color,
        margins: { marginType },
        printBackground: true,
      }, (success, reason) => success ? resolve() : reject(new Error(reason)))
    })
    return true
  } finally {
    printWindow.destroy()
    void fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
  }
})
