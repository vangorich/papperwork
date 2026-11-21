import { beforeEach, describe, expect, it, vi } from 'vitest'

const pdfJs = vi.hoisted(() => ({ getDocument: vi.fn() }))

vi.mock('pdfjs-dist', () => ({
  getDocument: pdfJs.getDocument,
  GlobalWorkerOptions: { workerSrc: '' },
  PasswordResponses: { NEED_PASSWORD: 1, INCORRECT_PASSWORD: 2 },
}))

import { getPdfDocument, inspectPdf, PdfPasswordCancelledError, releasePdfDocument } from './pdf'

const documentProxy = {
  numPages: 1,
  fingerprints: ['encrypted-fixture'],
  getMetadata: async () => ({ info: { PDFFormatVersion: '1.7', EncryptFilterName: 'Standard' } }),
  destroy: async () => undefined,
}

function encryptedLoadingTask(correctPassword = 'correct') {
  let resolve!: (document: typeof documentProxy) => void
  let reject!: (error: Error) => void
  const task = {
    promise: new Promise<typeof documentProxy>((yes, no) => { resolve = yes; reject = no }),
    onPassword: undefined as undefined | ((updatePassword: (password: string) => void, code: number) => void),
    destroy: vi.fn(async () => reject(new Error('Worker was destroyed during onPassword callback'))),
  }
  const ask = (code: number) => queueMicrotask(() => task.onPassword?.((password) => {
    if (password === correctPassword) resolve(documentProxy)
    else ask(2)
  }, code))
  ask(1)
  return task
}

describe('encrypted PDF opening', () => {
  beforeEach(() => pdfJs.getDocument.mockReset())

  it('prompts again after an incorrect password and retains encrypted metadata', async () => {
    pdfJs.getDocument.mockReturnValue(encryptedLoadingTask())
    const prompts: Array<{ reason: string; attempt: number }> = []
    const passwords = ['wrong', 'correct']
    const source = await inspectPdf(new Uint8Array([1, 2, 3]), 'contract.pdf', undefined, false, async (request) => {
      prompts.push({ reason: request.reason, attempt: request.attempt })
      return passwords.shift() ?? null
    })

    expect(prompts).toEqual([
      { reason: 'required', attempt: 1 },
      { reason: 'incorrect', attempt: 2 },
    ])
    expect(source.pageCount).toBe(1)
    expect(source.documentInfo?.encrypted).toBe(true)
  })

  it('cancels without retaining or retrying the password', async () => {
    const task = encryptedLoadingTask()
    pdfJs.getDocument.mockReturnValue(task)
    const requestPassword = vi.fn(async () => null)

    await expect(inspectPdf(new Uint8Array([1]), 'private.pdf', undefined, false, requestPassword))
      .rejects.toBeInstanceOf(PdfPasswordCancelledError)
    expect(requestPassword).toHaveBeenCalledOnce()
    expect(task.destroy).toHaveBeenCalledOnce()
  })

  it('keeps the accepted password only in memory for cache re-opening', async () => {
    pdfJs.getDocument.mockReturnValue(encryptedLoadingTask())
    const source = await inspectPdf(new Uint8Array([1, 2]), 'archive.pdf', undefined, false, async () => 'correct')
    releasePdfDocument(source)
    pdfJs.getDocument.mockReturnValue({ promise: Promise.resolve(documentProxy) })

    await getPdfDocument(source)
    expect(pdfJs.getDocument).toHaveBeenLastCalledWith(expect.objectContaining({ password: 'correct' }))
    expect(source).not.toHaveProperty('password')
  })
})
