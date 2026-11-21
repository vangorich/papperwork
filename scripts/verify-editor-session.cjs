// Run against local Vite only. PDFs, desktop callbacks, writes and printer are all in memory.
const assert = require('node:assert/strict')
const { chromium } = require('playwright-core')
const { PDFDocument, PDFName, PDFDict } = require('pdf-lib')

async function fixture(path, count) {
  const doc = await PDFDocument.create()
  for (let i = 0; i < count; i++) doc.addPage([200, 240]).drawText(`needle page ${i + 1}`, { x: 12, y: 20, size: 12 })
  return { path, name: path.split('/').pop(), type: 'pdf', desktopGrant: `${path}:original`, bytes: Array.from(await doc.save()) }
}
function mockDesktop() {
  const noop = () => {}, subscribe = key => fn => { window.test[key] = fn; return () => { delete window.test[key] } }
  const state = window.test = { opens: {}, replies: [], prints: [], writes: [], picks: [], outcome: 'ok' }
  state.file = f => ({ ...f, bytes: Uint8Array.from(f.bytes) })
  const write = async (bytes, target, grant) => {
    if (state.outcome === 'cancel') return null
    if (state.outcome === 'fail') throw Error('Synthetic save failed')
    state.writes.push({ target, grant, bytes: Array.from(bytes) }); return target
  }
  window.desktop = {
    getPathForFile: f => state.dropPath ?? '', onOpenFileRequested: subscribe('association'),
    notifyRendererReady: noop, acknowledgeOpenFile: noop, readFileAtPath: async t => state.file(state.opens[t]),
    openFiles: async () => state.picks.map(state.file), overwritePdf: write, savePdf: write, saveExport: write,
    setWorkspaceDirty: value => { state.dirty = value }, onCloseRequest: subscribe('exit'), confirmClose: ok => state.replies.push(ok),
    onSessionReset: () => noop, onVirtualPrintJob: () => noop, takeVirtualPrintJobs: async () => [],
    getVirtualPrinterStatus: async () => ({ installed: false, supported: false }), getOcrStatus: async () => ({}), getOcrCapabilities: async () => ({}),
    getPrinters: async () => [{ name: 'Simulated', isDefault: true }],
    printPages: async pages => {
      const colored = []
      for (const { png } of pages) {
        const bmp = await createImageBitmap(new Blob([png], { type: 'image/png' }))
        const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height
        const ctx = c.getContext('2d'); ctx.drawImage(bmp, 0, 0); bmp.close()
        const data = ctx.getImageData(0, 0, c.width, c.height).data
        let red = false
        for (let i = 0; i < data.length; i += 4) if (data[i] > data[i + 1] + 20) { red = true; break }
        colored.push(red)
      }
      state.prints.push(colored); return true
    },
  }
}
async function run() {
  const url = new URL(process.argv[2] || 'http://127.0.0.1:5193'); assert(['127.0.0.1', 'localhost'].includes(url.hostname))
  const [a, sameName, b] = await Promise.all([fixture('C:/A/report.pdf', 3), fixture('C:/B/report.pdf', 2), fixture('C:/B/second.pdf', 2)])
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'msedge', headless: true })
  const scenarios = {
    async identity(t) {
      await t.open(a); await t.tabs.nth(0).waitFor(); await t.open(sameName); await t.tabs.nth(1).waitFor()
      await t.jump(2); await t.open({ ...a, path: 'c:\\A\\REPORT.pdf' }); await t.selected(0)
      await t.pick(sameName); await t.selected(1); assert.equal(await t.num.inputValue(), '2')
      await t.drop({ ...a, desktopGrant: 'later-drop-grant' }); await t.selected(0); assert.equal(await t.tabs.count(), 2)
      await t.stamp(); await t.save(); assert.equal(await t.p.evaluate(() => test.writes[0].grant), a.desktopGrant, 'reopen must not replace original revision')
      // An actual browser file without a host path must not alias either real file.
      await t.htmlDrop({ ...a, path: '' }); await t.tabs.nth(2).waitFor(); assert.equal(await t.tabs.count(), 3)
    },
    async tabs(t) {
      await t.two(); await t.tabs.nth(0).click(); await t.jump(3); await t.tabs.nth(0).click(); assert.equal(await t.num.inputValue(), '3')
      await t.tabs.nth(1).click(); await t.jump(2); await t.tabs.nth(1).focus(); await t.p.keyboard.press('ArrowLeft'); await t.selected(0)
      assert.equal(await t.num.inputValue(), '3'); assert(await t.tabs.nth(0).evaluate(el => el === document.activeElement))
      await t.p.keyboard.press('ArrowRight'); await t.selected(1); assert.equal(await t.num.inputValue(), '2')
      await t.p.keyboard.press('Shift+F10'); const items = t.p.getByRole('menuitem'); await items.first().waitFor()
      assert(await items.first().evaluate(el => el === document.activeElement)); await t.p.keyboard.press('ArrowDown'); assert(await items.nth(1).evaluate(el => el === document.activeElement))
      await t.p.keyboard.press('Escape'); assert(await t.tabs.nth(1).evaluate(el => el === document.activeElement))
      const more = t.p.locator('.editor-tab__more').nth(0); await more.click(); await items.first().waitFor(); await t.p.keyboard.press('Escape'); assert(await more.evaluate(el => el === document.activeElement))
      await t.p.locator('.editor-tab__close').nth(1).click(); await t.tabs.nth(1).waitFor({state:'detached'}); assert.equal(await t.p.getByRole('dialog').count(),0,'a clean single tab closes without a decision'); await t.selected(0); assert.equal(await t.num.inputValue(),'3')
      await t.p.locator('.mode-switcher').getByRole('button', {name:'工作区',exact:true}).click(); await t.p.getByRole('button',{name:'新建工作区',exact:true}).click()
      await t.p.locator('.workspace-tabs [aria-selected=true]').focus(); await t.p.keyboard.press('ArrowLeft'); await t.p.waitForFunction(() => document.activeElement?.title === '工作区 1'); await t.p.keyboard.press('ArrowRight'); await t.p.waitForFunction(() => document.activeElement?.title === '工作区 2')
    },
    async watermark(t) {
      await t.two(); await t.tabs.nth(0).click(); await t.stamp(); await t.tabs.nth(1).click(); assert.equal(await t.layers.count(), 0, 'A watermark visible on B')
      await t.save(true); await t.print(); await t.tabs.nth(0).click(); await t.layers.first().waitFor(); await t.save(); await t.print()
      assert.deepEqual(await t.p.evaluate(() => test.prints), [[false, false], [true, true, true]])
      const writes = await t.p.evaluate(() => test.writes)
      assert.deepEqual(writes.map(w => w.target), [b.name, a.path])
      for (const [index, w] of writes.entries()) {
        const doc = await PDFDocument.load(Uint8Array.from(w.bytes)); for (const p of doc.getPages()) {
          const xs = p.node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict); assert.equal(!!xs?.keys().length, index === 1, 'saved PDF watermark')
        }
      }
      await t.p.keyboard.press('Control+z'); await t.layers.first().waitFor({ state: 'detached' }); await t.p.keyboard.press('Control+y'); await t.layers.first().waitFor()
      // The print inbox is now a destination picker, not another editor mode.
      // Preserve the old isolation check across two actual workspaces and the reader.
      const modes = t.p.locator('.mode-switcher')
      assert.equal(await modes.getByRole('button',{name:'打印清单',exact:true}).count(), 0)
      for (const createSecond of [false, true]) {
        await modes.getByRole('button', { name:'工作区', exact:true }).click()
        if (createSecond) {
          await t.p.getByRole('button',{name:'新建工作区',exact:true}).click()
          assert.equal(await t.layers.count(),0,'new workspace inherited a watermark')
        }
        await t.drop(a); await t.p.locator('#pdf-stage canvas').first().waitFor(); await t.stamp()
        await t.drop(b); await t.jump(4); await t.layers.first().waitFor(); await t.p.locator('.mode-switcher').getByRole('button', { name: '浏览', exact: true }).click()
        await t.tabs.nth(1).click(); assert.equal(await t.layers.count(), 0)
      }
    },
    async close(t) {
      await t.two(); await t.tabs.nth(0).click(); await t.stamp(); await t.tabs.nth(1).click(); await t.p.keyboard.press('Control+Shift+r') // B is dirty but unmarked
      const guard = t.p.getByRole('dialog', { name: '保存更改？' }); const button = name => guard.getByRole('button', { name, exact: true })
      const closeAll = async () => { await t.p.locator('.editor-tab__more').last().click(); await t.p.getByRole('menuitem', { name: '关闭全部文件' }).click(); await guard.locator('.dialog__panel').waitFor() }
      await closeAll(); assert.match(await guard.innerText(), /report.pdf/); await button('不保存').click(); assert.match(await guard.innerText(), /second.pdf/); await button('取消').click(); assert.equal(await t.tabs.count(), 2)
      for (const outcome of ['cancel', 'fail']) {
        await t.p.evaluate(v => { test.outcome = v }, outcome); await closeAll(); await button('保存').click(); await guard.waitFor({ state: 'detached' }); assert.equal(await t.tabs.count(), 2)
        await t.p.evaluate(() => test.exit()); await guard.locator('.dialog__panel').waitFor(); await button('保存').click(); await guard.waitFor({ state: 'detached' })
      }
      assert.deepEqual(await t.p.evaluate(() => test.replies), [false, false]); await t.p.evaluate(() => { test.outcome = 'ok' })
      await closeAll(); await button('保存').click(); await t.p.waitForFunction(() => document.querySelector('.dialog__document-name')?.textContent === 'second.pdf'); await button('不保存').click()
      await t.tabs.first().waitFor({ state: 'detached' }); assert.deepEqual(await t.p.evaluate(() => test.writes.map(w => w.target)), [a.path]); assert.deepEqual(await t.p.evaluate(() => test.replies), [false, false])
      const saved = await PDFDocument.load(Uint8Array.from(await t.p.evaluate(() => test.writes[0].bytes)))
      assert(saved.getPage(0).node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict)?.keys().length, 'saving inactive A must retain A’s watermark')
    },
    async search(t) {
      // Pause only this fixture's actual PDF.js text extraction. Open/close while it is
      // in flight, release it, and wait for all three real page extractions to finish.
      await t.p.evaluate(async bytes => {
        const { inspectPdf, getPdfPage, releasePdfDocument } = await import('/src/lib/pdf.ts')
        const s = await inspectPdf(Uint8Array.from(bytes), 'probe.pdf', undefined, false)
        const proxy = await getPdfPage(s, 0), proto = Object.getPrototypeOf(proxy), orig = proto.getTextContent
        const gate = new Promise(res => { test.releaseText = res }); test.extracted = new Set()
        proto.getTextContent = async function (...args) { await gate; const out = await orig.apply(this, args); test.extracted.add(this.pageNumber); return out }
        await releasePdfDocument(s)
      }, a.bytes)
      await t.open(a); await t.tabs.first().waitFor(); await t.p.keyboard.press('Control+f'); await t.p.getByText('正在建立索引…', { exact: true }).waitFor()
      await t.p.getByRole('button', { name: '关闭搜索' }).click(); await t.p.evaluate(() => test.releaseText()); await t.p.waitForFunction(() => test.extracted.size >= 3)
      await t.p.keyboard.press('Control+f'); await t.p.locator('#pdf-search').fill('needle'); await t.p.getByRole('option').nth(2).waitFor(); assert.equal(await t.p.getByText('正在建立索引…', { exact: true }).count(), 0)
    },
    async inlineDraft(t) {
      await t.open(a);await t.tabs.first().waitFor()
      const stage=t.p.locator('.app-shell:visible #pdf-stage'), field=stage.locator('textarea[data-inline-draft]')
      const begin=async(x,y)=>{await t.p.getByRole('button',{name:/文本框：/}).click();await stage.locator('.stage-page[data-current] .pdf-page').click({position:{x,y}});await field.waitFor().catch(async err=>{throw Error(`inline input at ${x},${y}: ${err.message}; surface: ${await stage.evaluate(e=>e.innerText.slice(0,420))}; dialogs: ${await t.p.getByRole('dialog').allTextContents()}`)});await field.fill(`Draft ${x}`);await t.p.waitForFunction(()=>test.dirty===true)}
      await begin(48,65);await field.press('Control+s');await t.p.waitForFunction(()=>test.writes.length===1);assert.equal(await stage.locator('[data-annotation-id]').count(),1)
      const saved=await PDFDocument.load(Uint8Array.from(await t.p.evaluate(()=>test.writes[0].bytes)));assert(saved.getPage(0).node.Resources()?.lookupMaybe(PDFName.of('XObject'),PDFDict)?.keys().length,'Ctrl+S included active inline text')
      await t.p.waitForFunction(()=>test.dirty===false);await begin(75,200);await t.p.evaluate(()=>test.exit());const guard=t.p.getByRole('dialog',{name:'保存更改？'});await guard.getByRole('button',{name:'取消',exact:true}).click();assert.equal(await t.tabs.count(),1);assert.equal(await stage.locator('[data-annotation-id]').count(),2);assert.deepEqual(await t.p.evaluate(()=>test.replies),[false]);await t.save();await t.p.waitForFunction(()=>test.dirty===false)
      await begin(100,295);await t.open(b);await t.selected(1);await t.tabs.first().click();assert.equal(await stage.locator('[data-annotation-id]').count(),3,'association switch did not lose the previous draft');assert.equal(await stage.getByRole('textbox',{name:'文本内容'}).last().inputValue(),'Draft 100')
    },
    async narrow(t) {
      await t.open(a); await t.tabs.first().waitFor(); await t.p.locator('.sidebar:visible').waitFor(); await t.p.setViewportSize({ width: 640, height: 850 })
      await t.p.locator('.sidebar-reopen').waitFor(); await t.p.locator('.sidebar-reopen').click(); await t.p.locator('.sidebar:visible').waitFor()
      await t.p.locator('.mode-switcher').getByRole('button', { name: '工作区', exact: true }).click(); const rects = await t.p.locator('.workspace-tabs button').evaluateAll(bs => bs.map(b => [b.getBoundingClientRect().width, b.getBoundingClientRect().height])); assert(rects.length >= 4 && rects.every(([w,h]) => w >= 32 && h >= 32), JSON.stringify(rects))
    },
  }
  let failed = false
  try {
    for (const key of (process.argv.length > 3 ? process.argv.slice(3) : Object.keys(scenarios))) {
      const p = await browser.newPage({ viewport: { width: 1440, height: 940 } }); p.setDefaultTimeout(7000)
      try {
        await p.addInitScript(mockDesktop); await p.goto(url.href); const shell = p.locator('.app-shell:visible'); await shell.waitFor()
        const t = { p, tabs: shell.locator('.editor-tabs [role="tab"]'), num: shell.locator('input[aria-label^="当前页码"]').first(), layers: shell.locator('#pdf-stage .watermark-layer') }
        t.open = f => p.evaluate(f => { const token = crypto.randomUUID(); test.opens[token] = f; test.association(f.path, token) }, f)
        t.drop = f => p.evaluate(f => document.querySelector('.app-shell').dispatchEvent(new CustomEvent('paperwork-native-drop', { detail: [test.file(f)], bubbles: true, cancelable: true })), f)
        t.htmlDrop = f => p.evaluate(f => { test.dropPath = f.path; const dt = new DataTransfer(); dt.items.add(new File([Uint8Array.from(f.bytes)], f.name, {type:'application/pdf'})); document.querySelector('.app-shell').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })) }, f)
        t.pick = async f => { await p.evaluate(f => { test.picks = [f] }, f); await shell.locator('.editor-tabs__add').click() }
        t.two = async () => { await t.open(a); await t.tabs.first().waitFor(); await t.open(b); await t.tabs.nth(1).waitFor() }
        t.selected = i => p.waitForFunction(i => document.querySelectorAll('.editor-tabs [role="tab"]')[i]?.getAttribute('aria-selected') === 'true', i)
        t.jump = async n => { await t.num.fill(String(n)); await t.num.press('Enter') }
        t.stamp = async () => {
          await shell.getByRole('button', { name: '添加水印', exact: true }).click(); const d = p.getByRole('dialog', { name: '插入水印' }); await d.getByText('图片 / 电子章', { exact: true }).click()
          const png = await p.evaluate(() => { const c = document.createElement('canvas'); c.width=c.height=12; const ctx=c.getContext('2d');ctx.fillStyle='#ff0000';ctx.fillRect(0,0,12,12);return c.toDataURL().split(',')[1] })
          await d.locator('input[type=file]').setInputFiles({ name:'red.png', mimeType:'image/png', buffer:Buffer.from(png,'base64') }); await d.getByRole('button', {name:'添加水印',exact:true}).click(); await t.layers.first().waitFor()
        }
        t.save = async (asCopy = false) => { const n = await p.evaluate(() => test.writes.length); await p.keyboard.press(asCopy ? 'Control+Shift+s' : 'Control+s'); await p.waitForFunction(n => test.writes.length === n + 1, n) }
        t.print = async () => { const n = await p.evaluate(() => test.prints.length); await p.keyboard.press('Control+p'); const d=p.getByRole('dialog',{name:'批量打印中心'}); await d.getByRole('button',{name:'开始打印',exact:true}).click(); await p.waitForFunction(n => test.prints.length === n + 1, n); await d.waitFor({state:'detached'}) }
        await scenarios[key](t); console.log(`PASS ${key}`)
      } catch (err) { failed = true; console.error(`FAIL ${key}: ${err.message}`) }
      finally { await p.close() }
    }
  } finally { await browser.close() }
  if (failed) process.exitCode = 1
}
run().catch(e => { console.error(e); process.exitCode = 1 })
