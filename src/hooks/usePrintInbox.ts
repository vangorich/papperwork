import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorkspaceTransferContent } from '../types/pdf'

const ACK_RETRY_MS = [1500, 6000]
type Receipt = { failures: number; busy: boolean; timer?: number }

/** Peeking or postponing never consumes a job. Once its pages are applied, only
 * its receipt may be retried, independently of the picker and other receipts. */
export function usePrintInbox(prepare: (job: VirtualPrintJob) => Promise<WorkspaceTransferContent>) {
  const [proposal, setProposal] = useState<{ id: string; content: WorkspaceTransferContent }>()
  const [message, setMessage] = useState('')
  const [receiptError, setReceiptError] = useState('')
  const active = useRef<string>(), deferred = useRef(new Set<string>())
  const receipts = useRef(new Map<string, Receipt>())
  const processing = useRef(false), again = useRef<boolean>(), mounted = useRef(false)

  const acknowledge = useCallback(async function ack(id: string) {
    const receipt = receipts.current.get(id), host = window.desktop
    if (!receipt || receipt.busy || !host || !mounted.current) return
    window.clearTimeout(receipt.timer)
    receipt.busy = true
    try {
      await host.acknowledgeVirtualPrintJobs([id])
      receipts.current.delete(id)
      if (mounted.current && !receipts.current.size) setReceiptError('')
    } catch (error) {
      if (!mounted.current) return
      const detail = error instanceof Error ? `：${error.message}` : '。'
      setReceiptError(`页面已加入工作区，收件箱回执失败，可从“打印收件箱”重试${detail}`)
      const delay = ACK_RETRY_MS[receipt.failures++]
      if (delay !== undefined) receipt.timer = window.setTimeout(() => void ack(id), delay)
    } finally { receipt.busy = false }
  }, [])

  const drain = useCallback(async function read(manual = false) {
    const host = window.desktop
    if (!host?.takeVirtualPrintJobs || !mounted.current) return
    if (manual) { deferred.current.clear(); setMessage('') }
    if (processing.current) { again.current = manual || again.current === true; return }
    if (active.current) return
    processing.current = true
    try {
      // Snapshot exclusions: an in-flight receipt can finish while the peek is pending.
      const excluded = new Set([...deferred.current, ...receipts.current.keys()])
      const jobs = await host.takeVirtualPrintJobs([...excluded])
      const next = jobs.find(job => !excluded.has(job.id))
      if (!mounted.current) return
      if (!next) { if (manual) setMessage('没有待加入的打印文件。'); return }
      let content: WorkspaceTransferContent
      try { content = await prepare(next) }
      catch (e) { deferred.current.add(next.id); throw e }
      if (!mounted.current) return
      active.current = next.id
      setMessage(''); setProposal({ id: next.id, content })
    } catch (e) {
      if (e && typeof e === 'object' && 'printJobId' in e && typeof e.printJobId === 'string') deferred.current.add(e.printJobId)
      if (mounted.current) setMessage(e instanceof Error ? e.message : '读取打印收件箱失败，可稍后重试。')
    } finally {
      processing.current = false
      const queued = again.current
      again.current = undefined
      if (queued !== undefined) void read(queued)
    }
  }, [prepare])

  useEffect(() => {
    mounted.current = true
    const off = window.desktop?.onVirtualPrintJob?.(() => void drain())
    void drain()
    return () => {
      mounted.current = false
      off?.()
      for (const receipt of receipts.current.values()) window.clearTimeout(receipt.timer)
    }
  }, [drain])

  const reopen = () => {
    for (const id of receipts.current.keys()) void acknowledge(id)
    void drain(true)
  }
  const postpone = () => {
    if (active.current) deferred.current.add(active.current)
    active.current = undefined; setProposal(undefined); void drain()
  }
  const confirming = () => setProposal(undefined)
  const finish = (ok: boolean) => {
    const id = active.current
    if (!id) return
    if (ok) {
      receipts.current.set(id, { failures: 0, busy: false })
      void acknowledge(id)
    } else {
      deferred.current.add(id); setMessage('没有加入页面，打印文件仍留在收件箱。')
    }
    active.current = undefined; void drain()
  }
  return { proposal, message: receiptError || message, reopen, dismissMessage: () => { setReceiptError(''); setMessage('') }, postpone, confirming, finish }
}
