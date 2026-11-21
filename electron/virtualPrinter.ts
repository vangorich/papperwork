import path from 'node:path'

export const VIRTUAL_PRINTER_NAME = 'Paperwork PDF Studio'
export const VIRTUAL_PRINT_CAPTURE_DEBOUNCE_MS = 80
export const VIRTUAL_PRINT_STABILITY_POLL_MS = 80
export const VIRTUAL_PRINT_STABLE_SAMPLES = 2
export const VIRTUAL_PRINT_MAX_STABILITY_POLLS = 50

export function resolveVirtualPrinterOutputFile(userDataPath: string, portName?: string) {
  const candidate = portName?.trim()
  if (
    candidate
    && path.extname(candidate).toLowerCase() === '.pdf'
    && (path.win32.isAbsolute(candidate) || path.posix.isAbsolute(candidate))
  ) return path.normalize(candidate)
  return path.join(userDataPath, 'PrintInbox', 'PaperworkPrint.pdf')
}

export function hasCompletePdfMarkers(header: Uint8Array, tail: Uint8Array) {
  return Buffer.from(header).subarray(0, 5).toString('ascii') === '%PDF-'
    && /%%EOF[\s\0]*$/.test(Buffer.from(tail).toString('latin1'))
}
