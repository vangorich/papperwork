import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BadgeInfo, FileCheck2, Import, PenTool, Save, ShieldAlert, ShieldCheck, Trash2, X } from 'lucide-react'
import type { PdfSource } from '../types/pdf'
import { formatBytes } from '../lib/cn'
import { Button } from './ui'

export function ElectronicSealDialog({ source, onInsert, onClose }: {
  source?: PdfSource
  onInsert: (asset: ElectronicSealAsset) => void | Promise<void>
  onClose: () => void
}) {
  const [tab, setTab] = useState<'inventory' | 'verify'>('inventory')
  const [seals, setSeals] = useState<ElectronicSealRecord[]>([])
  const [selectedId, setSelectedId] = useState<string>()
  const [asset, setAsset] = useState<ElectronicSealAsset>()
  const [draft, setDraft] = useState({ name: '', notes: '' })
  const [inspection, setInspection] = useState<PdfSignatureInspection>()
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const closeRef = useRef<HTMLButtonElement>(null)

  const refresh = useCallback(async (preferId?: string) => {
    const next = await window.desktop?.listElectronicSeals?.() ?? []
    setSeals(next)
    setSelectedId((current) => preferId && next.some((seal) => seal.id === preferId)
      ? preferId : current && next.some((seal) => seal.id === current) ? current : next[0]?.id)
  }, [])

  useEffect(() => { void refresh().catch((cause) => setError(cause instanceof Error ? cause.message : '电子章库存读取失败')) }, [refresh])
  useEffect(() => {
    closeRef.current?.focus()
    const escape = (event: KeyboardEvent) => event.key === 'Escape' && onClose()
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [onClose])
  useEffect(() => {
    setAsset(undefined)
    if (!selectedId) return
    let cancelled = false
    void window.desktop?.readElectronicSeal?.(selectedId).then((next) => {
      if (cancelled || !next) return
      setAsset(next)
      setDraft({ name: next.name, notes: next.notes ?? '' })
    }).catch((cause) => !cancelled && setError(cause instanceof Error ? cause.message : '电子章读取失败'))
    return () => { cancelled = true }
  }, [selectedId])

  const previewUrl = useMemo(() => asset
    ? URL.createObjectURL(new Blob([asset.bytes], { type: asset.mimeType }))
    : undefined, [asset])
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl) }, [previewUrl])

  const importSeal = async () => {
    setBusy('正在导入电子章')
    setError('')
    try {
      const imported = await window.desktop?.importElectronicSeal?.()
      if (imported) await refresh(imported.id)
    } catch (cause) { setError(cause instanceof Error ? cause.message : '电子章导入失败') }
    finally { setBusy('') }
  }
  const saveInfo = async () => {
    if (!asset || !draft.name.trim()) return
    setBusy('正在保存信息')
    setError('')
    try {
      const updated = await window.desktop?.updateElectronicSeal?.(asset.id, { name: draft.name.trim(), notes: draft.notes.trim() })
      if (updated) await refresh(updated.id)
    } catch (cause) { setError(cause instanceof Error ? cause.message : '电子章信息保存失败') }
    finally { setBusy('') }
  }
  const deleteSeal = async () => {
    if (!asset || !window.confirm(`从库存删除“${asset.name}”？源图片不会被删除。`)) return
    setBusy('正在删除电子章')
    try { await window.desktop?.deleteElectronicSeal?.(asset.id); setAsset(undefined); await refresh() }
    catch (cause) { setError(cause instanceof Error ? cause.message : '电子章删除失败') }
    finally { setBusy('') }
  }
  const verify = async () => {
    if (!source) return
    if(source.fileInfo?.ofdSignature){setInspection(undefined);setError('OFD 原件含数字签名。当前 PDF 只是阅览副本，不能用于验证原件。');return}
    setBusy('正在读取 PDF 签名结构')
    setError('')
    try { setInspection(await window.desktop?.inspectPdfSignatures?.(source.bytes)) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'PDF 签名读取失败') }
    finally { setBusy('') }
  }

  return (
    <div className="seal-dialog__backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="seal-dialog" role="dialog" aria-modal="true" aria-labelledby="seal-dialog-title" onKeyDown={(event) => {
        if (event.key !== 'Tab') return
        const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled)')]
        const first = controls[0]
        const last = controls.at(-1)
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }}>
        <header>
          <span><PenTool size={19} /></span>
          <div><h2 id="seal-dialog-title">电子章与数字签名</h2><p>章图库存、签章信息与 PDF 数字签名检查</p></div>
          <button ref={closeRef} type="button" aria-label="关闭" onClick={onClose}><X size={17} /></button>
        </header>
        <nav aria-label="电子章功能">
          <button data-active={tab === 'inventory' || undefined} onClick={() => setTab('inventory')}><PenTool size={14} />电子章库存</button>
          <button data-active={tab === 'verify' || undefined} onClick={() => setTab('verify')}><FileCheck2 size={14} />验证 PDF 签名</button>
        </nav>
        {error && <div className="seal-dialog__error" role="alert"><ShieldAlert size={15} />{error}</div>}
        {tab === 'inventory' ? (
          <div className="seal-inventory">
            <aside>
              <button className="seal-inventory__import" onClick={() => void importSeal()} disabled={Boolean(busy)}><Import size={15} />导入电子章图片</button>
              <div className="seal-inventory__list">
                {seals.map((seal) => <button key={seal.id} data-active={seal.id === selectedId || undefined} onClick={() => setSelectedId(seal.id)}><strong>{seal.name}</strong><small>{seal.width} × {seal.height} · {formatBytes(seal.byteLength)}</small></button>)}
                {!seals.length && <p>库存为空。导入 PNG 或 JPEG 电子章后可重复使用。</p>}
              </div>
            </aside>
            <main>
              {asset ? <>
                <div className="seal-preview">{previewUrl && <img src={previewUrl} alt={`电子章预览：${asset.name}`} />}</div>
                <div className="seal-fields">
                  <label>库存名称<input value={draft.name} maxLength={120} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} /></label>
                  <label>备注<textarea value={draft.notes} maxLength={500} onChange={(event) => setDraft((current) => ({ ...current, notes: event.target.value }))} placeholder="例如：合同专用章、有效期或保管人" /></label>
                </div>
                <dl className="seal-info">
                  <div><dt>图片格式</dt><dd>{asset.mimeType}</dd></div><div><dt>原始尺寸</dt><dd>{asset.width} × {asset.height}</dd></div>
                  <div><dt>文件大小</dt><dd>{formatBytes(asset.byteLength)}</dd></div><div><dt>SHA-256</dt><dd title={asset.sha256}>{asset.sha256.slice(0, 16)}…</dd></div>
                  <div><dt>库存日期</dt><dd>{new Date(asset.createdAt).toLocaleString('zh-CN')}</dd></div><div><dt>来源位置</dt><dd title={asset.sourcePath}>{asset.sourcePath || '库存内部文件'}</dd></div>
                  <div><dt>安全属性</dt><dd>章图外观，不等同于数字签名</dd></div>
                </dl>
                <div className="seal-inventory__actions"><Button variant="danger" onClick={() => void deleteSeal()} disabled={Boolean(busy)}><Trash2 size={14} />删除</Button><Button variant="secondary" onClick={() => void saveInfo()} disabled={Boolean(busy) || !draft.name.trim()}><Save size={14} />保存信息</Button><Button variant="primary" onClick={() => void onInsert(asset)} disabled={Boolean(busy)}>插入当前页</Button></div>
              </> : <div className="seal-inventory__empty"><BadgeInfo size={24} /><strong>选择一个电子章</strong><span>可查看尺寸、哈希和备注，再插入当前 PDF 页面。</span></div>}
            </main>
          </div>
        ) : (
          <div className="signature-check">
            <div className="signature-check__intro"><ShieldCheck size={20} /><div><strong>{source?.name ?? '当前没有打开 PDF'}</strong><span>{source?.fileInfo?.ofdSignature ? 'OFD 原件含签名，当前阅览副本未经验证。请对原始 OFD 文件验签。' : '检查签名字段、ByteRange、覆盖范围和证书公开信息；不会把未完成的证书链验证标为可信。'}</span></div><Button variant="primary" onClick={() => void verify()} disabled={!source || Boolean(source.fileInfo?.ofdSignature) || Boolean(busy)}>开始检查</Button></div>
            {inspection && <>
              <div className="signature-check__summary" data-state={inspection.hasSignatures ? 'found' : 'empty'}><strong>{inspection.hasSignatures ? `发现 ${inspection.signatures.length} 个签名字段` : '未发现数字签名'}</strong><span>{inspection.fullyVerified ? '已完成完整密码学验证' : '未完成证书链、撤销状态和可信时间戳验证'}</span></div>
              <div className="signature-check__list">{inspection.signatures.map((signature) => <article key={signature.id}>
                <header><strong>{signature.signerName || signature.fieldName || '未命名签名'}</strong><span data-state={signature.structure}>{signature.structure === 'valid-structure' ? '结构正常' : '结构异常'}</span></header>
                <dl><div><dt>签署时间</dt><dd>{signature.signingTime || '未提供'}</dd></div><div><dt>页码</dt><dd>{signature.pageNumber ?? '未知'}</dd></div><div><dt>覆盖当前文件</dt><dd>{signature.coversCurrentFile ? '是' : '否'}</dd></div><div><dt>后续增量更新</dt><dd>{signature.hasLaterIncrementalUpdates ? '存在' : '未发现'}</dd></div><div><dt>密码学签名</dt><dd>{signature.cryptographicSignature}</dd></div><div><dt>证书信任</dt><dd>{signature.certificateTrust}</dd></div></dl>
                {signature.warnings.length > 0 && <ul>{signature.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
              </article>)}</div>
              {inspection.limitations.length > 0 && <div className="signature-check__limits"><strong>验证边界</strong><ul>{inspection.limitations.map((item) => <li key={item}>{item}</li>)}</ul></div>}
            </>}
          </div>
        )}
        {busy && <div className="seal-dialog__busy" role="status">{busy}…</div>}
      </section>
    </div>
  )
}
