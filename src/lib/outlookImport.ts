import type { MemoMessage } from '../types/outlookMail'

export const MSG_MAX_INPUT = 32 * 1024 * 1024
const compoundHeader = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
export function checkMsgSize(size: number) {
  if (!Number.isSafeInteger(size) || size <= 0 || size > MSG_MAX_INPUT) throw new Error('MSG 邮件为空或超过 32 MiB，未打开。')
}
/** The parser reads bytes, never a pathname. Only inert memo fields reach the renderer. */
export async function openOutlookMemo(input: Uint8Array, parse?: (bytes: Uint8Array) => Promise<MemoMessage>) {
  checkMsgSize(input.byteLength)
  if (!compoundHeader.every((v, i) => input[i] === v)) throw new Error('不是有效的 Outlook MSG 复合文档；不能仅把其他文件改名为 .msg。')
  if (!parse) throw new Error('请使用 Paperwork Windows 桌面版打开 Outlook MSG 邮件。无需安装 Outlook。')
  const message = await parse(input)
  const { renderOutlookMemo } = await import('./outlookMemo')
  return { bytes: await renderOutlookMemo(message), warnings: message.warnings }
}
