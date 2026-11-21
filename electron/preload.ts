import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { PrintOptions } from '../src/types/pdf'

contextBridge.exposeInMainWorld('desktop', {
  minimizeWindow: () => ipcRenderer.send('window:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.send('window:toggle-maximize'),
  closeWindow: () => ipcRenderer.send('window:close'),
  writeInternalClipboardToken: (token: string) => ipcRenderer.send('clipboard:write-internal-token', token),
  readInternalClipboardToken: () => ipcRenderer.sendSync('clipboard:read-internal-token') as string,
  openFiles: (options?: { pdfOnly?:boolean; maxReadBytes?:number; images?: boolean; documents?: boolean; multiple?: boolean }) => ipcRenderer.invoke('files:open', options),
  openPdfFolder: () => ipcRenderer.invoke('files:open-pdf-folder'),
  openPdfFilesForPrint: (multiple = true) => ipcRenderer.invoke('files:open-pdf-files-for-print', multiple),
  openPdfFolderForPrint: () => ipcRenderer.invoke('files:open-pdf-folder-for-print'),
  readPdfFileForPrint: (path: string) => ipcRenderer.invoke('files:read-pdf-for-print', path),
  readFileAtPath: (token: string) => ipcRenderer.invoke('files:open-path', token),
  acknowledgeOpenFile: (token: string) => ipcRenderer.send('files:open-ack', token),
  onOpenFileRequested: (callback: (path: string, token: string) => void) => {
    const listener = (_event: unknown, payload: { token: string; path: string }) => callback(payload.path, payload.token)
    ipcRenderer.on('files:open-requested', listener)
    return () => ipcRenderer.removeListener('files:open-requested', listener)
  },
  notifyRendererReady: () => ipcRenderer.send('app:renderer-ready'),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  showItemInFolder: (path: string) => ipcRenderer.invoke('files:show-item-in-folder', path),
  openExternal: (url: string) => ipcRenderer.invoke('shell:open-external', url),
  savePdf: (bytes: Uint8Array, suggestedName: string) =>
    ipcRenderer.invoke('files:save', { bytes, suggestedName }),
  savePdfCopy: (bytes: Uint8Array, suggestedName: string) => ipcRenderer.invoke('files:save', { bytes, suggestedName, createOnly: true }),
  saveExport: (bytes: Uint8Array, suggestedName: string, format: ExportFileFormat) =>
    ipcRenderer.invoke('files:save-export', { bytes, suggestedName, format }),
  overwritePdf: (bytes: Uint8Array, filePath: string) =>
    ipcRenderer.invoke('files:overwrite-pdf', { bytes, filePath }),
  saveMany: (files: { name: string; bytes: Uint8Array }[]) =>
    ipcRenderer.invoke('files:saveMany', { files }),
  printPages: (pages: PrintPageImageInput[], options: PrintOptions) =>
    ipcRenderer.invoke('print:pages', { pages, ...options }),
  getPrinters: () => ipcRenderer.invoke('print:get-printers'),
  getOcrStatus: () => ipcRenderer.invoke('ocr:status'),
  getOcrCapabilities: () => ipcRenderer.invoke('ocr:capabilities'),
  recognizeOcrPage: (payload: OcrPageInput) => ipcRenderer.invoke('ocr:recognize-page', payload),
  testOcrConnection: (provider: 'local' | 'tencent' | 'custom', settings: unknown) =>
    ipcRenderer.invoke('ocr:test-connection', provider, settings),
  loadOcrSecrets: () => ipcRenderer.invoke('ocr:load-secrets'),
  saveOcrSecrets: (secrets: unknown) => ipcRenderer.invoke('ocr:save-secrets', secrets),
  loadPdfPasswordHistory: () => ipcRenderer.invoke('pdf-passwords:load'),
  rememberPdfPassword: (entry: { fileName: string; fingerprint?: string; password: string }) =>
    ipcRenderer.invoke('pdf-passwords:remember', entry),
  removePdfPasswordHistoryEntry: (id: string) => ipcRenderer.invoke('pdf-passwords:remove', id),
  clearPdfPasswordHistory: () => ipcRenderer.invoke('pdf-passwords:clear'),
  listElectronicSeals: () => ipcRenderer.invoke('seals:list'),
  importElectronicSeal: () => ipcRenderer.invoke('seals:import'),
  readElectronicSeal: (id: string) => ipcRenderer.invoke('seals:read', id),
  updateElectronicSeal: (id: string, patch: { name?: string; notes?: string }) => ipcRenderer.invoke('seals:update', id, patch),
  deleteElectronicSeal: (id: string) => ipcRenderer.invoke('seals:delete', id),
  inspectPdfSignatures: (bytes: Uint8Array) => ipcRenderer.invoke('seals:inspect-pdf', bytes),
  getVirtualPrinterStatus: () => ipcRenderer.invoke('virtual-printer:status'),
  takeVirtualPrintJobs: (excludedIds: readonly string[] = []) => ipcRenderer.invoke('virtual-printer:take-jobs', excludedIds),
  acknowledgeVirtualPrintJobs: (ids: string[]) => ipcRenderer.invoke('virtual-printer:ack-jobs', ids),
  onVirtualPrintJob: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on('virtual-printer:job-ready', listener)
    return () => ipcRenderer.removeListener('virtual-printer:job-ready', listener)
  },
  setWorkspaceDirty: (dirty: boolean) => ipcRenderer.send('workspace:dirty-changed', dirty),
  onCloseRequest: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on('app:close-request', listener)
    return () => ipcRenderer.removeListener('app:close-request', listener)
  },
  confirmClose: (proceed: boolean) => ipcRenderer.send('window:close-decision', proceed),
  onSessionReset: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on('app:session-reset', listener)
    return () => ipcRenderer.removeListener('app:session-reset', listener)
  },
  acknowledgeSessionReset: () => ipcRenderer.send('app:session-reset-done'),
})
