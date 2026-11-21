import { invoke, type InvokeArgs, type InvokeOptions } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { nativeFeatures } from './features'

type Desktop = NonNullable<Window['desktop']>
type Reference = Omit<DesktopFile, 'bytes' | 'size'> & { token: string; size: number }
type Ticket = { token: string; path: string }
type OpenRequest = { path: string; token: string }
type NativeDrop = { files: Reference[]; x: number; y: number }
const CHUNK = 16 * 1024 * 1024
const byPath = new Map<string, Reference>()
// Each live document owns its read revision. Saving a second tab with the same
// path must not grant another tab the right to overwrite that newer revision.
const revisions = new Map<string, Reference>()
const droppedPaths = new WeakMap<File, string>()
const pathKey = (path: string) => /^([A-Za-z]:[\\/]|\\\\)/.test(path) ? path.replaceAll('/', '\\').toLowerCase() : path
const folderSort = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

// Tauri rejects with strings; the existing editor expects Error.message for its user-facing feedback.
async function call<T>(command: string, args?: InvokeArgs, options?: InvokeOptions): Promise<T> {
  try { return await invoke<T>(command, args, options) }
  catch (error) { throw error instanceof Error ? error : new Error(String(error)) }
}
function background(promise: Promise<unknown>) { void promise.catch((error) => console.error('[Paperwork desktop]', error)) }
function remember(ref: Reference) {
  if (ref.path) byPath.set(pathKey(ref.path), ref)
  return ref
}
function granted(path: string) {
  const ref = byPath.get(pathKey(path))
  if (!ref) throw new Error('文件授权已失效，请重新打开文件。')
  return ref
}
async function read(ref: Reference): Promise<DesktopFile> {
  const { token, ...metadata } = remember(ref)
  const file: Omit<DesktopFile, 'bytes'> = { ...metadata, desktopGrant: ref.type === 'pdf' && ref.path ? token : undefined }
  if (file.desktopGrant) revisions.set(token, ref)
  if (!Number.isSafeInteger(ref.size) || ref.size < 0) throw new Error('文件大小无效。')
  if (ref.type === 'msg' && (!ref.size || ref.size > 32 * 1024 * 1024)) throw new Error('MSG 邮件为空或超过 32 MiB。')
  const piece = async (offset: number, length: number) => {
    const buffer = await call<ArrayBuffer>('read_granted', { token, offset, length })
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== length) throw new Error('文件读取不完整，请重新打开。')
    return new Uint8Array(buffer)
  }
  try {
    if (ref.size <= CHUNK) return { ...file, bytes: await piece(0, ref.size) }
    // One final buffer plus one bounded IPC chunk; not an array of full files or JSON numbers.
    const bytes = new Uint8Array(ref.size)
    for (let offset = 0; offset < ref.size; offset += CHUNK) {
      bytes.set(await piece(offset, Math.min(CHUNK, ref.size - offset)), offset)
    }
    return { ...file, bytes }
  } finally {
    // Converted Word references have no local source to reveal or overwrite. Release their temp files now.
    if (!ref.path) background(call('release_document', { token }))
  }
}
async function readSequential(refs: Reference[]) {
  const files: DesktopFile[] = []
  for (const ref of refs) files.push(await read(ref))
  return files
}
async function pick(mode: 'open' | 'folder' | 'print' | 'printFolder', options?: Parameters<Desktop['openFiles']>[0]) {
  const refs = await call<Reference[]>('pick_documents', { mode, multiple: options?.multiple??false, pdfOnly:options?.pdfOnly??false, images:options?.images??false, documents:options?.documents??false })
  if (mode === 'folder' || mode === 'printFolder') refs.sort((a, b) => folderSort.compare(a.name, b.name))
  return refs.map(remember)
}
function printReference(ref: Reference): PrintPdfFileReference {
  return { path: ref.path, name: ref.name, size: ref.size, modifiedAt: ref.modifiedAt ?? '', createdAt: ref.createdAt ?? '', accessedAt: ref.accessedAt ?? '' }
}
async function write(ticket: Ticket, bytes: Uint8Array, originalGrant?: string) {
  const ref = await call<Reference | null>('write_granted', bytes, { headers: { 'x-paperwork-ticket': ticket.token } })
  if (ref) {
    remember(ref)
    if (originalGrant) revisions.set(originalGrant, ref)
  }
  return ticket.path
}
async function saveAs(bytes: Uint8Array, name: string, format: ExportFileFormat, createOnly = false) {
  const ticket = await call<Ticket | null>('choose_save', { name, format, createOnly })
  return ticket ? write(ticket, bytes) : null
}

// A native drop is routed to the same visible workspace as the browser version, not always to the reader.
// PDF-page image insertion and thumbnail replacement need a real File and the original hit coordinates.
async function dispatchDrop({ files: refs, x, y }: NativeDrop) {
  if (!refs.length || document.querySelector('[aria-modal="true"]')) return
  const clientX = x, clientY = y // Rust already converted the native device pixels to CSS coordinates.
  const target = document.elementFromPoint(clientX, clientY)
  const shell = target?.closest('.app-shell:not([hidden])') ?? document.querySelector('.app-shell:not([hidden])')
  if (!shell) return
  const specialized = target?.closest('.thumbnail') || (target?.closest('.pdf-page') && refs.some((ref) => ref.type === 'image'))
  const files = await readSequential(refs)
  if (target?.isConnected && specialized) {
    const transfer = new DataTransfer()
    for (const item of files) {
      const type = item.type === 'image' ? (/\.png$/i.test(item.name) ? 'image/png' : 'image/jpeg') : item.type === 'ofd' ? 'application/ofd' : item.type === 'msg' ? 'application/vnd.ms-outlook' : 'application/pdf'
      const file = new File([item.bytes], item.name, { type, lastModified: item.modifiedAt ? Date.parse(item.modifiedAt) : undefined })
      transfer.items.add(file)
      droppedPaths.set(file, item.path)
      droppedPaths.set(transfer.files[transfer.files.length - 1], item.path)
    }
    if (!target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX, clientY, dataTransfer: transfer }))) return
  }
  shell.dispatchEvent(new CustomEvent('paperwork-native-drop', { detail: files, bubbles: true, cancelable: true }))
}

export async function installTauriDesktop(): Promise<void> {
  if (window.desktop) return
  const currentWindow = getCurrentWindow()
  const openCallbacks = new Set<(path: string, token: string) => void>()
  const closeCallbacks = new Set<() => void>()
  const resetCallbacks = new Set<() => void>()
  let drops = Promise.resolve()
  const subscribe = <T>(callbacks: Set<T>, cb: T) => { callbacks.add(cb); return () => { callbacks.delete(cb) } }
  const fetchPending = async () => {
    if (!openCallbacks.size) return // React will pull again once its listener has mounted.
    for (const { path, token } of await call<OpenRequest[]>('take_pending_opens')) {
      for (const cb of openCallbacks) cb(path, token)
    }
  }
  function fileError(message: unknown) {
    const shell = document.querySelector('.app-shell:not([hidden])')
    if (!shell) return
    shell.querySelector('[data-native-file-error]')?.remove()
    const toast = document.createElement('div')
    toast.className = 'toast'; toast.dataset.nativeFileError = ''; toast.setAttribute('role', 'alert')
    toast.textContent = message instanceof Error ? message.message : String(message)
    shell.append(toast)
    window.setTimeout(() => toast.remove(), 6000)
  }
  // Toolbar and empty-state pickers treat an empty selection as a no-op. Report native I/O/Word conversion
  // failures here as well, rather than letting an async click handler discard the only error message.
  async function fromPicker<T>(action: () => Promise<T[]>): Promise<T[]> {
    try { return await action() }
    catch (error) { fileError(error); return [] }
  }
  // Subscribe before mounting React; the native queue also covers cold start and StrictMode remounts.
  await Promise.all([
    listen('paperwork-open-available', () => background(fetchPending())),
    listen<NativeDrop>('paperwork-drop', ({ payload }) => { drops = drops.then(() => dispatchDrop(payload)).catch(fileError) }),
    listen<string>('paperwork-file-error', ({ payload }) => fileError(payload)),
    listen('paperwork-close-request', () => { for (const cb of closeCallbacks) cb() }),
    listen('paperwork-session-reset', () => { for (const cb of resetCallbacks) cb() }),
  ])
  // ClipboardEvent is synchronous, unlike Tauri IPC. Use a private clipboard format without exposing a text marker.
  const mime = 'application/x-paperwork-internal'
  let copying = '', clipboardToken = ''
  window.addEventListener('copy', (event) => {
    if (!copying || !event.clipboardData) { clipboardToken = ''; return }
    event.clipboardData.setData(mime, copying)
    event.preventDefault(); event.stopImmediatePropagation()
  }, true)
  window.addEventListener('paste', (event) => {
    // A non-empty nonmatching token distinguishes an external paste from the browser-only in-memory fallback.
    clipboardToken = event.clipboardData?.getData(mime) || 'external-clipboard'
  }, true)
  window.desktop = {
    ...nativeFeatures,
    minimizeWindow: () => background(currentWindow.minimize()),
    toggleMaximizeWindow: () => background(currentWindow.toggleMaximize()),
    closeWindow: () => background(currentWindow.close()),
    writeInternalClipboardToken: (token) => {
      if (!/^paperwork:(?:pages|annotations):[\w-]+$/.test(token) || token.length > 160) return
      copying = token
      try { if (document.execCommand('copy')) clipboardToken = token }
      finally { copying = '' }
    },
    readInternalClipboardToken: () => clipboardToken,
    openFiles: (options) => fromPicker(async () => {
      const refs=await pick('open',options)
      if(options?.maxReadBytes && refs.some(ref=>ref.size>options.maxReadBytes!))throw new Error('所选 PDF 超过压缩上限 96 MiB，未读取内容。')
      return readSequential(refs)
    }),
    openPdfFolder: () => fromPicker(async () => readSequential(await pick('folder'))),
    openPdfFilesForPrint: (multiple = true) => fromPicker(async () => (await pick('print', { multiple })).map(printReference)),
    openPdfFolderForPrint: () => fromPicker(async () => (await pick('printFolder')).map(printReference)),
    readPdfFileForPrint: async (path) => read(granted(path)),
    readFileAtPath: async (token) => read(await call<Reference>('claim_open', { token })),
    onOpenFileRequested: (callback) => subscribe(openCallbacks, callback),
    acknowledgeOpenFile: (token) => background(call('acknowledge_open', { token })),
    notifyRendererReady: () => background(fetchPending()),
    getPathForFile: (file) => droppedPaths.get(file) ?? '',
    showItemInFolder: async (path) => { const ref = byPath.get(pathKey(path)); return ref ? call<boolean>('reveal_document', { token: ref.token }) : false },
    openExternal: (url) => call('open_external', { url }),
    pdfMcp:{
      listen(handler){let active=true;const sub=listen<import('../lib/mcpSession').McpCall>('paperwork-mcp-request',event=>{if(active)handler(event.payload)});void sub.catch(fileError);return ()=>{active=false;void sub.then(off=>off()).catch(()=>{})}},
      live:(id)=>call<boolean>('pdf_mcp_live',{id}),reply:(id,ok,value)=>call<void>('pdf_mcp_reply',{id,ok,value}),
    },
    async saveGuardedPdfCopy(bytes,name,valid){
      if(!valid())return null
      const ticket=await call<Ticket|null>('choose_save',{name,format:'pdf',createOnly:true})
      if(!ticket)return null
      if(!valid()){await call('cancel_writes',{tokens:[ticket.token]});return null}
      return write(ticket,bytes)
    },
    savePdf: (bytes, suggestedName) => saveAs(bytes, suggestedName, 'pdf'),
    savePdfCopy: (bytes, name) => saveAs(bytes, name, 'pdf', true),
    saveExport: saveAs,
    overwritePdf: async (bytes, path, originalGrant) => {
      const ref = originalGrant ? revisions.get(originalGrant) : granted(path)
      if (!ref || pathKey(ref.path) !== pathKey(path) || ref.type !== 'pdf') throw new Error('请使用“另存为”保存 PDF 副本，原件不会被覆盖。')
      return write(await call<Ticket>('prepare_overwrite', { token: ref.token }), bytes, originalGrant)
    },
    saveMany: async (files) => {
      if (!files.length) return null
      const batch = await call<{ directory: string; tickets: Ticket[] } | null>('choose_save_many', { names: files.map((f) => f.name) })
      if (!batch) return null
      let i = 0
      try {
        for (; i < files.length; i++) await write(batch.tickets[i], files[i].bytes)
        return batch.directory
      } finally {
        if (i < batch.tickets.length) background(call('cancel_writes', { tokens: batch.tickets.slice(i).map((t) => t.token) }))
      }
    },
    setWorkspaceDirty: (dirty) => background(call('workspace_dirty', { dirty })),
    onCloseRequest: (callback) => subscribe(closeCallbacks, callback),
    confirmClose: (proceed) => background(call('decide_close', { proceed })),
    onSessionReset: (callback) => subscribe(resetCallbacks, callback),
    acknowledgeSessionReset: () => background(call('session_reset_done')),
  }
}
