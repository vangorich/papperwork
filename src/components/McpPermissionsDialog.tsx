import { Dialog,DialogBackdrop,DialogPanel,DialogTitle } from '@headlessui/react'
import { BookOpen, Check, FileOutput, Pencil, ShieldCheck, X } from 'lucide-react'
import type { useMcpWorkspace } from '../hooks/useMcpWorkspace'

export function McpPermissionsDialog({ api,group,name }:{api:ReturnType<typeof useMcpWorkspace>;group?:string;name:string}) {
  const grant=api.forGroup(group)
  return <Dialog open={api.open} onClose={api.close} className="dialog">
    <DialogBackdrop className="dialog__backdrop"/><DialogPanel className="dialog__panel ai-book-panel">
      <div className="dialog__header"><DialogTitle>AI 文档授权</DialogTitle><button type="button" aria-label="关闭授权设置" onClick={api.close}><X size={17}/></button></div>
      <div className="ai-book-source"><ShieldCheck size={20}/><div><strong>{name||'未选择文档'}</strong><small>{grant ? grant.access==='edit'?'已授权 · 可阅读与编辑':'已授权 · 只读' : '未共享'}</small></div></div>
      <p className="dialog__hint">仅把这份文档分享给已连接的本地 MCP 客户端。云端 AI 可能将读取的内容发送给模型。关闭文档或撤销授权后，客户端不能继续读取。</p>
      {group && <div className="ai-book-choices" role="group" aria-label="本次访问权限">
        <button type="button" aria-pressed={grant?.access==='read'} onClick={()=>api.grant(group,'read')}><BookOpen size={16}/>只读{grant?.access==='read'&&<Check size={14}/>}</button>
        <button type="button" aria-pressed={grant?.access==='edit'} onClick={()=>api.grant(group,'edit')}><Pencil size={16}/>允许直接编辑{grant?.access==='edit'&&<Check size={14}/>}</button>
        {grant && <button type="button" onClick={()=>api.revoke(grant.id)}>撤销授权</button>}
      </div>}
      <p className="dialog__hint">编辑直接进入工作台，可以撤销。不会自动写盘。需要保存时，你单独确认副本和位置。</p>
      {api.requests.map(r=><section key={r.id} className="ai-book-export"><div><FileOutput size={17}/><strong>AI 请求导出 {r.format==='pdf'?'PDF':'Markdown'} 副本</strong></div><p>{r.name} · 第 {r.pages.length>10?`${r.pages.slice(0,8).join('、')}…（共 ${r.pages.length} 页）`:r.pages.join('、')} 页</p><div><button type="button" disabled={r.state==='saving'} onClick={()=>void api.respond(r.id,false)}>拒绝</button><button type="button" disabled={r.state==='saving'} onClick={()=>void api.respond(r.id,true)}>{r.state==='saving'?'等待保存':'选择位置并导出'}</button></div></section>)}
    </DialogPanel></Dialog>
}
