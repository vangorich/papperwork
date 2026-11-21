// Run against an isolated local Vite dev server: node scripts/verify-rotated-native-reading.cjs http://127.0.0.1:PORT
// Pointer coordinates come from the printed Courier advances/CropBox, not the DOM spans or reading order.
const assert = require('node:assert/strict')
const { chromium } = require('playwright-core')
const { PDFDocument, StandardFonts, degrees, beginMarkedContent, endMarkedContent, PDFOperator, PDFName } = require('pdf-lib')

const width = 520, height = 365, size = 12, advance = size * .6
const xs = [42, 292], baselines = [64, 88, 112]
const columns = [
  ['Alpha sentence one.', 'Bravo sentence two.', 'Charlie sentence three.'],
  ['Copper paper turns.', 'Silver paper folds.', 'Golden paper rests.'],
]
async function fixture() {
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Courier)
  const page = pdf.addPage([590, 430]), ox = 23, oy = 17
  const next = pdf.addPage([width, height])
  next.pushOperators(beginMarkedContent('Sect'), PDFOperator.of('BDC', [PDFName.of('P'), pdf.context.obj({ MCID: 7 })]))
  next.drawText('Marked lower group.', { x: 42, y: height - 82, size, font })
  next.drawText('Next page sentinel.', { x: 42, y: height - 48, size, font })
  next.pushOperators(endMarkedContent(), endMarkedContent())
  page.setCropBox(ox, oy, width, height); page.setRotation(degrees(90))
  for (let row = 0; row < baselines.length; row++) for (let col = 0; col < columns.length; col++) {
    const text = columns[col][row], options = { x: ox + xs[col], y: oy + height - baselines[row], size, font }
    page.drawText(text, options) // interleaved paint order, not column-major reading order
    if (row === 0 && col === 0) page.drawText(text, { ...options, x: options.x + .18 }) // faux bold
  }
  return Buffer.from(await pdf.save())
}

// Also pin the deliberate fallback: no flattening, dedup or native reading metadata on ambiguous leaves.
async function checkFallbacks(page) {
  const kept = await page.evaluate(async () => {
    const { prepareNativeReading } = await import('/src/lib/pageReadingSelection.ts')
    return ['rtl', 'ttb', 'in-leaf rotation', 'markedContent'].map(kind => {
      const layer = document.createElement('div'); layer.dataset.mainRotation = '90'
      layer.style.cssText = 'position:fixed;left:-300px;top:0;width:200px;height:80px;transform:rotate(90deg)'
      let parent = layer
      if (kind === 'markedContent') { parent = document.createElement('span'); parent.className = kind; layer.append(parent) }
      const leaves = ['same', 'same', 'later'].map((s, i) => {
        const el = document.createElement('span'); el.style.cssText = `position:absolute;left:10px;top:${i === 2 ? 4 : 32}px`; el.textContent = s; parent.append(el); return el
      })
      if (kind === 'rtl' || kind === 'ttb') leaves[0].setAttribute('dir', kind)
      if (kind === 'in-leaf rotation') leaves[0].style.transform = 'rotate(12deg)'
      document.body.append(layer)
      try {
        const before = layer.innerHTML
        const boxes = leaves.map((_, i) => new DOMRect(10, i === 2 ? 4 : 32, 28, 12))
        prepareNativeReading(layer, leaves, { width: 200, height: 80, boxes })
        return layer.innerHTML === before && leaves.every((el, i) => parent.children[i] === el)
      } finally { layer.remove() }
    })
  })
  assert.deepEqual(kept, [true, true, true, true], 'fallback must preserve all nodes, order and attributes')
}

async function main() {
  const url = new URL(process.argv[2] || 'http://127.0.0.1:5207')
  assert.equal(url.protocol, 'http:'); assert(['127.0.0.1', 'localhost'].includes(url.hostname))
  const browser = await chromium.launch({ channel: 'msedge' })
  try {
    const page = await browser.newPage({ viewport: { width: 1520, height: 980 }, deviceScaleFactor: 1, reducedMotion: 'reduce' }), errors = []
    await page.addInitScript(() => {
      localStorage.setItem('paperwork-render-quality', 'smooth') // fixed 1× backing grid in this private context
      window.__painted = key => { if (key.startsWith('page:') && key.split(':').at(-2) === '0') window.__readingPaint = key }
    })
    page.on('pageerror', e => errors.push(e.message)); page.setDefaultTimeout(15000)
    await page.route(/^https?:\/\//, r => new URL(r.request().url()).origin === url.origin ? r.continue() : r.abort())
    await page.goto(url.origin); assert.equal(await page.title(), 'Paperwork PDF Studio')
    const choose = page.waitForEvent('filechooser'); await page.locator('.document-desk__actions button').first().click()
    const bytes = await fixture()
    await (await choose).setFiles({ name: 'Printed columns.pdf', mimeType: 'application/pdf', buffer: bytes })
    const paper = page.locator('#pdf-stage .pdf-page').first(), layer = paper.locator('.text-layer'), canvas = paper.locator('canvas').first()
    let checks = 0
    for (const rotation of [90, 180, 270, 0]) {
      if (rotation !== 90) await page.getByRole('button', { name: '向右旋转当前页', exact: true }).click()
      await paper.locator(`.text-layer[data-main-rotation="${rotation}"] > .endOfContent`).waitFor({ state: 'attached' })
      await page.getByRole('button', { name: '适合页面', exact: true }).click()
      await page.waitForFunction(turn => {
        const l = document.querySelector('#pdf-stage .text-layer'), c = l?.parentElement?.querySelector('canvas')
        // Reduced Windows motion is not the app switch. Wait for the reader to
        // accept input again before sampling the printed points for real drags.
        if (!c || l.parentElement.hasAttribute('data-turning') || !window.__readingPaint?.endsWith(`:0:${turn}`)) return false
        const a = l.getBoundingClientRect(), b = c.getBoundingClientRect()
        return b.width > 0 && Math.abs(a.width - b.width) < 2 && Math.abs(a.height - b.height) < 2 &&
          Math.abs(c.width - b.width) < 2 && Math.abs(c.height - b.height) < 2
      }, (rotation + 270) % 360)
      await page.evaluate(() => new Promise(ok => requestAnimationFrame(() => requestAnimationFrame(ok))))
      const raster = await canvas.evaluate(c => c.toDataURL()), box = await canvas.boundingBox()
      const point = ([c, r, k, overshoot]) => {
        // Click inside the first/last half-glyph: the fitted canvas and PDF.js
        // layer round page dimensions to CSS pixels independently.
        const inset = k === 0 ? advance * .24 : k === columns[c][r].length ? -advance * .24 : .4
        const u = (xs[c] + k * advance + (overshoot ?? inset)) / width
        const v = (baselines[r] - size * .32) / height
        const [s, t] = [[u, v], [1-v, u], [1-u, 1-v], [v, 1-u]][rotation / 90]
        return { x: box.x + s * box.width, y: box.y + t * box.height }
      }
      async function drag(label, from, to, expected) {
        const a = point(from), b = point(to)
        await page.mouse.move(a.x, a.y); await page.mouse.down()
        try { await page.mouse.move(b.x, b.y, { steps: 13 }) } finally { await page.mouse.up() }
        const got = await layer.evaluate(l => {
          const s = getSelection(), d = new DataTransfer(), ev = new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: d })
          ;(s.anchorNode?.parentElement ?? l).dispatchEvent(ev) // private clipboard; no system copy
          return { plain: d.getData('text/plain'), html: d.getData('text/html'), handled: ev.defaultPrevented,
            anchor: [s.anchorNode?.textContent, s.anchorOffset], focus: [s.focusNode?.textContent, s.focusOffset] }
        })
        const checkEndpoint = ([leaf, offset], [col, row, k]) => {
          // PDF.js may split a printed line into several Text leaves. Verify the
          // offset in the actual leaf, not an assumed one-span-per-line layout.
          const line = columns[col][row], start = line.indexOf(leaf)
          assert(start >= 0 && start === line.lastIndexOf(leaf), `${rotation}° ${label}: wrong leaf ${leaf}`)
          assert.equal(start + offset, k, `${rotation}° ${label}: wrong DOM offset`)
        }
        if (got.plain !== expected) console.error('Pointer hits', await page.evaluate(pts => pts.map(p => { const el=document.elementFromPoint(p.x,p.y), r=document.caretRangeFromPoint(p.x,p.y);return [p, el?.tagName,el?.className,el?.textContent?.slice(0,30),r?.startContainer.nodeName,r?.startContainer.textContent?.slice(0,30),r?.startOffset]}),[a,b]))
        assert.equal(got.plain, expected, `${rotation}° ${label}: ${JSON.stringify(got)}`)
        assert.equal(got.html, ''); assert(got.handled)
        checkEndpoint(got.anchor, from); checkEndpoint(got.focus, to)
        checks++
      }
      for (const col of [0, 1]) {
        const [first, middle, last] = columns[col], from = [col, 0, 3], to = [col, 2, 5]
        const expected = [first.slice(3), middle, last.slice(0, 5)].join('\n')
        await drag('column forward ' + col, from, to, expected); await drag('column reverse ' + col, to, from, expected)
      }
      const l = columns[0], r = columns[1]
      await drag('partial word forward', [0, 1, 1], [0, 1, 4], 'rav')
      await drag('partial word reverse', [0, 1, 4], [0, 1, 1], 'rav')
      await drag('past line end', [0, 0, 8], [0, 0, l[0].length, 16], l[0].slice(8))
      await drag('before line start', [1, 1, 4], [1, 1, 0, -16], r[1].slice(0, 4))
      await drag('intentional column crossing', [0, 2, 5], [1, 0, 4], l[2].slice(5) + '\n' + r[0].slice(0, 4))
      await drag('whole column including duplicate', [0, 0, 0], [0, 2, l[2].length], l.join('\n'))
      const rows = await layer.evaluate(l => {
        const rows = []
        for (const el of l.querySelectorAll('[data-read-row]')) {
          const row = Number(el.dataset.readRow); rows[row] = (rows[row] ?? '') + el.textContent.replace(/\s/g, '')
        }
        return rows
      })
      assert.deepEqual(rows, columns.flat().map(s => s.replace(/\s/g, '')), 'duplicate must not survive as a second selectable leaf')
      assert(await canvas.evaluate((c, before) => c.toDataURL() === before, raster), 'selection changed PDF pixels')
      console.log(`PASS ${rotation}°: 10 real drags, exact copy and DOM endpoints; duplicate omitted, raster unchanged`)
    }
    // The DOM range can still span pages: neither the wash nor the copy handler takes ownership.
    await page.getByRole('button', { name: /^阅读布局/ }).click()
    await page.getByRole('menuitemradio', { name: '双页', exact: true }).click()
    await page.getByRole('slider', { name: '缩放比例' }).press('Home')
    const nextLayer = page.locator('#pdf-stage .pdf-page').nth(1).locator('.text-layer')
    await nextLayer.locator('span').first().waitFor({ state: 'attached' })
    const group = nextLayer.locator('.markedContent .markedContent')
    assert.equal(await group.count(), 1, 'PDF.js extraction must preserve the nested BMC/BDC scope')
    assert.equal(await group.locator('[data-read-row]').count(), 0, 'do not reorder the interior of a marked group')
    assert.equal((await group.textContent()).replace(/\s/g, ''), 'Markedlowergroup.Nextpagesentinel.', 'marked content stays in tagged order, not geometric order')
    const crossPage = await layer.evaluate(async l => {
      const next = [...document.querySelectorAll('#pdf-stage .pdf-page .text-layer')].find(other => other !== l)
      const target = next.querySelector('span[role="presentation"]').firstChild
      const s = getSelection(), node = l.querySelector('[data-read-row]').firstChild
      try {
        s.setBaseAndExtent(node, 2, target, 4)
        await new Promise(ok => requestAnimationFrame(() => requestAnimationFrame(ok)))
        const d = new DataTransfer(), ev = new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: d }); node.parentElement.dispatchEvent(ev)
        return { handled: ev.defaultPrevented, painted: !!l.dataset.selectionWash || !!next.dataset.selectionWash, focusOnNext: s.focusNode === target }
      } finally { s.removeAllRanges() }
    })
    assert.deepEqual(crossPage, { handled: false, painted: false, focusOnNext: true })
    await page.keyboard.press('Control+f')
    await page.getByRole('textbox', { name: '搜索 PDF 文本' }).fill('sentinel')
    await page.locator('.search-popover__bar').getByText('1 个匹配', { exact: true }).waitFor()
    await page.waitForFunction(() => {
      const hits = CSS.highlights.get('pdf-search-match')
      return hits?.size === 1 && [...hits][0].toString() === 'sentinel'
    })
    const products = await page.evaluate(async bytes => {
      const { inspectPdf, indexPdfText, getPdfTextContent, pagesForSource, releasePdfDocument } = await import('/src/lib/pdf.ts')
      const { makePdfMarkdown } = await import('/src/lib/pdfMarkdown.ts')
      const source = await inspectPdf(new Uint8Array(bytes), 'Tagged fixture.pdf')
      try {
        const content = getPdfTextContent(source, 1)
        await indexPdfText(source)
        const plain = (await content).items.every(item => 'str' in item)
        const out = await makePdfMarkdown([pagesForSource(source)[1]], [source], { includeImages: false, assetDirectory: '' })
        return { cached: content === getPdfTextContent(source, 1), plain, index: source.pageText[1], markdown: out.markdown }
      } finally { await releasePdfDocument(source) }
    }, Array.from(bytes))
    assert(products.cached && products.plain, 'rendering tags must not replace the shared flat-text LRU')
    for (const text of [products.index, products.markdown]) for (const sentence of ['Marked lower group.', 'Next page sentinel.']) {
      assert.equal(text.replace(/\s+/g, ' ').split(sentence).length, 2, 'missing or repeated tagged text: ' + text)
    }
    console.log('PASS real nested BMC/BDC order, single search highlight, unchanged text cache, tagged search index and Markdown')
    await checkFallbacks(page); assert.deepEqual(errors, [])
    console.log(`PASS ${checks} drag checks total; cross-layer default copy/paint, RTL, vertical, angled and marked-content fallbacks`)
  } finally { await browser.close() }
}
main().catch(e => { console.error(e); process.exitCode = 1 })
