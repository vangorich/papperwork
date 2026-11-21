// Browser print acceptance: only synthetic fixtures, no printer or network services.
// Run the local Vite server first (npm run dev:web); pass its loopback URL.
const { chromium } = require('playwright-core')
const { PDFDocument, rgb } = require('pdf-lib')
const assert = require('node:assert/strict')
async function fixture(sizes){const doc=await PDFDocument.create();for(const [w,h] of sizes){const page=doc.addPage([w,h]);page.drawRectangle({x:8,y:8,width:12,height:12,color:rgb(0,0,1)})}return Buffer.from(await doc.save())}
async function main(){
  const u=new URL(process.argv[2]||'http://127.0.0.1:5173');assert(['localhost','127.0.0.1'].includes(u.hostname));
  const browser=await chromium.launch({channel:process.env.BROWSER_CHANNEL||'msedge',headless:true});
  try {
    const view=await browser.newPage({viewport:{width:1440,height:950}});await view.goto(u.href);const shell=view.locator('.app-shell:visible').first();await shell.waitFor();
    // Render final composed artwork and the physical-print raster independently, sampling
    // a registration mark present only in the workspace watermark, never in the original.
    const proof=await view.evaluate(async data=>{
      const { inspectPdf,pagesForSource,composePdf,rasterizePdfForPrint,releasePdfDocument }=await import('/src/lib/pdf.ts'); const { makePrintProof }=await import('/src/lib/printProof.ts');
      const s=await inspectPdf(Uint8Array.from(data),'test.pdf',undefined,false), rows=pagesForSource(s);
      try {
        const tile=document.createElement('canvas');tile.width=tile.height=8;const t=tile.getContext('2d');t.fillStyle='#df2028';t.fillRect(0,0,8,8);
        const wm={kind:'image',imageData:tile.toDataURL(),opacity:1,rotation:0,tiled:false,x:.35,y:.35,width:.3,height:.3,gapX:.1,gapY:.1};
        const pr=await makePrintProof(rows[0],[s],wm,200);const saved=await composePdf(rows,[s],{watermark:wm,watermarkPageIds:new Set([rows[0].id])}); const rasters=await rasterizePdfForPrint(saved,{dpi:72});
        async function red(blob){const i=await createImageBitmap(blob);const c=document.createElement('canvas');c.width=c.height=1;const ctx=c.getContext('2d');ctx.drawImage(i,Math.floor(i.width/2),Math.floor(i.height/2),1,1,0,0,1,1);i.close();const [r,g,b]=ctx.getImageData(0,0,1,1).data;return r>170 && g<100 && b<100}
        return {size:[pr.widthPt,pr.heightPt],previewRed:await red(await(await fetch(pr.url)).blob()),printedRed:await Promise.all(rasters.map(r=>red(new Blob([r.png],{type:'image/png'}))))}
      } finally {releasePdfDocument(s)}
    },Array.from(await fixture([[200,300],[210,310]])));
    assert.deepEqual(proof,{size:[200,300],previewRed:true,printedRed:[true,false]});
    const load=async (name,sizes)=>{const b=await fixture(sizes);await view.evaluate(({name,body})=>{const dt=new DataTransfer();dt.items.add(new File([Uint8Array.from(body)],name,{type:'application/pdf'}));document.querySelector('.app-shell:not([hidden])').dispatchEvent(new DragEvent('drop',{dataTransfer:dt,bubbles:true,cancelable:true}))},{name,body:Array.from(b)});await shell.locator('.editor-tabs__tab,[role="tab"]').filter({hasText:name}).first().waitFor()};
    await load('First-proof.pdf',[[200,300],[210,310]]);await load('Second-proof.pdf',[[400,300],[450,350],[500,400]]);
    await shell.getByRole('tab',{name:/First-proof\.pdf/}).click();await view.keyboard.press('Control+p');const dialog=view.getByRole('dialog',{name:'批量打印中心'});await dialog.waitFor({state:'attached'});await dialog.locator('.dialog__panel').waitFor();
    assert.equal(await dialog.locator('.print-preview__page').count(),2,'Ctrl+P in reader must not include other open documents');
    await dialog.locator('input[name="reverse"]').check();const dl=view.waitForEvent('download');await dialog.getByRole('button',{name:'生成待打印 PDF',exact:true}).click();const out=await dl;let stream=await out.createReadStream();const chunks=[];for await (const x of stream)chunks.push(x);const doc=await PDFDocument.load(Buffer.concat(chunks));assert.deepEqual(doc.getPages().map(p=>p.getSize()),[{width:210,height:310},{width:200,height:300}]);
    console.log(JSON.stringify({watermark:proof,openTabs:2,queuedFileCount:1,browserPdfOrder:'2→1',exported:out.suggestedFilename()}))
  } finally {await browser.close()}
}
main().catch(e=>{console.error(e);process.exitCode=1})
