import { describe, it, expect, vi } from 'vitest'
import { McpSession, type McpModel, type McpPorts } from './mcpSession'
import { planMcpEdit } from './mcpEdit'
import * as pdf from './pdf'
import type { WorkspacePage, PdfSource } from '../types/pdf'
function setup(){
  const page=(s:string,i:number):WorkspacePage=>({id:s+i,sourceId:s,sourcePage:i,rotation:0,annotations:[]})
  const source=(id:string):PdfSource=>({id,name:id+'.pdf',bytes:new Uint8Array([1]),pageCount:2,pageText:[],pageSizes:[],textIndexed:false})
  let model:McpModel={sources:[source('A'),source('B')],pages:[page('A',0),page('A',1),page('B',0)],watermarks:new Map()}
  const ports:McpPorts={model:()=>model,read:async p=>p.sourceId+' page '+(p.sourcePage+1),rewrite:async()=>source('staged'),dispose:vi.fn(),apply(g,old,next,staged){expect(old).toEqual(model.pages.filter(p=>(p.groupId??p.sourceId)===g));model={...model,sources:staged?[...model.sources,staged]:model.sources,pages:[...next,...model.pages.filter(p=>(p.groupId??p.sourceId)!==g)]};return true},watermark:vi.fn(),changed:()=>{},editNotice:()=>{},exportError:vi.fn(),pending:()=>{}}
  const s=new McpSession(ports), call=(name:string,args:Record<string,unknown>={},live=async()=>true)=>s.dispatch({id:'r',name,args},live)
  return {s,call,ports,view:()=>model,load:(pages:WorkspacePage[])=>{model={...model,pages}},source,page}
}
describe('live PDF grants',()=>{
  it('never discloses unopened/unshared documents, stale IDs or readonly mutations',async()=>{const {s,call}=setup();expect(await call('list_documents')).toEqual({documents:[]});const g=s.grant('A','read');expect(await call('read_page',{documentId:g.id,page:2})).toMatchObject({page:2,text:'A page 2'});await expect(call('edit_document',{documentId:g.id,revision:g.revision,operation:{kind:'rotate_page',page:1,degrees:90}})).rejects.toThrow('只授权');await expect(call('read_page',{documentId:'B',page:1})).rejects.toThrow('未授权');const h=s.grant('A','edit');expect(h.id).not.toBe(g.id);await expect(call('search',{documentId:g.id,query:'page'})).rejects.toThrow('撤销');s.revoke(h.id);expect(await call('list_documents')).toEqual({documents:[]})})
  it('rejects stale edits, updates page order, and never edits a second file',async()=>{const {s,call,view}=setup(),g=s.grant('A','edit'),rev=g.revision;const op={kind:'reorder_pages',order:[2,1]};expect(await call('edit_document',{documentId:g.id,revision:rev,operation:op})).toMatchObject({applied:true,storedOnDisk:false});expect(view().pages.map(x=>x.id)).toEqual(['A1','A0','B0']);await expect(call('edit_document',{documentId:g.id,revision:rev,operation:op})).rejects.toThrow('版本');expect(await call('search',{documentId:g.id,query:'page 1'})).toMatchObject({matches:[{page:2}]})})
  it('does not expose a newly pasted source or finish an asynchronous read after revocation',async()=>{const {s,call,ports,view,load,page}=setup(),g=s.grant('A','edit');ports.read=async()=>{s.revoke(g.id);return 'should not escape'};await expect(call('read_page',{documentId:g.id,page:1})).rejects.toThrow('撤销');const g2=s.grant('A','read');load([...view().pages,{...page('B',1),groupId:'A'}]);await expect(call('read_page',{documentId:g2.id,page:1})).rejects.toThrow('撤销')})
  it('discards a staged native rewrite if authorization disappeared before it completed',async()=>{const {s,call,ports,source,view}=setup(),g=s.grant('A','edit');ports.rewrite=async()=>{s.revoke(g.id);return source('stage')};await expect(call('edit_document',{documentId:g.id,revision:g.revision,operation:{kind:'replace_native_text',page:1,find:'old',replacement:'new'}})).rejects.toThrow('撤销');expect(ports.dispose).toHaveBeenCalledOnce();expect(view().pages[0].sourceId).toBe('A')})
  it('does not mutate when request expires or count a cancelled export as saved',async()=>{const {s,call,view}=setup(),g=s.grant('A','edit');await expect(call('edit_document',{documentId:g.id,revision:g.revision,operation:{kind:'delete_page',page:1}},async()=>false)).rejects.toThrow('过期');expect(view().pages).toHaveLength(3);const {requestId}=await call('request_export',{documentId:g.id,format:'pdf',pages:[2]}) as {requestId:string};const noWrite=vi.fn(async()=>true);await s.resolveExport(requestId,false,noWrite);expect(noWrite).not.toHaveBeenCalled();expect(await call('export_status',{documentId:g.id,requestId})).toMatchObject({state:'cancelled'})})
  it('checks the grant again after selecting a save location',async()=>{const {s,call}=setup(),g=s.grant('A','read');const {requestId}=await call('request_export',{documentId:g.id,format:'markdown'}) as {requestId:string};let writable=true;await s.resolveExport(requestId,true,async(_r,_pages,_g,valid)=>{s.revoke(g.id);writable=valid();return writable});expect(writable).toBe(false);expect(s.pendingExports()).toEqual([])})
  it('rechecks the grant after resolving the target page size and before creating its text snapshot', async () => {
    const { s, call, view } = setup(), g = s.grant('A','edit'), before = view()
    const sizes = vi.spyOn(pdf, 'loadPdfPageSizes').mockImplementationOnce(async (source, indices) => {
      expect(source.id).toBe('A'); expect(indices).toEqual([1]); s.revoke(g.id)
    })
    try {
      await expect(call('edit_document', {documentId:g.id, revision:g.revision, operation:{kind:'add_object', page:2, objectType:'text', text:'新字', box:{x:.1,y:.1,width:.3,height:.2}}})).rejects.toThrow('撤销')
      expect(sizes).toHaveBeenCalledOnce(); expect(view()).toBe(before); expect(await call('list_documents')).toEqual({documents:[]})
    } finally {sizes.mockRestore()}
  })
  it('keeps destination errors in the GUI, never in a client status', async () => {
    const { s, call, ports } = setup(), g = s.grant('A','read')
    for (const detail of [new Error('Synthetic folder/one.pdf'), 'Synthetic folder/two.pdf']) {
      const { requestId } = await call('request_export', {documentId:g.id, format:'pdf'}) as {requestId:string}
      await s.resolveExport(requestId, true, async () => { throw detail })
      expect(ports.exportError).toHaveBeenLastCalledWith(detail instanceof Error ? detail.message : detail)
      expect(await call('export_status', {documentId:g.id, requestId})).toEqual({requestId, state:'failed', error:'未能另存副本，请在工作台查看详情。'})
    }
  })
  it('releases a staged source without admitting it if the final local apply guard rejects', async () => {
    const { s, call, ports, view } = setup(), g = s.grant('A','edit'), before = view()
    ports.apply = () => { throw new Error('本地输入未提交，请重新读取') }
    await expect(call('edit_document', {documentId:g.id, revision:g.revision, operation:{kind:'replace_native_text', page:1, find:'old', replacement:'new'}})).rejects.toThrow('重新读取')
    expect(g.sources).toEqual(new Set(['A'])); expect(ports.dispose).toHaveBeenCalledOnce(); expect(view()).toBe(before)
  })
})
describe('typed document edits',()=>{
  it('updates and removes exactly the selected annotation; bounds and identities cannot be injected',()=>{const {page}=setup();const p=page('A',0),box={x:.1,y:.15,width:.3,height:.08},out=planMcpEdit([p],'A',{kind:'add_object',page:1,objectType:'text',box,text:'Proof',italic:true});if(!('pages' in out))throw Error();const o=out.pages[0].annotations[0];expect(o).toMatchObject({...box,text:'Proof',italic:true});const edit=planMcpEdit(out.pages,'A',{kind:'update_object',page:1,objectId:o.id,patch:{text:'final'}});if(!('pages' in edit))throw Error();expect(edit.pages[0].annotations[0]).toMatchObject({id:o.id,text:'final'});expect(()=>planMcpEdit(edit.pages,'A',{kind:'update_object',page:1,objectId:o.id,patch:{id:'bad'}})).toThrow();expect(()=>planMcpEdit([p],'A',{kind:'crop_page',page:1,box:{...box,x:.99}})).toThrow();expect(()=>planMcpEdit([p],'A',{kind:'reorder_pages',order:[2]})).toThrow()})
})
