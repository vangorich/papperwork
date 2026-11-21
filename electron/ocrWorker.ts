import { parentPort, workerData } from 'node:worker_threads'
import { configureOcrModelDirectory, recognizeOcrPage, type OcrPageInput } from './ocr'

type OcrWorkerRequest = { id: number; payload: OcrPageInput }
type OcrWorkerResponse =
  | { id: number; result: Awaited<ReturnType<typeof recognizeOcrPage>> }
  | { id: number; error: string }

if (!parentPort) throw new Error('OCR worker requires a parent port')
if (typeof workerData?.modelDirectory === 'string') {
  configureOcrModelDirectory(workerData.modelDirectory)
}

parentPort.on('message', async ({ id, payload }: OcrWorkerRequest) => {
  try {
    const result = await recognizeOcrPage(payload)
    parentPort!.postMessage({ id, result } satisfies OcrWorkerResponse)
  } catch (error) {
    parentPort!.postMessage({
      id,
      error: error instanceof Error ? error.message : String(error),
    } satisfies OcrWorkerResponse)
  }
})
