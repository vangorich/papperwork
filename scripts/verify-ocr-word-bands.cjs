// Windows-only, offline E2E. Only the native IPC transport is substituted. No PDF input or stored OCR answers.
const assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { execFileSync } = require('node:child_process')
const { PDFDocument } = require('pdf-lib'), { chromium } = require('playwright-core')
const { createCanvas, loadImage } = require('@napi-rs/canvas')
const root = path.resolve(__dirname, '..'), port = Number(process.env.OCR_BANDS_PORT || 5207)
const width = 1500, height = 1000, skew = 4, blur = 1.35

// Reuse the native layout test adapter: its profile run calls the same native_support::binary("ocr") as Tauri.
// It expects three named sheets. All three inputs below are the *renderer-supplied*, padded RGBA, losslessly encoded.
function recognize(png, dir) {
  const deps = path.join(root, 'src-tauri/target/x86_64-pc-windows-msvc/debug/deps')
  const exe = fs.readdirSync(deps).filter(n => /^folio_ocr_layout_025-[0-9a-f]+\.exe$/.test(n))
    .map(n => path.join(deps, n)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0]
  assert(exe, 'Build the x64 folio_ocr_layout_025 test adapter first (see verification guide)')
  const bytes = Buffer.from(png, 'base64')
  for (const name of ['control', 'mixed', 'skew']) fs.writeFileSync(path.join(dir, name + '.png'), bytes)
  execFileSync(exe, ['--ignored', '--exact', 'recognize_generated_sheets'], {
    cwd: dir, env: { ...process.env, PAPERWORK_LAYOUT_025_QA: dir }, timeout: 100000, stdio: 'pipe', windowsHide: true,
  })
  const { runs } = JSON.parse(fs.readFileSync(path.join(dir, 'recognition.json'), 'utf8'))
  const reply = runs.find(r => r.sheet === 'skew' && r.profile)?.result
  assert.equal(reply?.engine, 'Windows.Media.Ocr', 'missing production profile result')
  assert(reply.items.length > 0, 'empty production OCR')
  console.log(`Windows OCR: ${reply.model}, ${reply.items.length} positioned runs`)
  return reply
}

async function fixture(page) {
  const { png, words } = await page.evaluate(({ width, height, skew, blur }) => {
    const sheet = document.createElement('canvas'); sheet.width = width; sheet.height = height
    const ctx = sheet.getContext('2d'), words = {}
    ctx.fillStyle = 'white'; ctx.fillRect(0, 0, width, height); ctx.fillStyle = '#202020'
    function line(text, x, y, size) {
      ctx.font = `${size}px "Segoe UI", "Microsoft YaHei", sans-serif`
      for (const word of text.split(' ')) {
        // The pointer oracle is printed-font advances + source coordinates; it does not see OCR spans or SVG.
        const m = ctx.measureText(word), at = Array.from({ length: word.length + 1 }, (_, i) => x + ctx.measureText(word.slice(0, i)).width)
        const top = y - m.actualBoundingBoxAscent, bottom = y + m.actualBoundingBoxDescent
        words[word] = { at, top, bottom, y: (top + bottom) / 2 }
        ctx.fillText(word, x, y); x += m.width + ctx.measureText(' ').width
      }
    }
    line('Paper proof stays clear', 110, 140, 48); line('Second line ends here', 110, 210, 48)
    line('Amber books stay open', 110, 370, 36); line('Fresh notes sit nearby', 110, 420, 36)
    line('Other words read apart', 815, 370, 36); line('These pages turn slowly', 815, 420, 36)
    const table = [['Item', 'Code', 'Units'], ['Binder Box', 'Delta', '12'], ['Marker Set', 'Gamma', '34']]
    table.forEach((row, i) => row.forEach((text, j) => line(text, [110, 665, 1170][j], 618 + i * 64, 40)))
    line('复核 BETA 123', 110, 910, 40)
    const scan = document.createElement('canvas'); scan.width = width; scan.height = height
    const g = scan.getContext('2d'); g.fillStyle = 'white'; g.fillRect(0, 0, width, height)
    g.translate(width / 2, height / 2); g.rotate(skew * Math.PI / 180); g.filter = `blur(${blur}px)`
    g.drawImage(sheet, -width / 2, -height / 2)
    return { png: scan.toDataURL('image/png').split(',')[1], words }
  }, { width, height, skew, blur })
  const pdf = await PDFDocument.create(), pg = pdf.addPage([width / 4, height / 4])
  pg.drawImage(await pdf.embedPng(Buffer.from(png, 'base64')), { x: 0, y: 0, width: width / 4, height: height / 4 })
  return { bytes: Buffer.from(await pdf.save()), words }
}

// Transform coordinates from the printed sheet, independently of the recognizer's quads/carets and path builder.
function project({ x, y }, box, quarter) {
  const a = skew * Math.PI / 180, dx = x - width / 2, dy = y - height / 2
  const u = .5 + (dx * Math.cos(a) - dy * Math.sin(a)) / width, v = .5 + (dx * Math.sin(a) + dy * Math.cos(a)) / height
  const [s, t] = [[u, v], [1 - v, u], [1 - u, 1 - v], [v, 1 - u]][quarter / 90]
  return { x: box.x + s * box.width, y: box.y + t * box.height }
}
async function image(el, hideWash=false) {
  // Paired exposures of the same settled page and live Range. Only switch off the SVG
  // for the control exposure; don't clear the selection, resize, or replace the raster.
  const style='.text-selection-action { visibility: hidden !important; }'+(hideWash?' .page-selection-wash { visibility: hidden !important; }':'')
  const bytes = await el.screenshot({ scale: 'css', animations: 'disabled', style }), im = await loadImage(bytes)
  const ctx = createCanvas(im.width, im.height).getContext('2d'); ctx.drawImage(im, 0, 0)
  return { bytes, x: 0, y: 0, width: im.width, height: im.height, data: ctx.getImageData(0, 0, im.width, im.height).data }
}
const median = xs => xs.sort((a, b) => a - b)[xs.length >> 1]
const rgb = (im, p) => {
  const i = 4 * (Math.round(p.y) * im.width + Math.round(p.x))
  return [im.data[i], im.data[i + 1], im.data[i + 2]]
}
const midpoint = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })

async function main() {
  assert.equal(process.platform, 'win32'); assert(Number.isInteger(port) && port > 0 && port <= 65535)
  const origin = `http://127.0.0.1:${port}`, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paperwork-layout-025-bands-'))
  let browser
  try {
    browser = await chromium.launch({ channel: 'msedge' })
    const page = await browser.newPage({ viewport: { width: 1600, height: 1050 }, deviceScaleFactor: 1, reducedMotion: 'reduce' })
    const errors = []; page.on('pageerror', e => errors.push('renderer: ' + e.message)); page.setDefaultTimeout(10000)
    await page.route(/^https?:\/\//, r => new URL(r.request().url()).origin === origin ? r.continue() : r.abort())
    await page.routeWebSocket(url => url.origin === origin.replace('http:', 'ws:') && url.searchParams.has('token'), s => s.send('{"type":"connected"}'))
    await page.goto(origin); assert.equal(await page.title(), 'Paperwork PDF Studio')
    const { bytes, words } = await fixture(page), choose = page.waitForEvent('filechooser')
    await page.locator('.document-desk__actions button').first().click()
    await (await choose).setFiles({ name: 'Generated band proof.pdf', mimeType: 'application/pdf', buffer: bytes })
    const paper = page.locator('#pdf-stage .pdf-page').first(), layer = paper.locator('.text-layer')
    await paper.locator('canvas').first().waitFor(); await layer.waitFor(); assert.equal(await layer.locator('span').count(), 0)
    let calls = 0
    await page.exposeFunction('recognizeBandFixture', png => { assert.equal(++calls, 1, 'repeated native OCR'); return recognize(png, dir) })
    await page.evaluate(() => {
      window.desktop = { setWorkspaceDirty() {}, recognizeOcrPage: async ({ width, height, data }) => {
        const c = document.createElement('canvas'); c.width = width; c.height = height
        const pixels = new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength)
        c.getContext('2d').putImageData(new ImageData(pixels, width, height), 0, 0)
        return window.recognizeBandFixture(c.toDataURL('image/png').split(',')[1])
      } }
      // A trusted Ctrl+C reaches the real React onCopy. Give this event a private payload; never read the OS clipboard.
      window.addEventListener('copy', e => { Object.defineProperty(e, 'clipboardData', { value: new DataTransfer() }) }, true)
      window.addEventListener('copy', e => {
        const s = getSelection(), r = s.rangeCount && s.getRangeAt(0), l = document.querySelector('#pdf-stage .text-layer')
        window.bandReceipt = { trusted: e.isTrusted, handled: e.defaultPrevented, plain: e.clipboardData.getData('text/plain'),
          html: e.clipboardData.getData('text/html'), textRange: !!r && !r.collapsed && l.contains(r.startContainer) && l.contains(r.endContainer),
          forward: !!r && r.startContainer === s.anchorNode && r.startOffset === s.anchorOffset, cells: l.querySelectorAll('[data-selected]').length }
        e.preventDefault()
      })
    })
    await page.getByRole('button', { name: 'OCR 文字识别', exact: true }).click()
    await page.getByRole('menuitem', { name: /仅识别当前页/ }).click()
    await layer.locator('[data-ocr-index]').first().waitFor({ timeout: 110000 }); assert.equal(calls, 1)
    await layer.locator('[data-table-row="1"][data-table-column="1"]').waitFor()
    await page.waitForFunction(() => !Array.from(document.querySelectorAll('.toast')).some(t => t.getClientRects().length), undefined, { timeout: 15000 })
    const frames = () => page.evaluate(() => new Promise(ok => requestAnimationFrame(() => requestAnimationFrame(ok))))
    const at = (w, i) => ({ x: words[w].at[i] + (i === 0 ? 2 : i === w.length ? -2 : 0), y: words[w].y })
    const gap = (a, b) => midpoint(at(a, a.length), at(b, 0))
    const center = w => midpoint(at(w, 0), at(w, w.length))
    let quarter = 0, scale, base, startTarget
    async function fit(smaller) {
      await page.getByRole('button', { name: '适合页面', exact: true }).click(); await frames()
      if (smaller) {
        const old = await layer.evaluate(l => Number(l.style.getPropertyValue('--ocr-scale')))
        await page.getByRole('button', { name: /^缩小 Ctrl/ }).click()
        await page.waitForFunction(old => Number(document.querySelector('#pdf-stage .text-layer').style.getPropertyValue('--ocr-scale')) < old, old)
      }
      await page.waitForFunction(() => { const l = document.querySelector('#pdf-stage .text-layer'), a = l.getBoundingClientRect(), b = l.parentElement.getBoundingClientRect(); return Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1 })
      await page.evaluate(() => getSelection().removeAllRanges()); await page.mouse.move(1, 1); await frames()
      base = await image(paper); scale = (quarter % 180 ? base.height : base.width) / width
    }
    async function drag(first, last, reverse) {
      const box = await layer.boundingBox(), a = project(reverse ? last : first, box, quarter), b = project(reverse ? first : last, box, quarter)
      startTarget = await page.evaluate(p => { const hit = document.elementFromPoint(p.x, p.y); return hit?.closest('[data-ocr-index]') ? 'printed word' : hit?.className || hit?.tagName }, a)
      await page.mouse.move(a.x, a.y); await page.mouse.down()
      try { await page.mouse.move(b.x, b.y, { steps: 15 }) } finally { await page.mouse.up() }
      await page.mouse.move(1, 1); await frames()
    }
    async function copy(expected, reverse) {
      await page.evaluate(() => { window.bandReceipt = null }); await page.keyboard.press('Control+c')
      const r = await page.evaluate(() => window.bandReceipt)
      assert(r?.trusted && r.handled && r.textRange, 'trusted, layer-owned text copy did not occur')
      assert(!r.cells && !r.html, 'glyph drag became a cell selection')
      // Report an offset, never dump recognized text, even if a regression selects the whole page.
      let i = 0; while (i < r.plain.length && i < expected.length && r.plain[i] === expected[i]) i++
      assert(r.plain === expected, `wrong copied glyph at ${i}; expected ${expected.length} UTF-16 units, got ${r.plain.length}; drag started on ${startTarget}`)
      assert.equal(r.forward, !reverse, `stale or reversed DOM range (start: ${startTarget})`)
    }
    const failures = [], checks = { copy: 0, wash: 0 }; let screenshotDir
    async function check(type, name, work) {
      try { await work(); checks[type]++ } catch (e) { const msg = `${quarter}° ${name} ${type}: ${e.message}`; failures.push(msg); console.error('FAIL', msg) }
    }
    async function run(name, a, b, expected, bands, inside, outside, checkLine = false) {
      const first = at(...a), last = at(...b)
      for (const reverse of [false, true]) {
        await drag(first, last, reverse)
        await check('copy', name + (reverse ? ' reverse' : ' forward'), () => copy(expected, reverse))
      }
      await check('wash', name, async () => {
        const path = paper.locator('.page-selection-wash > path')
        const unit = {x:0,y:0,width:1,height:1}
        const probes = [...inside.map(v=>({p:project(v,unit,quarter),selected:true})),...outside.map(v=>({p:project(v,unit,quarter),selected:false}))]
        const inFill = await path.evaluate((el, points)=>{
          const rect=el.ownerSVGElement.getBoundingClientRect(), inverse=el.getScreenCTM().inverse()
          return points.map(({p})=>el.isPointInFill(new DOMPoint(rect.left+p.x*rect.width,rect.top+p.y*rect.height).matrixTransform(inverse)))
        },probes)
        assert.deepEqual(inFill,probes.map(t=>t.selected),'painted path does not match independent printed glyph/gutter probes')
        const canvasStamp=()=>paper.locator('canvas').first().evaluate(async c=>{
          const bytes=c.getContext('2d').getImageData(0,0,c.width,c.height).data
          return [c.width,c.height,...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].join('/')
        })
        const stamp=await canvasStamp(), control=await image(paper,true), after=await image(paper)
        assert.equal(await canvasStamp(),stamp,'underlying PDF raster changed between paired exposures')
        assert.equal(control.width,after.width); assert.equal(control.height,after.height)
        if (process.env.OCR_BANDS_SCREENSHOTS) {
          screenshotDir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'paperwork-band-pixels-'))
          fs.writeFileSync(path.join(screenshotDir, `scan-${quarter}-${base.width}.png`), base.bytes)
          fs.writeFileSync(path.join(screenshotDir, `${name.replaceAll(' ', '-')}-${quarter}-${base.width}.png`), after.bytes)
        }
        assert.equal(after.width, base.width); assert.equal(after.height, base.height)
        const p = v => project(v, after, quarter), delta = v => rgb(control, v)[0] - rgb(after, v)[0]
        const washed = []
        for (const v of inside) {
          const c = p(v), values = []
          for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) {
            const point = { x: c.x + x, y: c.y + y }; if (Math.min(...rgb(control, point)) < 251) continue
            const color = rgb(after, point); assert(Math.max(...color) - Math.min(...color) <= 8, 'colored, not neutral gray, at a word gap')
            values.push(delta(point)); washed.push(delta(point))
          }
          const m = median(values); assert(m >= 9 && m <= 115, `no translucent wash across selected word gap (median darkening ${m})`)
        }
        for (const v of outside) {
          const c = p(v), before = rgb(control, c), now = rgb(after, c)
          assert(Math.max(...before.map((value, i) => Math.abs(value - now[i]))) <= 3, `unselected point at source ${v.x.toFixed(1)},${v.y.toFixed(1)} changed from ${before} to ${now}`)
        }
        if (checkLine) {
          assert(Math.max(...washed) - Math.min(...washed) >= 2, 'no visible texture within selected white gaps')
          // Trace the upper and lower painted edge in source-normal direction at two distant word gaps.
          // A horizontal AABB on the 4° fixture drifts ~16 source pixels here; a rotated band does not.
          const angle = (quarter + skew) * Math.PI / 180, normal = { x: -Math.sin(angle), y: Math.cos(angle) }
          const parallelEdges = await paper.locator('.page-selection-wash > path').evaluate((path, n) => {
            const length = path.getTotalLength(), matrix = path.getScreenCTM(); let parallel = 0
            for (let i = 0; i < 32; i++) {
              const a = path.getPointAtLength((i + .2) * length / 32).matrixTransform(matrix), b = path.getPointAtLength((i + .8) * length / 32).matrixTransform(matrix)
              const dx = b.x - a.x, dy = b.y - a.y
              if (Math.abs(dx * n.x + dy * n.y) < Math.hypot(dx, dy) * Math.sin(2 * Math.PI / 180)) parallel++
            }
            return parallel
          }, normal)
          assert(parallelEdges >= 20, 'painted path has no long edges parallel to the slanted printed line')
          const edges = [p(inside[0]), p(inside.at(-1))].map(c => {
            const hits = []
            for (let d = -48 * scale; d <= 48 * scale; d += .5) if (delta({ x: c.x + d * normal.x, y: c.y + d * normal.y }) >= 8) hits.push(d)
            assert(hits.length >= 12 * scale, 'missing printed band edge'); return [hits[0], hits.at(-1)]
          })
          const drift = Math.max(...edges[0].map((value, i) => Math.abs(value - edges[1][i]))) / scale
          assert(drift < 9, `band edge does not follow ${skew}° print (drift ${drift.toFixed(1)} source px)`)
          const ink = [], w = words.proof
          for (let x = w.at[0]; x < w.at.at(-1); x += 2) for (let y = w.y - 18; y < w.y + 18; y += 2) {
            const point = p({ x, y }); if (rgb(control, point)[0] < 110) ink.push(rgb(after, point)[0])
          }
          assert(ink.length >= 20 && median(ink) < 130 && 255 - median(washed) - median(ink) > 70, 'selected printed ink lost contrast')
        }
        const count = await paper.locator('.page-selection-wash').getAttribute('data-ocr-band-count')
        assert.equal(Number(count), bands, `expected ${bands} painted band(s); attribute was ${count}`)
      })
    }
    for (quarter of [0, 90, 180, 270]) {
      if (quarter) {
        await page.getByRole('button', { name: '向右旋转当前页', exact: true }).click()
        await page.waitForFunction(q => { const el = document.querySelector('#pdf-stage [data-ocr-index]'); if (!el) return false; const m = new DOMMatrix(getComputedStyle(el).transform); return Math.round(Math.atan2(m.b, m.a) / (Math.PI / 2) + 4) % 4 === q / 90 }, quarter)
      }
      await fit(false)
      const lineCheck = () => run('partial line', ['Paper', 2], ['clear', 3], 'per proof stays cle', 1,
        [gap('Paper', 'proof'), gap('proof', 'stays'), gap('stays', 'clear')], [at('Paper', 1), at('clear', 4)], true)
      await lineCheck()
      await run('line break', ['proof', 2], ['ends', 2], 'oof stays clear\nSecond line en', 2,
        [gap('stays', 'clear'), gap('Second', 'line')], [{ x: gap('proof', 'stays').x, y: (words.proof.bottom + words.line.top) / 2, interline: true }])
      await run('prose columns', ['Amber', 2], ['notes', 3], 'ber books stay open\nFresh not', 2,
        [gap('Amber', 'books'), gap('Fresh', 'notes')], [midpoint(at('open', 4), at('Other', 0)), gap('Other', 'words')])
      await run('single cell', ['Binder', 1], ['Box', 2], 'inder Bo', 1,
        [gap('Binder', 'Box')], [gap('Box', 'Delta'), center('Delta')])
      await run('across cells', ['Box', 1], ['Delta', 3], 'ox Del', 2, [], [gap('Box', 'Delta'), center('12')])
      const extend = (w, offset, dx) => { const p = at(w, offset); return { x: p.x + dx, y: p.y } }
      for (const [label, from, to, expected, reverse] of [
        ['line-end overshoot', at('clear', 2), extend('clear', 5, 27), 'ear', false],
        ['line-start overshoot', extend('Second', 0, -27), at('Second', 4), 'Seco', true],
        ['cell right gutter', at('Box', 1), extend('Box', 3, 28), 'ox', false],
        ['cell left gutter', extend('Delta', 0, -28), at('Delta', 3), 'Del', true],
      ]) {
        await drag(from, to, reverse)
        await check('copy', label, () => copy(expected, reverse))
      }
      if (!quarter) {
        await run('mixed script', ['复核', 0], ['123', 3], '复核 BETA 123', 1, [gap('BETA', '123')], [])
        await fit(true); await lineCheck()
      }
      console.log(`${quarter}° complete; cumulative passing copy=${checks.copy}, wash=${checks.wash}`)
    }
    assert.equal(calls, 1); if (screenshotDir) console.log('Generated-page screenshots:', screenshotDir)
    if (errors.length || failures.length) throw Error(`${errors.length} renderer errors; ${failures.length} failed fixture checks${errors.length ? ': ' + errors.join('; ') : ''}`)
    console.log(`PASS ${checks.copy} trusted copy events, ${checks.wash} pixel/geometry checks; synthetic fixture only`)
  } finally { try { await browser?.close() } finally { fs.rmSync(dir, { recursive: true, force: true }) } }
}
main().catch(e => { console.error(e.message); process.exitCode = 1 })
