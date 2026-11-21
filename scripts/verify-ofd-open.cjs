// User-selected file, read-only. The browser gets bytes over its local automation pipe.
// Only loopback assets may load. Never print names, extracted text, images, or document XML.
const { chromium } = require('playwright-core'),
  fs = require('node:fs/promises'),
  assert = require('node:assert/strict'),
  { createHash } = require('node:crypto')
async function run() {
  const filename = process.argv[2],
    origin = new URL(process.argv[3] || 'http://127.0.0.1:5207')
  assert(origin.hostname === '127.0.0.1')
  const input = await fs.readFile(filename),
    hash = (b) => createHash('sha256').update(b).digest('hex')
  let blocked = 0
  const browser = await chromium.launch({
    channel: 'msedge',
    headless: true,
    args: ['--disable-background-networking'],
  })
  try {
    const ctx = await browser.newContext({
      viewport: { width: 1320, height: 900 },
      serviceWorkers: 'block',
    })
    await ctx.route('**/*', (r) => {
      const u = new URL(r.request().url())
      if (u.origin === origin.origin || u.protocol === 'blob:' || u.protocol === 'data:')
        return r.continue()
      blocked++
      return r.abort()
    })
    const p = await ctx.newPage()
    await p.goto(origin.href)
    const shell = p.locator('.app-shell:visible')
    await shell.waitFor()
    await p.evaluate(() => {
      window.probeError = ''
      new MutationObserver(() => {
        const n = document.querySelector('.toast')
        if (n?.textContent && !document.querySelector('.editor-tabs [role=tab]'))
          window.probeError = n.textContent
      }).observe(document.body, { subtree: true, childList: true, characterData: true })
    })
    const chooser = p.waitForEvent('filechooser')
    await shell.locator('.document-desk__actions button').first().click()
    await (await chooser).setFiles({ name: 'reference.ofd', mimeType: 'application/ofd', buffer: input })
    await p.waitForFunction(
      () => window.probeError || document.querySelector('.editor-tabs [role=tab]'),
      null,
      { timeout: 30000 },
    )
    if (!(await shell.locator('.editor-tabs [role=tab]').count())) {
      const msg = await p.evaluate(() => window.probeError)
      throw Error(
        'OFD open rejected: ' + msg.replace(/[A-Za-z0-9_./\\-]{32,}/g, '<redacted>').slice(0, 175),
      )
    }
    const counts = await p.evaluate(() => ({
      pages: Number(document.querySelector('input[aria-label^="当前页码"]')?.max) || 0,
    }))
    assert(counts.pages > 0)
    const painted = () =>
      p.waitForFunction(
        () => {
          const c = document.querySelector('.stage-page[data-current] .pdf-page > canvas')
          if (!c || c.width < 4) return false
          const mini = document.createElement('canvas')
          mini.width = mini.height = 96
          const cx = mini.getContext('2d')
          cx.drawImage(c, 0, 0, 96, 96)
          const a = cx.getImageData(0, 0, 96, 96).data
          let ink = 0
          for (let i = 0; i < a.length; i += 4)
            if (a[i + 3] > 240 && Math.min(a[i], a[i + 1], a[i + 2]) < 225) ink++
          return ink > 5
        },
        null,
        { timeout: 16000 },
      )
    await painted()
    let searchable = false,
      unverified = false
    if (process.argv.includes('--signed-text')) {
      await p.waitForFunction(
        () =>
          [...document.querySelectorAll('#pdf-stage .stage-page[data-current] .text-layer span')].some(
            (s) => s.textContent?.trim(),
          ),
        null,
        { timeout: 16000 },
      )
      await p.keyboard.press('Control+f')
      await p.locator('#pdf-search').waitFor()
      await p.evaluate(() => {
        const values = [
          ...document.querySelectorAll('#pdf-stage .stage-page[data-current] .text-layer span'),
        ]
          .map((s) => s.textContent.trim())
          .filter(Boolean)
        const q = values.find((v) => v.length > 2) ?? values[0]
        const f = document.querySelector('#pdf-search')
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(
          f,
          Array.from(q).slice(0, 4).join(''),
        )
        f.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await p.getByRole('option').first().waitFor({ timeout: 15000 })
      searchable = true
      unverified = (await p.locator('.ofd-provenance:visible').count()) === 1
      assert(unverified, 'signed original must remain labelled unverified')
      await p.setViewportSize({ width: 640, height: 520 })
      assert(await p.locator('.ofd-provenance').isVisible(), 'signed indicator should survive narrowing')
    }
    let textCoverage
    if (process.argv.includes('--match-text-runs')) {
      // Optional receipt-specific QA, after the app has validated the archive.
      // Examine only page XML, never business attachments or signature data.
      const { unzipSync, strFromU8 }=require('fflate');let budget=0
      const xml=Object.values(unzipSync(input,{filter:f=>{
        if(!/(?:^|\/)Pages\/[^/]+\/Content\.xml$/i.test(f.name))return false
        assert(f.originalSize<=3*1024*1024 && (budget+=f.originalSize)<=12*1024*1024);return true
      }})).map(b=>strFromU8(b));assert.equal(xml.length,1,'single-page coverage check')
      textCoverage=await p.evaluate(xml=>{
        const root=new DOMParser().parseFromString(xml,'application/xml'),norm=v=>v.normalize('NFC').replace(/\s+/gu,'')
        const runs=Array.from(root.getElementsByTagNameNS('*','TextCode'),e=>norm(e.textContent??'')).filter(Boolean)
        const layer=norm(Array.from(document.querySelectorAll('#pdf-stage .stage-page[data-current] .text-layer span'),s=>s.textContent).join(''))
        return {runs:runs.length,found:runs.filter(s=>layer.includes(s)).length}
      },xml[0]);assert(textCoverage.runs>0 && textCoverage.found===textCoverage.runs,`text layer coverage ${textCoverage.found}/${textCoverage.runs}`)
    }
    assert.equal(hash(await fs.readFile(filename)), hash(input))
    assert.equal(blocked, 0)
    console.log(
      JSON.stringify({
        ...counts,
        actualAppOpen: true,
        mainCanvasNonblank: true,
        sourceUnchanged: true,
        externalRequests: blocked,
        ...(searchable ? { searchable, unverified } : {}),
        ...(textCoverage ? {textCoverage} : {}),
      }),
    )
  } finally {
    await browser.close()
  }
}
run().catch((e) => {
  console.error(e.message)
  process.exitCode = 1
})
