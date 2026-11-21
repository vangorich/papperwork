export {}

declare global {
  interface Window {
    desktop?: {
      minimizeWindow(): void
      toggleMaximizeWindow(): void
      closeWindow(): void
      writeInternalClipboardToken(token: string): void
      readInternalClipboardToken(): string
      openFiles(options?: { pdfOnly?:boolean; maxReadBytes?:number; images?: boolean; documents?: boolean; multiple?: boolean }): Promise<DesktopFile[]>
      openPdfFolder(): Promise<DesktopFile[]>
      openPdfFilesForPrint(multiple?: boolean): Promise<PrintPdfFileReference[]>
      openPdfFolderForPrint(): Promise<PrintPdfFileReference[]>
      readPdfFileForPrint(path: string): Promise<DesktopFile>
      /** Read the file behind a one-shot open token (file-association opens). */
      readFileAtPath(token: string): Promise<DesktopFile>
      /** Confirm the open-requested handler owns a delivered token (clears main's retry). */
      acknowledgeOpenFile(token: string): void
      /** Main pushes a document path + one-shot token from argv / second-instance. */
      onOpenFileRequested(callback: (path: string, token: string) => void): () => void
      /** Tell main the open-file listener is subscribed (flush pending argv opens). */
      notifyRendererReady(): void
      getPathForFile(file: File): string
      showItemInFolder(path: string): Promise<boolean>
      openExternal(url: string): Promise<boolean>
      pdfMcp?: import('../lib/mcpSession').McpBridge
      saveGuardedPdfCopy?(bytes:Uint8Array,name:string,valid:()=>boolean):Promise<string|null>
      savePdf(bytes: Uint8Array, suggestedName: string): Promise<string | null>
      saveExport(bytes: Uint8Array, suggestedName: string, format: ExportFileFormat): Promise<string | null>
      /** Create only: a protected or lossy copy must never replace an existing document. */
      savePdfCopy?(bytes: Uint8Array, suggestedName: string): Promise<string | null>
      overwritePdf(bytes: Uint8Array, filePath: string, originalGrant?: string): Promise<string>
      saveMany(files: { name: string; bytes: Uint8Array }[]): Promise<string | null>
      printPages(pages: PrintPageImageInput[], options: PrintOptions): Promise<boolean>
      parseOutlookMsg?(bytes: Uint8Array): Promise<import('./outlookMail').MemoMessage>
      getPrinters(): Promise<NativePrinter[]>
      getOcrStatus(): Promise<OcrStatus>
      getOcrCapabilities(): Promise<OcrCapabilities>
      recognizeOcrPage(payload: OcrPageInput): Promise<OcrRecognitionResult>
      testOcrConnection(provider: 'local' | 'tencent' | 'custom', settings: unknown): Promise<{ ok: boolean; message: string }>
      loadOcrSecrets(): Promise<{ tencent?: { secretId?: string; secretKey?: string }; custom?: { apiKey?: string } }>
      saveOcrSecrets(secrets: { secretId: string; secretKey: string; apiKey: string }): Promise<boolean>
      loadPdfPasswordHistory(): Promise<PdfPasswordHistoryEntry[]>
      rememberPdfPassword(entry: { fileName: string; fingerprint?: string; password: string }): Promise<PdfPasswordHistoryEntry[]>
      removePdfPasswordHistoryEntry(id: string): Promise<PdfPasswordHistoryEntry[]>
      clearPdfPasswordHistory(): Promise<PdfPasswordHistoryEntry[]>
      listElectronicSeals(): Promise<ElectronicSealRecord[]>
      importElectronicSeal(): Promise<ElectronicSealRecord | null>
      readElectronicSeal(id: string): Promise<ElectronicSealAsset | null>
      updateElectronicSeal(id: string, patch: { name?: string; notes?: string }): Promise<ElectronicSealRecord | null>
      deleteElectronicSeal(id: string): Promise<boolean>
      inspectPdfSignatures(bytes: Uint8Array): Promise<PdfSignatureInspection>
      getVirtualPrinterStatus(): Promise<VirtualPrinterStatus>
      takeVirtualPrintJobs(deferredIds?: readonly string[]): Promise<VirtualPrintJob[]>
      acknowledgeVirtualPrintJobs(ids: string[]): Promise<void>
      onVirtualPrintJob(callback: () => void): () => void
      /** Tell the main process whether the workspace has unsaved changes. */
      setWorkspaceDirty(dirty: boolean): void
      /** Main asks whether the window may close. The renderer shows its styled
       *  per-file save prompt when anything is dirty, then replies via
       *  confirmClose; a clean session confirms immediately with no prompt. */
      onCloseRequest(callback: () => void): () => void
      confirmClose(proceed: boolean): void
      /** Main parks the window in the tray: the browse area drops its open
       *  documents so a reshown window starts clean (merge workspaces and the
       *  print queue keep their state), then ack via acknowledgeSessionReset. */
      onSessionReset(callback: () => void): () => void
      acknowledgeSessionReset(): void
    }
  }

  interface PdfPasswordHistoryEntry {
    id: string
    password: string
    documents: string[]
    fingerprint?: string
    createdAt: string
    lastUsedAt: string
  }

  interface DesktopFile {
    desktopGrant?: string
    path: string
    name: string
    type: 'pdf' | 'image' | 'ofd' | 'msg'
    bytes: Uint8Array
    /** File size in bytes. Optional for browser-provided File objects. */
    size?: number
    /** ISO-8601 filesystem timestamps; unavailable for browser-only imports. */
    createdAt?: string
    modifiedAt?: string
    accessedAt?: string
  }

  type ExportFileFormat = 'pdf' | 'png' | 'jpeg' | 'docx'

  interface PrintPdfFileReference {
    path: string
    name: string
    size: number
    createdAt: string
    modifiedAt: string
    accessedAt: string
  }

  interface VirtualPrintJob extends DesktopFile {
    id: string
  }

  interface VirtualPrinterStatus {
    supported: boolean
    installed: boolean
    printerName: string
  }

  interface NativePrinter {
    name: string
    displayName: string
    description?: string
    status: number
    isDefault: boolean
  }

  type OcrMode = 'auto' | 'printed' | 'handwriting'

  interface OcrPoint {
    x: number
    y: number
  }

  interface OcrBox {
    x: number
    y: number
    width: number
    height: number
    points?: [OcrPoint, OcrPoint, OcrPoint, OcrPoint]
    polygon?: OcrPoint[]
    /** Clockwise text-line angle in degrees, derived from the detected quadrilateral. */
    rotation?: number
  }

  interface OcrPageInput {
    width: number
    height: number
    /** Raw RGBA pixels in row-major order. */
    data: Uint8Array
    mode?: OcrMode
    documentType?: 'complex'
    pipeline?: {
      preprocess: boolean
      handwritingProvider: 'local' | 'tencent' | 'custom'
      lowConfidenceProvider: 'local' | 'tencent' | 'custom'
      lowConfidenceThreshold: number
      contextualCorrection: boolean
      tencent: { secretId: string; secretKey: string; region: string }
      custom: { endpoint: string; apiKey: string }
    }
  }

  interface OcrTextItem {
    text: string
    confidence: number
    box: OcrBox
    rawText?: string
    correctedText?: string
    candidates?: Array<{ text: string; confidence: number }>
    requiresReview?: boolean
  }

  interface OcrRecognitionResult {
    text: string
    confidence: number
    items: OcrTextItem[]
    mode: OcrMode
    elapsedMs: number
    rawText?: string
    correctedText?: string
    engine?: string
    model?: string
    documentType?: 'printed' | 'handwriting' | 'complex'
    warnings?: string[]
  }

  interface OcrStatus {
    available: boolean
    ready: boolean
    loading: boolean
    engine: string
    model: string
    error?: string
  }

  interface OcrCapabilities {
    engine: string
    model: string
    local: boolean
    languages: string[]
    modes: OcrMode[]
    input: 'rgba'
    maxPixels: number
    models?: Array<{ id: string; label: string; role: string; available: boolean }>
  }

  interface ElectronicSealRecord {
    id: string
    name: string
    kind: 'appearance-image'
    mimeType: 'image/png' | 'image/jpeg'
    fileName: string
    sourcePath?: string
    byteLength: number
    sha256: string
    width: number
    height: number
    notes?: string
    createdAt: string
    updatedAt: string
    trustStatus: 'not-a-digital-signature'
  }

  interface ElectronicSealAsset extends ElectronicSealRecord {
    bytes: Uint8Array
  }

  type SignatureVerificationStatus = 'verified' | 'failed' | 'unknown' | 'not-performed'

  interface PdfSignatureInfo {
    id: string
    fieldName?: string
    pageNumber?: number
    signerName?: string
    reason?: string
    location?: string
    contactInfo?: string
    signingTime?: string
    filter?: string
    subFilter?: string
    byteRange?: number[]
    signedRevisionLength?: number
    coversCurrentFile: boolean
    hasLaterIncrementalUpdates: boolean
    contentsPresent: boolean
    certificate?: {
      subject: string
      issuer: string
      serialNumber: string
      validFrom: string
      validTo: string
      fingerprint256: string
    }
    structure: 'valid-structure' | 'invalid-structure' | 'not-present'
    cryptographicSignature: SignatureVerificationStatus
    certificateTrust: SignatureVerificationStatus
    revocationStatus: SignatureVerificationStatus
    trustedTimestamp: SignatureVerificationStatus
    warnings: string[]
  }

  interface PdfSignatureInspection {
    documentSha256: string
    fileSize: number
    hasSignatures: boolean
    signatures: PdfSignatureInfo[]
    fullyVerified: boolean
    limitations: string[]
  }

  interface PrintOptions {
    copies: number
    duplex: 'simplex' | 'longEdge' | 'shortEdge'
    range: string
    landscape: boolean
    collate: boolean
    pagesPerSheet: number
    scaleFactor: number
    sizing?: 'fit' | 'actual'
    color: boolean
    deviceName?: string
    margins: 'default' | 'none' | 'printableArea'
    /** Rasterization resolution in DPI (72–600, default 300). */
    dpi?: number
    /** Target paper size; 'auto' keeps each PDF page's own dimensions. */
    paperSize?: 'auto' | 'a4' | 'a5' | 'b5' | 'letter' | 'legal'
    /** Print only odd/even document pages (applied after the page range). */
    subset?: 'all' | 'odd' | 'even'
    /** Print pages back to front (for printers that stack output face-up). */
    reverse?: boolean
    /** Draw a thin hairline border around each page on the sheet. */
    pageBorder?: boolean
  }

  interface PrintPageImageInput {
    /** Page size in PDF points, in visual (post-rotation) orientation. */
    widthPt: number
    heightPt: number
    /** White-composited PNG bytes of the fully rendered page. */
    png: Uint8Array
  }
}
