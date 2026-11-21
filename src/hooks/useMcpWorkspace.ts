import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import type { useWorkspace } from './useWorkspace'
import { McpSession } from '../lib/mcpSession'
import type { McpAccess } from '../lib/mcpSession'
import { getPdfNativeTextEditInput, inspectPdf, releasePdfDocument } from '../lib/pdf'
import type { WorkspacePage } from '../types/pdf'

/** A textarea owns its draft until the user commits or cancels it. Check at the
 * final synchronous write, including after a PDF rewrite or an IPC liveness wait. */
function protectTextDrafts(before: WorkspacePage[], next: WorkspacePage[]) {
  for (const field of document.querySelectorAll<HTMLTextAreaElement>('.stage-page .annotation--text textarea:is([data-pending-text],[data-composing],:focus):not([readonly])')) {
    const pageId = field.closest<HTMLElement>('[data-page-id]')?.dataset.pageId
    const i = before.findIndex(p => p.id === pageId)
    if (i < 0 || before[i] === next[i]) continue
    const old = before[i], page = next[i]
    const id = field.closest<HTMLElement>('[data-annotation-id]')?.dataset.annotationId
    const original = old.annotations.find(a => a.id === id)
    if (!field.hasAttribute('data-pending-text') && !field.hasAttribute('data-composing') && field.value === (original?.text ?? '')) continue
    if (page?.id === old.id && page.sourceId === old.sourceId && page.sourcePage === old.sourcePage && page.rotation === old.rotation && page.crop === old.crop && page.pageSize === old.pageSize && (!original || page.annotations.includes(original))) continue
    throw new Error('本地文本框正在输入，未应用修改。请等用户完成编辑后重新读取页面和版本。')
  }
}

type Workspace=ReturnType<typeof useWorkspace>
interface Options { enabled:boolean; workspace:Workspace; busy:boolean; notify:(s:string)=>void; show:()=>void; exportPdf:(pages:WorkspacePage[],group:string,valid:()=>boolean)=>Promise<boolean> }
/** Only the reader subscribes, once. Hidden project views never grant their sources. */
export function useMcpWorkspace(options:Options){
  const latest=useRef(options);useLayoutEffect(()=>{latest.current=options})
  const [epoch,paint]=useState(0),[open,setOpen]=useState(false), alive=useRef(true)
  const [session]=useState(()=>new McpSession({
    model:()=>latest.current.workspace,
    read:async(p,sources)=>{const {makePdfMarkdown}=await import('../lib/pdfMarkdown');const result=await makePdfMarkdown([p],sources,{includeImages:false,assetDirectory:'figures',omitPageHeadings:true});return result.markdown},
    rewrite:async(src,p,find,replace)=>{const {rewritePdfText}=await import('../lib/rewritePdfText');const bytes=await rewritePdfText(getPdfNativeTextEditInput(src),p,find,replace);return inspectPdf(bytes,src.name,undefined,false)},
    dispose:s=>{void releasePdfDocument(s)},
    apply:(g,old,next,src)=>{if(latest.current.busy)throw Error('工作台正在保存或处理页面，请稍后重试');let changed=false;flushSync(()=>{protectTextDrafts(old,next);changed=latest.current.workspace.applyMcpPages(g,old,next,src)});return changed},
    watermark:(g,mark)=>{if(latest.current.busy)throw Error('工作台正在保存，请稍后重试');flushSync(()=>latest.current.workspace.setWatermark(mark,g))},
    changed:()=>{if(alive.current)paint(i=>i+1)},editNotice:name=>latest.current.notify(`AI 已编辑“${name}” · 可撤销，尚未写盘`),exportError:detail=>latest.current.notify(`未能另存副本：${detail}`),pending:()=>{latest.current.show();setOpen(true)},
  }))
  const bridge=options.enabled?window.desktop?.pdfMcp:undefined
  useEffect(()=>{if(!bridge)return;alive.current=true
    const off=bridge.listen(call=>{void (async()=>{let ok=true,value:unknown;try{value=await session.dispatch(call,()=>bridge.live(call.id))}catch(e){ok=false;value=e instanceof Error?e.message:'本次操作未完成'}try{await bridge.reply(call.id,ok,value)}catch{/* already timed out or the window closed */}})()})
    return ()=>{alive.current=false;off();session.clear()}
  },[bridge,session])
  useLayoutEffect(()=>{if(bridge)session.sync()},[bridge,session,options.workspace.pages,options.workspace.sources,options.workspace.watermarks])
  async function respond(id:string,ok:boolean){await session.resolveExport(id,ok,async(r,pages,g,valid)=>{
    if(!valid())return false
    if(r.format==='pdf')return latest.current.exportPdf(pages,g.group,valid)
    const { saveMarkdownExport }=await import('../lib/saveMarkdown');if(!valid())return false
    return Boolean(await saveMarkdownExport(pages,latest.current.workspace.sources,r.name.replace(/\.pdf$/i,'')+'.md',false,{stillValid:valid}))
  })}
  return {available:Boolean(bridge),open,epoch,show:()=>setOpen(true),close:()=>setOpen(false),forGroup:(g:string|undefined)=>session.get(g),grant:(g:string,access:McpAccess)=>session.grant(g,access),revoke:(id:string)=>session.revoke(id),requests:session.pendingExports(),respond}
}
