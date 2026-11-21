import { useEffect, useMemo, useRef, useState } from 'react'
import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react'
import { FileOutput, X } from 'lucide-react'
import type { PdfSource, WorkspacePage } from '../types/pdf'
import type { MarkdownFragment, MarkdownScope } from '../lib/markdownScopeTypes'
import { normalizeMarkdownEndpoint } from '../lib/markdownAssist'
import { hasNativeMarkdownPicker, saveMarkdownExport } from '../lib/saveMarkdown'
import { Button } from './ui'
import './markdownExportDialog.css'

type Props = {
  pages: readonly WorkspacePage[]; sources: readonly PdfSource[]; name: string
  selection?: readonly MarkdownFragment[]; onClose: () => void; onSaved: (message: string) => void
}
const none: readonly MarkdownFragment[] = []
const byteLength = (s: string) => new TextEncoder().encode(s).length
const apiLimit = 1024 * 1024
const captions = { full: '全文', selection: '当前选区', highlights: '已有高亮' } as const

export function MarkdownExportDialog({ pages, sources, name, selection = none, onClose, onSaved }: Props) {
  const [kind,setKind]=useState<MarkdownScope['kind']>(selection.length ? 'selection' : 'full')
  const scope = useMemo<MarkdownScope>(() => kind==='selection' ? {kind,fragments:selection} : {kind},[kind,selection])
  const [images,setImages]=useState(false), [api,setApi]=useState(false)
  const [endpoint,setEndpoint]=useState(''),[model,setModel]=useState(''),[key,setKey]=useState('')
  const [preview,setPreview]=useState<string>(),[original,setOriginal]=useState<string>(),[suggestion,setSuggestion]=useState<string>(),[adopted,setAdopted]=useState(false)
  const [error,setError]=useState(''),[status,setStatus]=useState(''),[phase,setPhase]=useState<'idle'|'preview'|'send'|'save'>('idle')
  const job=useRef<AbortController|null>(null), native=hasNativeMarkdownPicker()
  const busy=phase!=='idle', edited=preview!==undefined && preview!==original
  const textOnly = adopted || edited
  const includeImages=images && !textOnly
  // A text-only save of a visible preview must not extract the document again.
  const reviewedText=adopted ? suggestion : includeImages ? undefined : preview
  const bytes=useMemo(()=>preview===undefined?0:byteLength(preview),[preview])
  const recipient=useMemo(()=>{try{return normalizeMarkdownEndpoint(endpoint)}catch{return ''}},[endpoint])
  const approved=!!(api&&preview?.trim()&&bytes<=apiLimit&&recipient&&model.trim())
  const reviewBox=useRef<HTMLTextAreaElement>(null)
  useEffect(()=>{if(suggestion!==undefined){reviewBox.current?.focus({preventScroll:true});reviewBox.current?.closest('.md-sheet__suggestion')?.scrollIntoView({block:'nearest',behavior:'instant'})}},[suggestion])
  useEffect(()=>()=>{job.current?.abort();job.current=null},[])
  function clearSuggestion(){setSuggestion(undefined);setAdopted(false);setError('')}
  function changeScope(next:MarkdownScope['kind']){if(busy||kind===next)return;setKind(next);setPreview(undefined);setOriginal(undefined);clearSuggestion()}
  function close(){job.current?.abort();job.current=null;onClose()}
  async function run(which: 'preview'|'send'|'save') {
    if(job.current || !pages.length || (which==='send'&&!approved))return
    const ctl=new AbortController();job.current=ctl;setPhase(which);setError('')
    const current=()=>job.current===ctl&&!ctl.signal.aborted
    const progress=(n:number,total:number)=>{if(current())setStatus(`正在本地整理 ${n} / ${total} 页…`)}
    try {
      if(which==='preview'){
        setStatus('正在本地提取文字…');clearSuggestion();setPreview(undefined);setOriginal(undefined)
        const {makePdfMarkdown}=await import('../lib/pdfMarkdown')
        const out=await makePdfMarkdown(pages,sources,{scope,includeImages:false,assetDirectory:'images',signal:ctl.signal,onPage:progress})
        if(!current())return
        setPreview(out.markdown);setOriginal(out.markdown)
      } else if(which==='send') {
        // The click authorizes only this immutable copy of the *visible textarea*.
        // Never build a broader export or add a filename, image, PDF, or context here.
        const exact=preview!, config={endpoint:recipient,model:model.trim(),...(key?{apiKey:key}:{})}
        clearSuggestion();setStatus('正在等待 API 整理结果…')
        const {assistMarkdown}=await import('../lib/markdownAssist');ctl.signal.throwIfAborted()
        const answer=await assistMarkdown(exact,config,ctl.signal)
        if(current())setSuggestion(answer)
      } else {
        setStatus(native?'请选择新的 .md 文件…':'正在准备导出…')
        const leaf=kind==='full'?name:name.replace(/\.md$/i,`-${captions[kind]}.md`)
        const saved=await saveMarkdownExport(pages,sources,leaf,includeImages,{scope,reviewedText,signal:ctl.signal,onPage:progress})
        if(!current()||!saved)return
        const warnings=saved.warnings.length?' · '+saved.warnings[0]:''
        onSaved(`${native?'已保存':'已发起下载'} ${saved.name}${includeImages?`（${saved.imageCount} 张插图）`:''}${warnings}`);onClose()
      }
    } catch(e){if(current())setError(e instanceof Error?e.message:'处理失败，请重试。')}
    finally{if(job.current===ctl){job.current=null;setPhase('idle');setStatus('')}}
  }
  function stop(){job.current?.abort();job.current=null;setPhase('idle');setStatus('');setError('已取消本次操作。')}
  return <Dialog open onClose={close} className="dialog page-export-dialog md-sheet"><DialogBackdrop className="dialog__backdrop"/>
    <DialogPanel className="dialog__panel md-sheet__panel">
      <div className="dialog__header"><div><DialogTitle>导出 Markdown</DialogTitle><p>当前视图共 {pages.length} 页。默认在本机转换，原件不变。</p></div>
        <button type="button" aria-label="关闭 Markdown 导出" onClick={close}><X size={18}/></button></div>
      <div className="md-sheet__body">
      <fieldset className="md-sheet__scope" disabled={busy}><legend>导出范围</legend>
        {(['full','selection','highlights'] as const).map(v=><label key={v} data-active={kind===v||undefined}>
          <input type="radio" name="markdown-export-scope" value={v} checked={kind===v} disabled={v==='selection'&&!selection.length} onChange={()=>changeScope(v)}/>{captions[v]}</label>)}
      </fieldset>
      <p className="dialog__hint">{kind==='full'?'按当前页序导出。':kind==='selection'?'只导出打开弹窗前在页面拉选的文字或框选的表格。':'只导出高亮覆盖且能确认的内容；没有高亮时不会改为全文。'}</p>
      <label className="checkbox-row"><input type="checkbox" checked={includeImages} disabled={busy||textOnly} onChange={e=>setImages(e.currentTarget.checked)}/><span><strong>同时导出插图</strong><small>{textOnly?'当前保存审阅后的纯文字，不附带图片。':native?'插图保存在 .md 旁的文件夹，以相对链接引用。':'勾选后连同 .md 和本地插图一起下载为 ZIP。'}</small></span></label>
      <label className="checkbox-row"><input type="checkbox" checked={api} disabled={busy} onChange={e=>{setApi(e.target.checked);if(!e.target.checked){setKey('');clearSuggestion()}}}/><span><strong>API 辅助整理</strong><small>可选。仅在你确认发送后调用 OpenAI 兼容接口。</small></span></label>
      {api&&<fieldset className="md-sheet__service" disabled={busy}><legend>本次服务</legend>
        <label>API 地址<input value={endpoint} autoComplete="off" spellCheck={false} placeholder="https://服务地址/v1" onChange={e=>{setEndpoint(e.target.value);clearSuggestion()}}/></label>
        <label>模型<input value={model} autoComplete="off" spellCheck={false} onChange={e=>{setModel(e.target.value);clearSuggestion()}}/></label>
        <label>API Key（可选）<input type="password" autoComplete="new-password" value={key} onChange={e=>{setKey(e.target.value);clearSuggestion()}}/></label>
      </fieldset>}
      <div className="md-sheet__preview"><Button type="button" disabled={busy} onClick={()=>void run('preview')}>{preview===undefined?'预览文字':'重新提取本地文字'}</Button>
        {preview!==undefined&&<label>本地预览（可删减）<textarea aria-label="本地预览文字" spellCheck={false} value={preview} readOnly={busy} onChange={e=>{setPreview(e.target.value);clearSuggestion()}}/></label>}
        {api&&<><p className="dialog__hint">{recipient?`接收地址：${recipient}`:'请填写 HTTPS 地址，或本机回环 HTTP 地址。'}{preview!==undefined?` · ${bytes.toLocaleString()} 字节`:''}。{bytes>apiLimit?'超过 1 MiB，请删减预览后再发送；仍可离线保存。':''}只发送上框文字；不发送文件、插图、附件或其他页。密钥不落盘。</p>
          <Button type="button" disabled={!approved||busy} onClick={()=>void run('send')}>确认发送预览文字</Button></>}
        {api&&suggestion!==undefined&&<div className="md-sheet__suggestion"><label>API 建议（尚未写入）<textarea ref={reviewBox} aria-label="API 建议" value={suggestion} readOnly/></label><div>
          <Button type="button" disabled={busy||adopted} onClick={()=>setAdopted(true)}>{adopted?'已选用 API 结果':'采用 API 结果'}</Button>
          <Button type="button" disabled={busy} onClick={clearSuggestion}>放弃建议</Button></div></div>}
      </div>
      {status&&<p role="status">{status}</p>}{error&&<p role="alert" className="field-error">{error}</p>}
      </div>
      <div className="dialog__actions"><Button type="button" onClick={busy?stop:close}>{busy?'停止本次操作':'取消'}</Button><Button type="button" variant="primary" disabled={!pages.length||busy||(reviewedText!==undefined&&!reviewedText.trim())} onClick={()=>void run('save')}>
        <FileOutput size={15}/>{native?'选择保存位置':includeImages?'下载 ZIP':'下载 Markdown'}</Button></div>
    </DialogPanel></Dialog>
}
