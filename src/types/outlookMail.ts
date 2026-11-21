/** Offline MSG message fields. No attachment bodies or HTML nodes cross this boundary. */
export interface MemoMessage {
  subject: string
  from: string
  to: string[]
  cc: string[]
  bcc?: string[]
  /** A parseable ISO date with a time zone when available. */
  sentAt?: string
  body: string
  attachments: string[]
  warnings: string[]
}
