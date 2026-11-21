import type { DocumentWatermark, Markup, PdfSource, WorkspacePage } from '../types/pdf'
import { uid } from './cn'
import { loadPdfPageSizes } from './pdf'
import { fitTextFontSize, rasterizeText } from './text'
import { rotateWorkspacePage } from '../hooks/useWorkspace'

type Params = Record<string, unknown>
const plain = (v:unknown):v is Params => Boolean(v && typeof v==='object' && !Array.isArray(v))
const fail=(why:string):never=>{throw new Error(why)}
const text=(v:unknown,n:number,label:string)=>typeof v==='string' && v.length>0 && v.length<=n && !v.includes('\0') ? v : fail(`${label}必须是 1–${n} 个字符`)
const num=(v:unknown,min:number,max:number,label:string)=>typeof v==='number'&&Number.isFinite(v)&&v>=min&&v<=max ? v : fail(`${label}须在 ${min}–${max} 之间`)
const yes=(v:unknown)=>typeof v==='boolean'?v:fail('需要布尔值')
const keyset=(v:Params,allowed:string[])=>{if(Object.keys(v).some(k=>!allowed.includes(k)))fail('操作含不支持的字段')}
const integer=(v:unknown,min:number,max:number,label:string)=>Number.isInteger(v)?num(v,min,max,label):fail(`${label}必须为整数`)
const rgb=(v:unknown)=>typeof v==='string'&&/^#[\da-f]{6}$/i.test(v)?v:fail('颜色须为 #RRGGBB')
const geometry=(b:unknown)=>{if(!plain(b))throw new Error('需要 box: {x,y,width,height}');keyset(b,['x','y','width','height']);const x=num(b.x,0,1,'x'),y=num(b.y,0,1,'y'),width=num(b.width,.001,1,'width'),height=num(b.height,.001,1,'height');if(x+width>1.000001||y+height>1.000001)fail('对象超出页面');return{x,y,width,height}}
const typeStyle = (v:Params) => ({...(v.fontSize!==undefined?{fontSize:num(v.fontSize,4,240,'fontSize')} : {}),...(v.fontFamily!==undefined?{fontFamily:text(v.fontFamily,80,'字体')}:{}),...(v.bold!==undefined?{bold:yes(v.bold)}:{}),...(v.italic!==undefined?{italic:yes(v.italic)}:{}),...(v.color!==undefined?{color:rgb(v.color)}:{})})
const common=['color','fontSize','fontFamily','bold','italic']
export const editGuide={
  scope:'Each call is one undoable change in the authorized document. Read the current revision first. No call saves or overwrites the original. Use request_export to request a new copy.',
  coordinates:'One-based pages. box:{x,y,width,height} is normalized to the displayed page, top left origin. Angles in clockwise degrees. Color #RRGGBB.',
  operations:{ reorder_pages:{order:'permutation e.g. [3,1,2]'},rotate_page:{page:1,degrees:'90, 180, 270 or -90'}, insert_blank:{after:'0 inserts first'},duplicate_page:{page:1},delete_page:{page:1},crop_page:{page:1,box:'box or null to reset'}, resize_page:{page:1,widthPt:595,heightPt:842},add_object:{page:1,objectType:'text, note, rectangle, ellipse, highlight, ink or image',box:'box',text:'for text / note',imageData:'small PNG data URL for image',points:'array of normalized {x,y} for ink',style:'optional direct fields color, rotation, opacity, strokeWidth, filled, fontFamily, fontSize, bold, italic'},update_object:{page:1,objectId:'from read_page',patch:'box, text, geometry/style fields appropriate to object; no identity/type changes'},delete_object:{page:1,objectId:'from read_page'},set_watermark:{text:'document-wide editable text watermark',box:'box',tiled:false,rotation:0,opacity:.2},remove_watermark:{},replace_native_text:{page:1,find:'exact complete printed text run',replacement:'representable text; unsupported embedded encodings or ambiguous runs explicitly fail. This is not a redaction tool.'}},
}
export type EditResult={pages:WorkspacePage[]; raster?:{page:WorkspacePage;objectId?:string}}|{watermark:DocumentWatermark|undefined}|{native:{page:WorkspacePage;find:string;replacement:string}}
/** Prepare new snapshots before publishing the undoable edit. Source sizes can
 * initially be placeholders; resolve only the target page, never an entire PDF. */
export async function prepareMcpText(edit: Extract<EditResult, { pages: WorkspacePage[] }>, sources: readonly PdfSource[], recheck: () => void) {
  if (!edit.raster) return edit.pages
  const { page, objectId } = edit.raster
  const affected = (a: Markup) => a.type === 'text' && (objectId === undefined || a.id === objectId)
  if (!page.annotations.some(affected)) return edit.pages
  // Resized source content and its annotations are fitted together at export.
  // Their editing surface remains the original viewport, not the output sheet.
  let size = page.pageSize ?? { width: 595.28, height: 841.89 }
  if (page.sourceId !== 'blank') {
    const source = sources.find(s => s.id === page.sourceId)
    if (!source) throw new Error('页面来源已关闭，请重新读取文档')
    await loadPdfPageSizes(source, [page.sourcePage])
    recheck()
    size = source.pageSizes[page.sourcePage]
  }
  if (!size || !Number.isFinite(size.width) || !Number.isFinite(size.height) || size.width <= 0 || size.height <= 0) throw new Error('无法确定页面尺寸，未应用修改')
  const [width, height] = page.rotation % 180 ? [size.height, size.width] : [size.width, size.height]
  const annotations = page.annotations.map(a => {
    if (!affected(a)) return a
    const next = { ...a, pageAspectRatio: width / height, pageHeight: height, fontFamily: a.fontFamily ?? 'Microsoft YaHei',
      fontSize: a.autoFit ? fitTextFontSize(a.text ?? '', a.width * width - 6, a.height * height - 6, a.autoFitMaxSize ?? 28, 4) : a.fontSize ?? 16 }
    return { ...next, imageData: rasterizeText(next) }
  })
  return edit.pages.map(p => p === page ? { ...p, annotations } : p)
}

function patch(obj:Markup,p:Params): Partial<Markup>{
  const typ=obj.type==='text', note=obj.type==='note', shape=['rectangle','ellipse','ink'].includes(obj.type)
  keyset(p,['box','opacity','rotation',...(typ?common.concat('text'):note?['text','color']:['color']),...(shape?['strokeWidth','filled']:[])])
  return {...(p.box!==undefined?geometry(p.box):{}),...(p.text!==undefined?{text:text(p.text,8192,'正文')}:{}),...typeStyle(p),...(p.opacity!==undefined?{opacity:num(p.opacity,.01,1,'opacity')}:{}),...(p.rotation!==undefined?{rotation:num(p.rotation,-360,360,'rotation')}:{}),...(p.strokeWidth!==undefined?{strokeWidth:num(p.strokeWidth,.2,32,'strokeWidth')}:{}),...(p.filled!==undefined?{filled:yes(p.filled)}:{})}
}
function boundedPng(v:unknown){const s=text(v,175000,'PNG');if(!/^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]+=*$/.test(s))fail('仅接受小型 PNG 图像，不接受文件路径或网络地址');const bytes=atob(s.slice(22));if(bytes.length<32||bytes.slice(12,16)!=='IHDR')fail('PNG 无效');const buf=Uint8Array.from(bytes.slice(16,24),c=>c.charCodeAt(0)),d=new DataView(buf.buffer);if(!d.getUint32(0)||!d.getUint32(4)||d.getUint32(0)>4096||d.getUint32(4)>4096||d.getUint32(0)*d.getUint32(4)>4_000_000)fail('图像超过像素上限');return s}
export function planMcpEdit(pages:readonly WorkspacePage[],group:string,operation:unknown):EditResult{
  if(!plain(operation))throw new Error('需要 operation 对象');const {kind,...p}=operation
  if(!Object.hasOwn(editGuide.operations,String(kind)))fail('未知操作；请调用 describe_edits，operation.kind 指定操作名')
  const at=()=>pages[integer(p.page,1,pages.length,'page')-1]
  const update=(old:WorkspacePage,next:WorkspacePage,raster?:string|boolean)=>({pages:pages.map(v=>v===old?next:v),...(raster?{raster:{page:next,objectId:typeof raster==='string'?raster:undefined}}:{})})
  switch(kind){
    case 'reorder_pages':{keyset(p,['order']);if(!Array.isArray(p.order)||p.order.length!==pages.length||new Set(p.order).size!==pages.length)throw new Error('order 必须逐页且不重复');return{pages:p.order.map(n=>pages[integer(n,1,pages.length,'页码')-1])}}
    case 'insert_blank':{keyset(p,['after']);const i=integer(p.after,0,pages.length,'after');return{pages:[...pages.slice(0,i),{id:uid(),sourceId:'blank',sourcePage:0,groupId:group,rotation:0,annotations:[]},...pages.slice(i)]}}
    case 'duplicate_page':{keyset(p,['page']);const old=at();return{pages:pages.flatMap(v=>v===old?[old,{...old,id:uid(),annotations:old.annotations.map(a=>({...a,id:uid(),replies:a.replies?.map(r=>({...r,id:uid()}))}))}]:[v])}}
    case 'delete_page':{keyset(p,['page']);const old=at();if(pages.length<=1)fail('不能删除文档的最后一页');return{pages:pages.filter(v=>v!==old)}}
    case 'rotate_page':{keyset(p,['page','degrees']);const old=at(),d=Number(p.degrees);if(typeof p.degrees!=='number'||![-270,-180,-90,90,180,270].includes(d))fail('仅支持整 90 度的页旋转');return update(old,rotateWorkspacePage(old,d),true)}
    case 'crop_page':{keyset(p,['page','box']);const old=at();return update(old,{...old,crop:p.box===null?undefined:geometry(p.box)})}
    case 'resize_page':{keyset(p,['page','widthPt','heightPt']);const old=at();return update(old,{...old,pageSize:{width:num(p.widthPt,12,4000,'widthPt'),height:num(p.heightPt,12,4000,'heightPt')}},old.sourceId==='blank')}
    case 'add_object':{const {page:_,objectType,points,imageData,...props}=p;const old=at();if(!['text','note','rectangle','ellipse','highlight','ink','image'].includes(String(objectType)))fail('不支持的对象类型');if((imageData!==undefined&&objectType!=='image')||(points!==undefined&&objectType!=='ink'))fail('对象数据与类型不匹配');const obj:Markup={id:uid(),type:objectType as Markup['type'],...geometry(props.box),color:objectType==='text'?'#18324a':'#30302c'};Object.assign(obj,patch(obj,props));if((obj.type==='text'||obj.type==='note')&&!obj.text)fail('需要文字');if(obj.type==='image'){obj.imageData=boundedPng(imageData);obj.imageExportMode='object'}if(obj.type==='ink'){if(!Array.isArray(points)||points.length<2||points.length>1500)throw new Error('墨迹须包含 2–1500 个点');obj.points=points.map(v=>{if(!plain(v))throw new Error('墨迹点无效');return{x:num(v.x,0,1,'x'),y:num(v.y,0,1,'y')}})}return update(old,{...old,annotations:[...old.annotations,obj]},obj.type==='text'&&obj.id)}
    case 'update_object':case 'delete_object':{keyset(p,kind==='delete_object'?['page','objectId']:['page','objectId','patch']);const old=at(),obj=old.annotations.find(a=>a.id===p.objectId);if(!obj)throw new Error('当前页没有该可编辑对象');if(kind==='delete_object')return update(old,{...old,annotations:old.annotations.filter(v=>v!==obj)});if(!plain(p.patch))throw new Error('需要 patch');const next={...obj,...patch(obj,p.patch)};if(obj.type==='text'&&p.patch.fontSize!==undefined)next.autoFit=false;return update(old,{...old,annotations:old.annotations.map(a=>a===obj?next:a)},obj.type==='text'&&obj.id)}
    case 'set_watermark':{keyset(p,['text','box','tiled','rotation','opacity',...common]);return{watermark:{kind:'text',text:text(p.text,512,'水印'),...geometry(p.box),...typeStyle(p),rotation:num(p.rotation??0,-360,360,'rotation'),opacity:num(p.opacity??.2,.01,1,'opacity'),tiled:yes(p.tiled??false)}}}
    case 'remove_watermark':keyset(p,[]);return{watermark:undefined}
    case 'replace_native_text':{keyset(p,['page','find','replacement']);return{native:{page:at(),find:text(p.find,2048,'查找'),replacement:text(p.replacement,2048,'替换')}}}
    default:return fail('不支持该操作')
  }
}
