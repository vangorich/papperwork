import { createQpdfRunner } from 'qpdf-run'
import qpdfWorkerUrl from 'qpdf-run/worker?url'
import qpdfJsUrl from 'qpdf-run/qpdf.js?url'
import qpdfWasmUrl from 'qpdf-run/qpdf.wasm?url'

export interface PdfEncryptionOptions {
  userPassword: string
  ownerPassword: string
  allowPrinting?: boolean
  allowCopying?: boolean
  allowEditing?: boolean
}

const INPUT_NAME = 'input.pdf'
const OUTPUT_NAME = 'output.pdf'
const QPDF_TIMEOUT_MS = 120_000

const qpdfError = (error: unknown, fallback: string) => {
  if (!(error instanceof Error)) return new Error(fallback)
  // qpdf may echo its argv in diagnostics. Never surface password-bearing
  // command details to the UI or logs.
  const message = /password|encrypt|decrypt|qpdf/i.test(error.message)
    ? fallback
    : error.message
  return new Error(message)
}

async function transformPdf(bytes: Uint8Array, args: string[], fallback: string) {
  if (!(bytes instanceof Uint8Array) || !bytes.length) throw new Error('PDF 文件数据无效')
  const runner = await createQpdfRunner({
    workerUrl: qpdfWorkerUrl,
    qpdfJsUrl,
    wasmUrl: qpdfWasmUrl,
    timeoutMs: QPDF_TIMEOUT_MS,
  })
  try {
    return await runner.runOne({
      input: bytes,
      inputName: INPUT_NAME,
      outputName: OUTPUT_NAME,
      args: [...args, '--', INPUT_NAME, OUTPUT_NAME],
    })
  } catch (error) {
    throw qpdfError(error, fallback)
  } finally {
    await runner.destroy()
  }
}

/** Content-preserving password removal. QPDF decrypts strings and streams
 * instead of rasterizing pages, so text, vectors, fonts, forms and layout stay
 * intact. The source bytes are never changed in place. */
export function decryptPdfBytes(bytes: Uint8Array, password: string) {
  if (!password) throw new Error('缺少用于解除 PDF 密码的凭据')
  return transformPdf(
    bytes,
    [`--password=${password}`, '--decrypt'],
    '无法解除 PDF 密码，请确认当前密码具有访问权限',
  )
}

/** AES-256 output encryption. The owner password is the print/edit permission
 * password; opening with it bypasses restrictions configured for the user
 * password. */
export function encryptPdfBytes(bytes: Uint8Array, options: PdfEncryptionOptions) {
  const userPassword = options.userPassword
  const ownerPassword = options.ownerPassword
  if (!userPassword) throw new Error('请输入 PDF 打开密码')
  if (!ownerPassword) throw new Error('请输入打印、编辑权限密码')
  if (userPassword === ownerPassword) throw new Error('打开密码与权限密码应当不同')
  return transformPdf(bytes, [
    '--encrypt',
    userPassword,
    ownerPassword,
    '256',
    `--print=${options.allowPrinting ? 'full' : 'none'}`,
    `--modify=${options.allowEditing ? 'all' : 'none'}`,
    `--extract=${options.allowCopying ? 'y' : 'n'}`,
  ], 'PDF 加密失败')
}
