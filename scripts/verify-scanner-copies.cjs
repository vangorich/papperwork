// Regression on pre-compressed scanner JPEGs, not an uncompressed bitmap. No user file accepted.
const assert=require('node:assert/strict'), fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process'),{chromium}=require('playwright-core')
const python=(code,args)=>{const r=spawnSync('python',['-I','-B','-X','utf8','-c',code,...args],{encoding:'utf8',timeout:120000});if(r.status!==0)throw Error((r.stdout+'\n'+r.stderr).slice(-2400)||'fixture check failed');return r.stdout.trim()}
const make=String.raw`
import sys,io,fitz,numpy as np
from PIL import Image,ImageDraw,ImageFont
file=sys.argv[1];pdf=fitz.open();w,h=2000,3300; font=ImageFont.truetype('arial.ttf',32); small=ImageFont.truetype('simsun.ttc',25)
for i in range(11):
    rng=np.random.default_rng(437+i); bg=np.clip(248+rng.normal(0,4,(h,w)),0,255).astype('uint8');img=Image.fromarray(bg);color=i not in (1,6)
    if color:img=img.convert('RGB')
    d=ImageDraw.Draw(img);fg=('black' if color else 14)
    for row in range(41):d.text((94,160+row*69),f'Local paper scan {i+1}  /  fine reference {row+1:02d}   7316.42',font=font,fill=fg)
    d.text((94,3038),'条款编号 7316.42   核对金额与日期',font=small,fill=fg);d.text((94,3090),'Review 7316.42  /  08:15',font=small,fill=fg)
    shade=lambda v:(v,v,v) if color else v
    d.rectangle((1010,205,1470,295),fill=shade(138)); d.text((1050,218),'9204.76',font=font,fill=shade(96))
    d.line((90,3022,1870,3022),fill='#6095b0' if color else 138,width=2);d.ellipse((1340,2880,1500,3040),outline='#bb3828' if color else 130,width=8)
    b=io.BytesIO();img.save(b,format='JPEG',quality=91,optimize=True);p=pdf.new_page(width=480,height=792);xref=p.insert_image(p.rect,stream=b.getvalue());pdf.xref_set_key(xref,'ColorSpace','/DeviceRGB' if color else '/DeviceGray');pdf.xref_set_key(xref,'Name','/Scan');p.insert_text((20,30),'Selectable native caption',fontsize=7);p.insert_link({'kind':fitz.LINK_GOTO,'from':fitz.Rect(10,10,150,33),'page':0});p.add_text_annot((430,34),'Synthetic note')
    if i==6: pdf.xref_set_key(xref,'Interpolate','true')
pdf.set_toc([[1,'Proof',1]]);pdf.save(file,garbage=4,deflate=True);pdf.close()`
const check=String.raw`
import sys,fitz,numpy as np,json,math
s=fitz.open(sys.argv[1]);d=fitz.open(sys.argv[2]);mode=sys.argv[3];assert len(d)==len(s)==11 and s.get_toc()==d.get_toc();worst=99.;dark=kept=0;changed=0; foot=rule=seal=1.
for p,q in zip(s,d):
    assert p.get_text()==q.get_text() and p.rect==q.rect and len(p.get_links())==len(q.get_links()) and len(list(p.annots()))==len(list(q.annots()))
    a=np.frombuffer(p.get_pixmap(matrix=fitz.Matrix(2,2),alpha=False).samples,dtype=np.uint8).reshape(-1,3);b=np.frombuffer(q.get_pixmap(matrix=fitz.Matrix(2,2),alpha=False).samples,dtype=np.uint8).reshape(-1,3);m=float(np.mean((a.astype('float32')-b)**2));changed+=m>0
    if m:worst=min(worst,10*math.log10(65025/m))
    ink=np.max(a,1)<110;dark+=int(ink.sum());kept+=int((ink&(np.max(b,1)<170)).sum());accent=np.ptp(a,axis=1)>60
    if np.any(accent):assert ((np.ptp(b,axis=1)>24)&accent).sum()/accent.sum()>.97
    if p.number==1:assert q.get_images()[0][5] in ('DeviceGray','Indexed'), 'gray ink channel lost'
    aa=a.reshape(1584,960,3).astype('int16');bb=b.reshape(aa.shape).astype('int16')
    # The 6 pt footnote, 0.48 pt blue rule and red ring are separate targets;
    # a whole-page average can conceal the loss of every stroke in a small region.
    ink=aa[1458:1505,:620].max(2)<155
    # Numerals at 96 on a 138-gray form background must remain distinct. Compare
    # their own local contrast: a whole-page white/black score misses this defect.
    form=aa[103:133,500:613].mean(2); copied=bb[103:133,500:613].mean(2); digits=form<110; background=(form>=136)&(form<=140)
    assert digits.sum()>18 and background.sum()>200 and np.median(copied[background])-np.median(copied[digits])>=21, 'gray digits disappeared into their form background'
    assert ink.any();foot=min(foot,float(np.mean(bb[1458:1505,:620].max(2)[ink]<195)))
    if p.number==6 and mode=='compact':
        im=q.get_images()[0];assert im[5]=='DeviceGray' and im[2]<2000 and d.xref_get_key(im[0],'Interpolate')==('bool','true'), 'interpolated grayscale must stay continuous and reduce resolution safely'
    if p.number not in (1,6):
        ac,bc=aa[1448:1454,:600],bb[1448:1454,:600];ink=ac[:,:,2]-ac[:,:,0]>20
        assert ink.any();rule=min(rule,float(np.mean((bc[:,:,2]-bc[:,:,0])[ink]>12)))
        ac,bc=aa[1378:1465,636:725],bb[1378:1465,636:725];ink=ac[:,:,0]-ac[:,:,1]>60
        assert ink.any();seal=min(seal,float(np.mean((bc[:,:,0]-bc[:,:,1])[ink]>30)))
print(json.dumps({'worstPSNR':round(worst,2),'darkRetention':round(kept/dark,4),'footnoteInk':round(foot,4),'fineBlueLine':round(rule,4),'redSeal':round(seal,4),'changedPages':changed}));assert (mode!='lossless' or changed==0) and worst>=28 and kept/dark>.96 and min(foot,rule,seal)>.96`
const recognition=String.raw`
import sys,fitz,json,tempfile,os,subprocess,difflib,unicodedata
from pathlib import Path
root=Path(sys.argv[3]);exes=list((root/'src-tauri/target/x86_64-pc-windows-msvc/debug/deps').glob('folio_ocr_layout_025-*.exe'));assert exes,'Build the Windows layout OCR test adapter first';exe=max(exes,key=lambda e:e.stat().st_mtime)
def normalized(s):return ''.join(c for c in unicodedata.normalize('NFKC',s).lower() if c.isalnum() or c in '.:')
def recognize(pdf):
    with fitz.open(pdf) as doc,tempfile.TemporaryDirectory(prefix='paperwork-layout-025-') as folder:
        tmp=Path(folder);sheets=['control','mixed','skew']
        for sheet,p in zip(sheets,[0,1,10]):
            doc[p].get_pixmap(matrix=fitz.Matrix(4,4),clip=fitz.Rect(16,661,275,754),alpha=False).save(tmp/(sheet+'.png'))
        subprocess.run([str(exe),'--ignored','--exact','recognize_generated_sheets'],env=dict(os.environ,PAPERWORK_LAYOUT_025_QA=folder),stdout=subprocess.DEVNULL,check=True,timeout=80)
        runs=json.loads((tmp/'recognition.json').read_text('utf-8'))['runs'];answers=[]
        for sheet in sheets:
            best=next(r['result'] for r in runs if r['sheet']==sheet and r['profile']);answers.append(normalized(best['text']))
        return answers
scores=[]
for index,(a,b) in enumerate(zip(recognize(sys.argv[1]),recognize(sys.argv[2]))):
    page=[1,2,11][index];expected=normalized(' '.join([f'Local paper scan {page} / fine reference {row:02d} 7316.42' for row in (39,40,41)]+['条款编号 7316.42 核对金额与日期','Review 7316.42 / 08:15']))
    ratio=lambda x,y:round(difflib.SequenceMatcher(None,x,y,autojunk=False).ratio(),4);before=ratio(a,expected);after=ratio(b,expected);match=ratio(a,b)
    scores.append(dict(page=page,originalVsPrinted=before,copyVsPrinted=after,copyVsOriginal=match));assert before>.83 and after>=before-.06 and match>.87,scores
print(json.dumps(scores))`
async function main(){const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'paperwork-scanner-')),input=path.join(tmp,'scan.pdf'),origin='http://127.0.0.1:' + Number(process.env.PAPERWORK_COMPRESSION_PORT || 5207);let browser
try{python(make,[input]);const size=(await fs.stat(input)).size;browser=await chromium.launch({channel:'msedge'});const p=await browser.newPage({serviceWorkers:'block'});await p.route(/^https?:\/\//,r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());await p.goto(origin);await p.evaluate(()=>{const f=document.createElement('input');f.type='file';f.id='local-scan';document.body.append(f)});await p.locator('#local-scan').setInputFiles(input)
const data={};for(const mode of ['lossless','balanced','strong','compact']){const download=p.waitForEvent('download',{timeout:220000});const stats=await p.evaluate(async mode=>{const src=new Uint8Array(await document.querySelector('#local-scan').files[0].arrayBuffer());const {compressSource}=await import('/src/lib/pdfCompression.ts');const hash=async()=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',src))).join();const before=await hash();let total=0;const result=await compressSource({bytes:src},{mode},p=>{if(p.stage==='optimizing')total=Math.max(total,p.total)});if(before!==await hash())throw Error('input bytes changed');const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([result.bytes],{type:'application/pdf'}));a.download='copy.pdf';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),2000);return {total,bytes:result.bytes.length,gain:result.savingsRatio}},mode);const out=path.join(tmp,mode+'.pdf');await(await download).saveAs(out);data[mode]={...stats,...JSON.parse(python(check,[input,out,mode]))};console.log(mode,'input',size,'result',JSON.stringify(data[mode]))}
assert(data.balanced.gain>.15&&data.strong.gain>data.balanced.gain&&data.strong.changedPages===11,'pre-compressed scan savings or whole-document coverage insufficient');assert(data.compact.total===11&&data.compact.changedPages===11&&data.compact.gain>.75&&data.compact.bytes<data.strong.bytes,'compact must exceed 75% without flattening or losing ink on this fixture');
if(process.argv.includes('--ocr'))console.log('Windows OCR (6 pt footer and final three rows), normalized character similarity:',python(recognition,[input,path.join(tmp,'compact.pdf'),path.resolve(__dirname,'..')]));console.log('PASS structural preservation, scan coverage, small ink and colour')
}finally{await browser?.close();await fs.rm(tmp,{recursive:true,force:true})}}
main().catch(e=>{console.error(e.message);process.exitCode=1})
