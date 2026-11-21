// Run against an isolated Vite server: node scripts/verify-print-inbox-025.cjs http://127.0.0.1:<port>.
// Only the desktop boundary is mocked. No spool files, native printers or disk exports.
const assert = require('node:assert/strict')
const { chromium } = require('playwright-core')
const { PDFDocument } = require('pdf-lib')
const address = new URL(process.argv[2] || 'http://127.0.0.1:5207')
assert(address.protocol === 'http:' && address.hostname === '127.0.0.1' && address.href === address.origin + '/', 'use the isolated loopback server only')
const origin = address.origin

async function job(id, widths) {
  const pdf = await PDFDocument.create()
  widths.forEach((w, i) => pdf.addPage([w, 220]).drawText(`${id}-${i + 1}`, { x: 12, y: 180, size: 13 }))
  return { id, name: `${id}.pdf`, path: `mock-inbox/${id}.pdf`, type: 'pdf', bytes: Array.from(await pdf.save()) }
}

function mockDesktop() {
  const s = window.inboxProbe = { pending: [], attempts: [], acked: [], loaded: [], listeners: new Set(), reads: 0, writes: [], prints: [] }
  s.signal = () => s.listeners.forEach(fn => fn())
  const noop = () => {}, off = () => noop
  window.desktop = {
    onOpenFileRequested: off, notifyRendererReady: noop, onCloseRequest: off, onSessionReset: off, setWorkspaceDirty: noop,
    getOcrStatus: async () => ({}), getOcrCapabilities: async () => ({}), getVirtualPrinterStatus: async () => ({ installed: false, supported: false }),
    onVirtualPrintJob(fn) { s.listeners.add(fn); return () => s.listeners.delete(fn) },
    async takeVirtualPrintJobs(excluded = []) {
      s.reads++ // Like both desktop bridges, load just the first eligible PDF.
      const j = s.pending.find(j => !excluded.includes(j.id))
      if (!j) return []
      s.loaded.push(j.id)
      return [{ ...j, bytes: Uint8Array.from(s.truncated === j.id ? j.bytes.slice(0, 8) : j.bytes) }]
    },
    async acknowledgeVirtualPrintJobs(ids) {
      s.attempts.push([...ids])
      if (ids.includes(s.holdAck)) await new Promise(resolve => { s.releaseAck = resolve })
      if (ids.includes(s.failAck)) throw Error('模拟回执失败')
      for (const id of ids) {
        const i = s.pending.findIndex(j => j.id === id)
        if (i < 0) throw Error(`unexpected acknowledgment: ${id}`)
        s.pending.splice(i, 1); s.acked.push(id)
      }
    },
    async savePdf(bytes, name) { s.writes.push(Array.from(bytes)); return name },
    getPrinters: async () => [{ name: 'Memory printer', isDefault: true }],
    async printPages(pages) { s.prints.push(pages.map(p => p.widthPt)); return true },
  }
}

async function run() {
  const [a, b, c] = await Promise.all([job('Alpha', [150, 160]), job('Bravo', [174, 192]), job('Charlie', [213])])
  const browser = await chromium.launch({ channel: 'msedge', headless: true, timeout: 12000 })
  const deadline = setTimeout(() => void browser.close(), 90000)
  let phase = 'open loopback app'
  try {
    const p = await browser.newPage({ viewport: { width: 1680, height: 960 }, serviceWorkers: 'block', acceptDownloads: false, reducedMotion: 'reduce' })
    p.setDefaultTimeout(8000); p.setDefaultNavigationTimeout(12000)
    const errors = []; p.on('pageerror', e => { errors.push(e.message); console.error('Renderer:', e.message) })
    await p.route(/^https?:\/\//, route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
    await p.clock.install()
    await p.addInitScript(mockDesktop)
    await p.goto(origin, { waitUntil: 'domcontentloaded' })
    const shell = p.locator('.app-shell:visible'), picker = p.getByRole('dialog', { name: '加入哪个工作区？' })
    const tab = name => shell.getByRole('tablist', { name: '工作区', exact: true }).getByRole('tab', { name, exact: true })
    const selected = name => shell.getByRole('tab', { name, exact: true, selected: true }).waitFor()
    const button = (root, name) => root.getByRole('button', { name, exact: true })
    const menu = async (group, item) => {
      await button(shell.getByRole('toolbar', { name: 'PDF 编辑工具栏' }), group).click()
      await p.getByRole('menu', { name: group, exact: true }).getByRole('menuitem', { name: item, exact: true }).click()
    }
    const reopen = () => menu('文件操作', '打印收件箱')
    const enqueue = j => p.evaluate(j => { inboxProbe.pending.push(j); inboxProbe.signal(); inboxProbe.signal() }, j)
    const pending = () => p.evaluate(() => inboxProbe.pending.map(j => j.id))
    const attempts = () => p.evaluate(() => inboxProbe.attempts)
    const ack = id => p.waitForFunction(id => inboxProbe.acked.includes(id), id)
    const proposal = async (j, pages, suggested) => {
      await picker.getByText(`本地打印机 · ${j.name} · 共 ${pages} 页`, { exact: true }).waitFor()
      const radio = picker.getByRole('radio').filter({ has: p.getByText(`加入工作区：${suggested}`, { exact: true }) })
      assert.equal(await radio.getAttribute('aria-checked'), 'true', 'new workspace must be selected by default')
    }
    const join = pages => button(picker, `加入 ${pages} 页`).click()
    const thumbs = shell.locator('.thumbnail-list .thumbnail[data-page-id]')
    const ids = async n => {
      if (n) await thumbs.nth(n - 1).waitFor({ state: 'attached' }); else await thumbs.first().waitFor({ state: 'detached' })
      const rows = await thumbs.evaluateAll(els => els.map(el => el.dataset.pageId))
      assert.equal(rows.length, n, 'wrong number of workspace pages'); assert.equal(new Set(rows).size, n)
      return rows
    }
    const one = '打印任务 1', two = '打印任务 2'
    await shell.locator('.mode-switcher').waitFor()
    assert.equal(await button(shell.locator('.mode-switcher'), '打印清单').count(), 0)
    await p.waitForFunction(() => inboxProbe.listeners.size === 1 && inboxProbe.reads > 0)

    phase = 'consecutive arrivals and cancel'
    await enqueue(a); await proposal(a, 2, one)
    await enqueue(b); await proposal(a, 2, one) // New and repeated notifications cannot replace the open choice.
    assert.deepEqual(await pending(), [a.id, b.id]); assert.deepEqual(await attempts(), [])
    await join(2); await ack(a.id); await proposal(b, 2, two)
    await button(picker, '取消').click(); await picker.waitFor({ state: 'detached' })
    const reads = await p.evaluate(() => { const n = inboxProbe.reads; inboxProbe.signal(); return n })
    await p.waitForFunction(n => inboxProbe.reads > n, reads)
    await selected(one); assert.equal(await tab(two).count(), 0); assert.deepEqual(await pending(), [b.id])
    assert.deepEqual(await attempts(), [[a.id]]); assert.equal(await picker.count(), 0)
    const protectedIds = await ids(2)

    phase = 'reopen and retry acknowledgment without importing twice'
    await reopen(); await proposal(b, 2, two)
    await p.evaluate(id => { inboxProbe.failAck = id }, b.id)
    await join(2); await p.getByRole('status').filter({ hasText: '模拟回执失败' }).waitFor(); await selected(two)
    const bIds = await ids(2)
    assert.deepEqual(await pending(), [b.id]); assert((await attempts()).some(ids => ids.length === 1 && ids[0] === b.id))
    await p.evaluate(() => { inboxProbe.failAck = null }); await reopen(); await ack(b.id)
    const throughB = await attempts()
    assert.deepEqual(throughB[0], [a.id]); assert(throughB.length >= 3 && throughB.slice(1).every(ids => ids.length === 1 && ids[0] === b.id))
    const emptyNotice = p.getByRole('status').filter({ hasText: '没有待加入的打印文件' }); await emptyNotice.waitFor()
    assert.deepEqual(await ids(2), bIds); assert.deepEqual(await pending(), []); assert.equal(await picker.count(), 0)
    await button(emptyNotice, '关闭收件箱提示').click()

    phase = 'failed PDF import and explicit inactive destination'
    await tab(one).click(); await selected(one); assert.deepEqual(await ids(2), protectedIds)
    await p.evaluate(id => { inboxProbe.truncated = id }, c.id)
    await enqueue(c); await button(p, '关闭收件箱提示').waitFor()
    assert.equal(await picker.count(), 0); assert.deepEqual(await pending(), [c.id]); assert.deepEqual(await ids(2), protectedIds)
    assert.deepEqual(await attempts(), throughB)
    await p.evaluate(() => { inboxProbe.truncated = null }); await reopen(); await proposal(c, 1, '打印任务 3')
    const existing = picker.getByRole('radio', { name: two, exact: true }); await existing.click()
    assert.equal(await existing.getAttribute('aria-checked'), 'true'); await join(1); await ack(c.id); await selected(two)
    const order = await ids(3); assert.deepEqual(order.slice(0, 2), bIds)
    assert.deepEqual(await pending(), []); assert.deepEqual(await attempts(), [...throughB, [c.id]])
    assert.deepEqual(await p.evaluate(() => inboxProbe.acked), [a.id, b.id, c.id]); assert.equal(await tab('打印任务 3').count(), 0)
    console.log('PASS W02: consecutive and duplicate notices, cancel/reopen, new 1 then 2, failed ack and failed import retried, existing destination only')

    phase = 'reverse, preview, export, mock print and undo'
    await menu('页面整理', '反转顺序'); assert.deepEqual(await ids(3), [...order].reverse())
    for (const [i, label] of ['Charlie-1', 'Bravo-2', 'Bravo-1'].entries()) {
      await thumbs.nth(i).click()
      await shell.locator('#pdf-stage .stage-page[data-current] .text-layer').getByText(label, { exact: true }).waitFor({ state: 'attached' })
    }
    const reversedWidths = [213, 192, 174]
    await menu('页面整理', '合并导出'); await p.waitForFunction(() => inboxProbe.writes.length === 1)
    const copy = await PDFDocument.load(Uint8Array.from(await p.evaluate(() => inboxProbe.writes[0])))
    assert.deepEqual(copy.getPages().map(pg => pg.getWidth()), reversedWidths, 'merged copy page order')
    await menu('文件操作', '批量打印 / 打印设置')
    const print = p.getByRole('dialog', { name: '批量打印中心' })
    await print.locator('.print-preview__page').nth(2).waitFor(); assert.equal(await print.locator('.print-preview__page').count(), 3)
    await button(print, '开始打印').click(); await p.waitForFunction(() => inboxProbe.prints.length === 1); await print.waitFor({ state: 'detached' })
    assert.deepEqual(await p.evaluate(() => inboxProbe.prints[0]), reversedWidths, 'print packet page order')
    await tab(one).click(); await selected(one); assert.deepEqual(await ids(2), protectedIds, 'reverse must not touch the other workspace')
    await tab(two).click(); await selected(two); assert.deepEqual(await ids(3), [...order].reverse())
    await p.keyboard.press('Control+z'); assert.deepEqual(await ids(3), order)

    phase = 'cancel and confirm clear; protect the other workspace'
    const clear = p.getByRole('dialog', { name: '清空全部页面？' })
    await menu('页面整理', '全部清空'); await button(clear, '取消').click(); assert.deepEqual(await ids(3), order)
    await menu('页面整理', '全部清空'); await button(clear, '确认删除').click(); await ids(0)
    await tab(one).click(); await selected(one); assert.deepEqual(await ids(2), protectedIds)
    await tab('工作区 1').click(); await selected('工作区 1'); await ids(0)
    console.log('PASS W01: thumbnail/reader/export/mock print order, undo, clear confirmation and workspace isolation')

    phase = 'suggested workspace is a ghost, not a project'
    const allTabs = () => shell.locator('.workspace-tabs__list [role="tab"]').allTextContents()
    const before = await allTabs(), draft = picker.locator('[data-draft]'), draftRadio = draft.getByRole('radio')
    const assertDraft = async state => {
      assert.equal(await draft.getAttribute('data-draft'), state)
      assert.equal(await draftRadio.evaluate(el => getComputedStyle(el).borderTopStyle), state === 'ghost' ? 'dashed' : 'solid')
      assert.equal(await draft.getByText(state === 'ghost' ? '待创建' : '加入时创建', { exact: true }).count(), 1)
    }
    const d = await job('Delta', [230]); await enqueue(d); await proposal(d, 1, '打印任务 3'); await assertDraft('ghost')
    await draftRadio.hover(); await draftRadio.focus(); await assertDraft('ghost')
    await draftRadio.click(); await assertDraft('chosen'); assert.deepEqual(await allTabs(), before)
    await picker.getByRole('radio', { name: one, exact:true }).click(); await assertDraft('ghost')
    await button(picker,'新建工作区').click(); await assertDraft('chosen')
    const newInput = picker.getByRole('textbox', { name:'新工作区名称' })
    assert.equal(await newInput.inputValue(), '打印任务 3'); assert(await newInput.evaluate(el=>el===document.activeElement && el.selectionStart===0 && el.selectionEnd===el.value.length))
    await newInput.fill(' 打印任务 １ '); assert(await button(picker,'加入 1 页').isDisabled()); await picker.getByText(/已有同名工作区/).waitFor()
    await newInput.fill('待核对草稿'); await newInput.press('Enter'); await assertDraft('chosen'); assert.deepEqual(await allTabs(), before)
    await picker.getByRole('radio', { name:one,exact:true }).click(); await assertDraft('ghost')
    await button(picker,`重命名工作区：${one}`).click(); const renameInput=picker.getByRole('textbox',{name:'工作区名称',exact:true})
    await renameInput.fill('取消后不能留下'); await renameInput.press('Escape'); assert.equal(await picker.getByRole('radio',{name:one,exact:true}).count(),1)
    await button(picker,`重命名工作区：${one}`).click(); await renameInput.fill('不应提交'); await renameInput.press('Enter'); await button(picker,'取消').click()
    await picker.waitFor({state:'detached'}); assert.deepEqual(await allTabs(),before); assert.deepEqual(await pending(),[d.id])

    phase = 'switch from new to existing; only rename and append to the existing tab'
    await reopen(); await proposal(d,1,'打印任务 3'); await assertDraft('ghost')
    await button(picker,'新建工作区').click(); await newInput.fill('不会创建'); await newInput.press('Enter')
    const existingOne=picker.getByRole('radio',{name:one,exact:true}); await existingOne.click(); await assertDraft('ghost')
    await button(picker,`重命名工作区：${one}`).click(); await renameInput.fill(' 归档校样 '); await renameInput.press('Enter')
    assert.deepEqual(await allTabs(),before,'accepting the name must neither rename nor create a project yet')
    await join(1); await ack(d.id); await selected('归档校样')
    assert.deepEqual(await allTabs(),before.map(n=>n===one?'归档校样':n),'a new draft switched to an existing project must never leave an extra tab')
    assert.deepEqual((await ids(3)).slice(0,2),protectedIds,'existing workspace keeps its pages and identity')
    assert.deepEqual(await pending(),[])

    phase = 'only explicit Join commits a new named destination'
    const e=await job('Echo',[240,250]); await enqueue(e); await proposal(e,2,'打印任务 1'); await assertDraft('ghost')
    await draftRadio.press('Space'); await assertDraft('chosen')
    await button(picker,'新建工作区').click(); await newInput.fill(' 月末装订 ')
    assert.equal(await tab('月末装订').count(),0)
    await join(2); await ack(e.id); await selected('月末装订'); await ids(2)
    assert.equal((await allTabs()).length,before.length+1); assert.equal(await tab('打印任务 1').count(),0)
    assert.deepEqual(await pending(),[]); assert.deepEqual(errors, [], 'uncaught renderer errors')
    console.log('PASS W02 naming: ghost on open/hover/focus; explicit mouse/keyboard choice solid; existing selection returns draft to ghost; cancelled changes leave no tabs or rename; confirmed existing 3→3 workspaces and 2→3 pages; confirmed custom new 3→4 workspaces with 2 pages')

    phase = 'a busy or persistently failing receipt must not block the next job'
    const [f, g, h] = await Promise.all(['Foxtrot', 'Golf', 'Hotel'].map(id => job(id, [230])))
    const seen = j => picker.getByText(`本地打印机 · ${j.name} · 共 1 页`, { exact: true }).waitFor()
    const append = async () => { await picker.getByRole('radio', { name: '月末装订', exact: true }).click(); await join(1) }
    const cancel = () => button(picker, '取消').click()
    const originalPages = await ids(2)
    await enqueue(f); await seen(f); await enqueue(g); await enqueue(h)
    await cancel(); await seen(g) // F postponed, not consumed.
    await p.evaluate(id => { inboxProbe.holdAck = id; inboxProbe.failAck = id }, g.id)
    await append(); await seen(h) // G's disk operation is still unresolved.
    assert.deepEqual(await pending(), [f.id, g.id, h.id]); assert.equal((await ids(3)).length, 3)
    await p.evaluate(() => { inboxProbe.holdAck = null; inboxProbe.releaseAck() })
    await p.getByRole('status').filter({ hasText: '模拟回执失败' }).waitFor()
    for (const n of [2, 3]) {
      await p.clock.fastForward(30_000)
      await p.waitForFunction(([id, n]) => inboxProbe.attempts.filter(ids => ids.includes(id)).length >= n, [g.id, n])
    }
    await p.clock.fastForward(120_000)
    assert.equal((await attempts()).filter(ids => ids.includes(g.id)).length, 3, 'automatic retries must stop')
    await cancel(); await picker.waitFor({ state: 'detached' })
    await reopen(); await seen(f); await cancel(); await seen(h) // Only unapplied F/H can be offered again.
    await append(); await ack(h.id)
    assert.deepEqual(await p.evaluate(() => inboxProbe.pending), [f, g], 'failed G and postponed F retain their original bytes')
    const appliedPages = await ids(4); assert.deepEqual(appliedPages.slice(0, 2), originalPages)
    await p.evaluate(() => { inboxProbe.failAck = null }); await reopen(); await ack(g.id); await seen(f)
    assert.deepEqual(await p.evaluate(() => inboxProbe.pending), [f], 'recovering G must not consume F')
    assert.deepEqual(await ids(4), appliedPages); assert.equal(await p.evaluate(id => inboxProbe.loaded.filter(s => s === id).length, g.id), 1)
    assert.deepEqual(await p.evaluate(() => inboxProbe.acked.slice(-2)), [h.id, g.id]); await cancel()
    assert.deepEqual(errors, [], 'uncaught renderer errors')
    console.log('PASS W02 receipts: later picker opened during held receipt; 1 attempt + 2 timed retries, no spin; later job acknowledged first; manual reopen offered only unapplied files; recovery removed only its job, without duplicate pages')
  } catch (e) { throw Error(`${phase}: ${e.message}`, { cause: e }) }
  finally { clearTimeout(deadline); await browser.close() }
}
run().catch(e => { console.error('FAIL', e.message); process.exitCode = 1 })
