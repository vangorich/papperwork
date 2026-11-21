// Local Edge + real qpdf worker. Only the Save As chooser is controlled; writes use a private temp directory.
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { chromium } = require('playwright-core')
const { PDFDocument } = require('pdf-lib')
const url = new URL(process.argv[2] || 'http://127.0.0.1:5207/')
assert.equal(url.hostname, '127.0.0.1')
const preset = process.argv[3] || 'balanced'
assert(['lossless','balanced','strong','compact'].includes(preset))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

function tinyPdf() {
  // Valid classic xref, no metadata or image to optimize. qpdf's ID/trailer costs more than it saves.
  let body = '%PDF-1.4\n'; const offsets = []
  for (const object of ['<</Type/Catalog/Pages 2 0 R>>', '<</Type/Pages/Kids[3 0 R]/Count 1>>', '<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Resources<<>>>>']) {
    offsets.push(body.length); body += `${offsets.length} 0 obj\n${object}\nendobj\n`
  }
  const start = body.length
  return Buffer.from(body + 'xref\n0 4\n0000000000 65535 f \n' + offsets.map(n => String(n).padStart(10, '0') + ' 00000 n \n').join('') + `trailer\n<</Size 4/Root 1 0 R>>\nstartxref\n${start}\n%%EOF\n`)
}

async function imagePdf(pages) {
  const doc = await PDFDocument.create(), w = 1050, h = 760
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([500, 450]), data = Buffer.alloc(w * h * 3)
    for (let y = 0, j = 0; y < h; y++) for (let x = 0; x < w; x++) {
      data[j++] = (x + i * 9) & 255; data[j++] = (y + i * 17) & 255; data[j++] = (x + y) & 255
    }
    const image = doc.context.register(doc.context.stream(data, { Type:'XObject', Subtype:'Image', ColorSpace:'DeviceRGB', BitsPerComponent:8, Width:w, Height:h }))
    const name = page.node.newXObject('Generated', image)
    page.node.addContentStream(doc.context.register(doc.context.stream(`q 470 0 0 320 15 30 cm ${name} Do Q`)))
    page.drawText(`COPY PROOF ${i+1}`, {x:24, y:390, size:12})
  }
  return Buffer.from(await doc.save())
}

async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paperwork-025-compression-'))
  let browser
  try {
    browser = await chromium.launch({channel:'msedge'})
    for (const scenario of ['no-gain', 'worker-cancel', 'retry']) {
      const input = scenario === 'no-gain' ? tinyPdf() : await imagePdf(scenario === 'worker-cancel' ? 6 : 1)
      const source = path.join(dir, `${scenario}.pdf`), copy = path.join(dir, 'copy.pdf'), occupied = path.join(dir, 'occupied.pdf')
      await fs.writeFile(source, input, {flag:'wx'})
      const attempts = [], page = await browser.newPage({ viewport:{width:1280, height:880} })
      try {
        await page.addInitScript(() => {
          const q = window.__qpdf = {created:0, posted:0, stages:[], results:0, terminated:0}
          window.Worker = class extends Worker {
            constructor(url, options) {
              super(url, options); this.isQpdf = String(url).includes('pdfCompression.worker')
              if (this.isQpdf) { q.created++; this.addEventListener('message', ({data}) => {
                if (data.progress) q.stages.push(data.progress.stage); else q.results++
              }) }
            }
            postMessage(...args) { if (this.isQpdf) q.posted++; return super.postMessage(...args) }
            terminate() { if (this.isQpdf) q.terminated++; return super.terminate() }
          }
        })
        await page.exposeFunction('saveProofCopy', async (base64, name) => {
          const bytes = Buffer.from(base64, 'base64'); attempts.push({name, bytes:bytes.length, hash:hash(bytes)})
          assert.equal(scenario, 'retry', 'unexpected Save As')
          if (attempts.length === 1) return null // user dismissed the controlled chooser
          // Second attempt is a real EEXIST, not a manufactured error receipt.
          await fs.writeFile(attempts.length === 2 ? occupied : copy, bytes, {flag:'wx'})
          return copy
        })
        // Isolate this page from unrelated HMR remounts on the shared dev server.
        await page.routeWebSocket(ws => ws.host === url.host && ws.searchParams.has('token'), ws=>ws.send('{"type":"connected"}'))
        await page.goto(url.href); assert.equal(await page.title(), 'Paperwork PDF Studio')
        const choose = page.waitForEvent('filechooser')
        await page.getByRole('button',{name:'压缩 PDF', exact:true}).click()
        await (await choose).setFiles(source)
        const dialog = page.locator('.compression-dialog__panel'), receipt = dialog.locator('.compression-receipt')
        await dialog.getByText(path.basename(source), {exact:true}).waitFor()
        // Installed only after the ordinary browser picker; no real Desktop or shell storage is connected.
        await page.evaluate(() => { window.desktop = { setWorkspaceDirty() {}, savePdfCopy: async (bytes, name) => {
          const base64 = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.onerror = reject; reader.readAsDataURL(new Blob([bytes])) })
          return window.saveProofCopy(base64, name)
        } } })
        const worker = () => page.evaluate(() => window.__qpdf)
        const readReceipt = async re => { await receipt.waitFor(); const text=await receipt.innerText(); assert.match(text,re); return text }
        if (scenario === 'retry') await fs.writeFile(occupied, 'must not change', {flag:'wx'})
        await dialog.locator(`input[value="${preset}"]`).check()
        await dialog.getByRole('button',{name:'压缩并另存为',exact:true}).click()
        if (scenario === 'no-gain') {
          const text = await readReceipt(/没有变小.*未写入文件/)
          assert.equal((await worker()).results, 1); assert.equal(attempts.length, 0)
          assert.equal(await dialog.getByRole('button',{name:'重选保存位置'}).count(), 0)
          await dialog.locator(`input[value="${preset === 'lossless' ? 'balanced' : 'lossless'}"]`).check(); await receipt.waitFor({state:'hidden'})
          console.log('PASS no-gain:', text)
        } else if (scenario === 'worker-cancel') {
          await page.waitForFunction(() => window.__qpdf.stages.includes('loading')) // qpdf has already parsed the object inventory
          await dialog.getByRole('button',{name:'取消压缩',exact:true}).click()
          const text = await readReceipt(/已取消压缩，未写入文件/), q = await worker()
          assert.equal(q.posted, 1); assert.equal(q.terminated, 1); assert.equal(q.results, 0); assert.equal(attempts.length, 0)
          assert(await dialog.getByRole('button',{name:'压缩并另存为'}).isEnabled())
          console.log('PASS worker-cancel:', text, q)
        } else {
          const cancelled = await readReceipt(/已取消另存为.*无需再次压缩/), retry = dialog.getByRole('button',{name:'重选保存位置',exact:true})
          assert.equal(attempts.length, 1); assert.equal((await worker()).posted, 1)
          await retry.click(); const failed = await readReceipt(/保存未完成.*EEXIST.*无需再次压缩/)
          assert.equal(attempts.length, 2); assert.equal(await fs.readFile(occupied, 'utf8'), 'must not change')
          await retry.click(); await dialog.waitFor({state:'hidden'})
          assert.equal(attempts.length, 3); const q = await worker(); assert.deepEqual([q.created,q.posted,q.results,q.terminated], [1,1,1,1])
          assert.deepEqual(attempts, Array(3).fill(attempts[0])); assert.equal(attempts[0].name, 'retry-压缩版.pdf')
          const out = await fs.readFile(copy); assert.equal(hash(out), attempts[0].hash); assert(out.length < input.length); assert.equal((await PDFDocument.load(out)).getPageCount(), 1)
          console.log('PASS controlled Save As cancel / real failed write / cached retry:', cancelled, failed.replaceAll(dir,'<temp>'), `${input.length} -> ${out.length}; 3 saves, 1 worker`)
        }
        assert.equal(hash(await fs.readFile(source)), hash(input))
        assert.equal(await page.locator('.editor-tabs [role="tab"]').count(), 0)
      } catch (e) { console.error(scenario, await page.locator('.compression-dialog__panel').allTextContents(), await page.evaluate(()=>window.__qpdf)); throw e } finally { await page.close() }
    }
  } finally { await browser?.close(); await fs.rm(dir, {recursive:true, force:true}) }
}
main().catch(e => {console.error(e); process.exitCode = 1})
