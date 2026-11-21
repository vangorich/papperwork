import type { DocumentWatermark, PdfSource, WorkspacePage } from '../types/pdf'
import { editGuide, planMcpEdit, prepareMcpText } from './mcpEdit'

export type McpAccess = 'read'|'edit'
export interface McpCall {id:string;name:string;args:Record<string,unknown>}
export interface McpBridge {listen:(handler:(call:McpCall)=>void)=>()=>void; live:(id:string)=>Promise<boolean>;reply:(id:string,ok:boolean,value:unknown)=>Promise<void>}
export interface McpModel {sources:readonly PdfSource[];pages:readonly WorkspacePage[];watermarks:ReadonlyMap<string|undefined,DocumentWatermark>}
export type McpGrant={id:string;group:string;access:McpAccess;revision:string;pages:WorkspacePage[];sources:Set<string>;watermark?:DocumentWatermark;name:string}
export type PendingExport={id:string;grantId:string;revision:string;format:'pdf'|'markdown';pages:number[];name:string;state:'pending'|'saving'|'saved'|'cancelled'|'failed';time:number}
export interface McpPorts {
  model:()=>McpModel
  read:(page:WorkspacePage,sources:readonly PdfSource[])=>Promise<string>
  rewrite:(source:PdfSource,page:number,find:string,replace:string)=>Promise<PdfSource>
  dispose:(source:PdfSource)=>void
  apply:(group:string,old:WorkspacePage[],next:WorkspacePage[],staged?:PdfSource)=>boolean
  watermark:(group:string,wm:DocumentWatermark|undefined)=>void
  changed:()=>void
  editNotice:(name:string)=>void
  exportError:(detail:string)=>void
  pending:()=>void
}
const groupOf=(p:WorkspacePage)=>p.groupId??p.sourceId
const uiId=()=>crypto.randomUUID()
const error=(s:string):never=>{throw new Error(s)}
const pageNumber=(v:unknown,n:number)=>typeof v==='number'&&Number.isInteger(v)&&v>=1&&v<=n?v:error('页码超出授权范围')
const word=(v:unknown,n:number)=>typeof v==='string'&&v.trim()&&v.length<=n?v:error('文本参数为空或过长')

/** Lives only in the mounted reader; the OS bridge has neither PDF contents nor file access.
 * Re-query the live grant after every async operation. An old ID never survives reauthorization. */
export class McpSession {
  private grants=new Map<string,McpGrant>()
  private requests=new Map<string,PendingExport>()
  private editing=new Set<string>()
  constructor(private port:McpPorts){}
  get(group:string|undefined){return [...this.grants.values()].find(g=>g.group===group)}
  pendingExports(){this.prune();return [...this.requests.values()].filter(x=>x.state==='pending'||x.state==='saving')}
  private prune(){for(const [id,r] of this.requests)if(Date.now()-r.time>600_000&&r.state!=='saving')this.requests.delete(id)}
  clear(){this.grants.clear();this.requests.clear();this.editing.clear()}
  revoke(id:string){this.grants.delete(id);for(const [k,r] of this.requests)if(r.grantId===id)this.requests.delete(k);this.port.changed()}
  grant(group:string,access:McpAccess){const m=this.port.model(),source=m.sources.find(s=>s.id===group),pages=m.pages.filter(p=>groupOf(p)===group);if(!source||!pages.length)throw new Error('请选择浏览区中已打开的文档');const prior=this.get(group);if(prior)this.revoke(prior.id);const grant:McpGrant={id:uiId(),group,access,revision:uiId(),name:source.displayName||source.name,pages,sources:new Set(pages.map(p=>p.sourceId)),watermark:m.watermarks.get(group)};this.grants.set(grant.id,grant);this.port.changed();return grant}
  sync(){const m=this.port.model();for(const g of this.grants.values()){
    const pages=m.pages.filter(p=>groupOf(p)===g.group)
    // Do not disclose a different file pasted/replaced into the granted file group.
    if(!pages.length||pages.some(p=>p.sourceId!=='blank'&&!g.sources.has(p.sourceId))){this.revoke(g.id);continue}
    const mark=m.watermarks.get(g.group)
    if(mark!==g.watermark||pages.length!==g.pages.length||pages.some((p,i)=>g.pages[i]!==p)){g.pages=pages;g.watermark=mark;g.revision=uiId()}
  }}
  private require(id:unknown){this.sync();const g=this.grants.get(String(id));if(!g)throw new Error('该文档未授权、已关闭或授权已撤销');return g}
  private fence(g:McpGrant,rev:string){if(this.require(g.id)!==g||g.revision!==rev)throw new Error('文档已变化，请重新读取页码和版本')}
  private summary(g:McpGrant){return {documentId:g.id,name:g.name,pageCount:g.pages.length,access:g.access,revision:g.revision}}
  async dispatch(call:McpCall,live:()=>Promise<boolean>){const {name,args:a}=call;this.prune();this.sync()
    if(name==='describe_edits')return {operationNameField:'kind',...editGuide}
    if(name==='list_documents')return {documents:[...this.grants.values()].map(g=>this.summary(g))}
    const g=this.require(a.documentId),rev=g.revision,model=this.port.model()
    if(name==='read_page'){
      const n=pageNumber(a.page,g.pages.length),p=g.pages[n-1],body=await this.port.read(p,model.sources);this.fence(g,rev)
      const at=a.offset===undefined?0:Number(a.offset);if(typeof (a.offset??0)!=='number'||!Number.isSafeInteger(at)||at<0||at>body.length)throw new Error('无效的正文偏移')
      const objects=p.annotations.filter(o=>!p.crop||(o.x>=p.crop.x&&o.y>=p.crop.y&&o.x+o.width<=p.crop.x+p.crop.width&&o.y+o.height<=p.crop.y+p.crop.height)).slice(0,256).map(o=>({id:o.id,type:o.type,box:{x:o.x,y:o.y,width:o.width,height:o.height},rotation:o.rotation||0}))
      return {...this.summary(g),page:n,citation:`${g.name} · 第 ${n} 页`,text:body.slice(at,at+10000),nextOffset:at+10000<body.length?at+10000:null,objects}
    }
    if(name==='search'){
      const q=word(a.query,200).toLowerCase(),from=pageNumber(a.fromPage??1,g.pages.length),matches:{page:number;excerpt:string}[]=[];let n=from
      for(;n<=g.pages.length&&n<from+24 && matches.length<32;n++){if(!await live())throw new Error('查询已过期');this.fence(g,rev);const body=await this.port.read(g.pages[n-1],model.sources);this.fence(g,rev);const loc=body.toLowerCase().indexOf(q);if(loc>=0)matches.push({page:n,excerpt:body.slice(Math.max(0,loc-65),loc+q.length+65)})}
      return {...this.summary(g),matches,nextPage:n<=g.pages.length?n:null}
    }
    if(name==='edit_document'){
      if(g.access!=='edit')throw new Error('此文档只授权了阅读，不能编辑');if(rev!==a.revision)throw new Error('版本已变化，请重新读取文档后再修改');if(this.editing.has(g.id))throw new Error('另一次编辑正在进行，请稍后重读版本');this.editing.add(g.id)
      let staged:PdfSource|undefined
      try{const before=g.pages,plan=planMcpEdit(before,g.group,a.operation);let next='pages' in plan?plan.pages:undefined
        if('pages' in plan && plan.raster) next=await prepareMcpText(plan,model.sources,()=>this.fence(g,rev))
        if('native' in plan){const p=plan.native.page,src=model.sources.find(s=>s.id===p.sourceId);if(!src||src.documentInfo?.encrypted||src.documentInfo?.hasSignatures||src.fileInfo?.ofdSignature)throw new Error('空白、签名或加密原件不能直接改写原生文字');if(p.crop)throw new Error('为避免修改裁切区外的原文，请先在工作台移除裁切');staged=await this.port.rewrite(src,p.sourcePage,plan.native.find,plan.native.replacement);next=before.map(v=>v===p?{...p,groupId:g.group,sourceId:staged!.id,ocr:undefined}:v)}
        if(!await live())throw new Error('编辑请求已过期');this.fence(g,rev)
        if('watermark' in plan) this.port.watermark(g.group,plan.watermark)
        else if(next){
          // flushSync may run sync() inside apply. Tentatively admit only this derived
          // source; roll back even when the final draft/busy guard throws.
          if(staged)g.sources.add(staged.id)
          if(!this.port.apply(g.group,before,next,staged))throw new Error('文档版本已变化，未应用修改')
          staged=undefined
        }
        this.sync();this.port.changed();this.port.editNotice(g.name);return {...this.summary(g),applied:true,storedOnDisk:false}
      }finally{this.editing.delete(g.id);if(staged){g.sources.delete(staged.id);this.port.dispose(staged)}}
    }
    if(name==='request_export'){
      if(a.format!=='markdown'&&a.format!=='pdf')throw new Error('仅支持 markdown 或 pdf 副本');if(this.requests.size>=32||this.pendingExports().length>=4)throw new Error('导出请求过多，请先处理或稍后重试');const nums=a.pages===undefined?g.pages.map((_,i)=>i+1):a.pages;if(!Array.isArray(nums)||!nums.length||nums.length>512)throw new Error('每次导出范围为 1–512 页');const pages=nums.map(n=>pageNumber(n,g.pages.length));if(new Set(pages).size!==pages.length)throw new Error('导出页码重复');const id=uiId();this.requests.set(id,{id,grantId:g.id,revision:rev,format:a.format,pages,name:g.name,state:'pending',time:Date.now()});this.port.changed();this.port.pending();return {requestId:id,state:'pending',requiresUserConfirmation:true}
    }
    if(name==='export_status'){const r=this.requests.get(String(a.requestId));if(r?.grantId!==g.id)throw new Error('无此导出请求');return{requestId:r.id,state:r.state,...(r.state==='failed'?{error:'未能另存副本，请在工作台查看详情。'}:{})}}
    throw new Error('不支持的 PDF 操作')
  }
  async resolveExport(id:string,approve:boolean,save:(r:PendingExport,pages:WorkspacePage[],g:McpGrant,stillValid:()=>boolean)=>Promise<boolean>){const r=this.requests.get(id);if(!r||r.state!=='pending')return;if(!approve){r.state='cancelled';this.port.changed();return}
    try{const g=this.require(r.grantId);this.fence(g,r.revision);r.state='saving';this.port.changed();const valid=()=>{try{this.fence(g,r.revision);return this.requests.get(id)===r}catch{return false}};r.state=await save(r,r.pages.map(n=>g.pages[n-1]),g,valid)?'saved':'cancelled'}catch(e){r.state='failed';this.port.exportError(e instanceof Error?e.message:typeof e==='string'?e:'未能另存副本')}finally{this.port.changed()}
  }
}
