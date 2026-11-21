// Renderer-independent expected geometry: do not reuse the exporter to predict where dots belong.
const { PDFDocument, degrees } = require('pdf-lib'),
  { chromium } = require('playwright-core'),
  assert = require('node:assert/strict'),
  fs = require('node:fs/promises')
async function run() {
  const url = new URL(process.argv[2] || 'http://127.0.0.1:5207')
  assert(['127.0.0.1', 'localhost'].includes(url.hostname))
  const pdf = await PDFDocument.create(),
    leaf = pdf.addPage([600, 800])
  leaf.setCropBox(40, 60, 400, 600)
  leaf.setRotation(degrees(90))
  const input = Array.from(await pdf.save())
  const b = await chromium.launch({ channel: 'msedge' })
  try {
    const p = await b.newPage()
    await p.goto(url.href)
    const records = await p.evaluate(async (bytes) => {
      const { inspectPdf, composePdf, getPdfPage, releasePdfDocument } = await import('/src/lib/pdf.ts')
      const source = await inspectPdf(Uint8Array.from(bytes), 'offset.pdf', undefined, false)
      const stamp = document.createElement('canvas')
      stamp.width = 240
      stamp.height = 100
      const ctx = stamp.getContext('2d'),
        dots = [
          ['red', 0, 0],
          ['lime', 36, 0],
          ['blue', 0, -12],
        ]
      for (const [c, x, y] of dots) {
        ctx.fillStyle = c
        ctx.fillRect(120 + x * 2 - 5, 50 + y * 2 - 5, 10, 10)
      }
      const data = stamp.toDataURL(),
        out = []
      try {
        for (const rotation of [0, 90, 180, 270])
          for (const angle of [0, 30, -30]) {
            const swap = (rotation + 90) % 180 !== 0,
              w = swap ? 600 : 400,
              h = swap ? 400 : 600
            const rect = (cx, cy) => ({ x: cx - 60 / w, y: cy - 25 / h, width: 120 / w, height: 50 / h })
            const ann = {
                id: 'type',
                type: 'text',
                text: 'RGB',
                imageData: data,
                rotation: angle,
                ...rect(0.28, 0.34),
              },
              wm = {
                kind: 'image',
                imageData: data,
                tiled: false,
                opacity: 1,
                rotation: angle,
                ...rect(0.68, 0.7),
              }
            const row = { id: 'one', sourceId: source.id, sourcePage: 0, rotation, annotations: [ann] }
            const result = await inspectPdf(
              await composePdf([row], [source], { watermark: wm }),
              'saved.pdf',
              undefined,
              false,
            )
            try {
              const pg = await getPdfPage(result, 0),
                v = pg.getViewport({ scale: 2 })
              const c = document.createElement('canvas')
              c.width = v.width
              c.height = v.height
              const ctx = c.getContext('2d')
              await pg.render({ canvasContext: ctx, viewport: v }).promise
              const pix = ctx.getImageData(0, 0, c.width, c.height).data
              const values = []
              for (const [cx, cy] of [
                [0.28, 0.34],
                [0.68, 0.7],
              ]) {
                const middle = [cx * c.width, cy * c.height],
                  squares = [
                    [0, 0, 0],
                    [0, 0, 0],
                    [0, 0, 0],
                  ]
                for (
                  let y = Math.max(0, Math.floor(middle[1] - 130));
                  y < Math.min(c.height, middle[1] + 130);
                  y++
                )
                  for (
                    let x = Math.max(0, Math.floor(middle[0] - 130));
                    x < Math.min(c.width, middle[0] + 130);
                    x++
                  ) {
                    const i = (y * c.width + x) * 4
                    for (let ch = 0; ch < 3; ch++)
                      if (
                        pix[i + ch] > 230 &&
                        pix[i + ((ch + 1) % 3)] < 25 &&
                        pix[i + ((ch + 2) % 3)] < 25
                      ) {
                        squares[ch][0] += x + 0.5
                        squares[ch][1] += y + 0.5
                        squares[ch][2]++
                      }
                  }
                const a = (angle * Math.PI) / 180
                values.push(
                  squares.map(([sx, sy, n], i) => {
                    const [, dx, dy] = dots[i],
                      ex = middle[0] + 2 * (dx * Math.cos(a) - dy * Math.sin(a)),
                      ey = middle[1] + 2 * (dx * Math.sin(a) + dy * Math.cos(a))
                    return n ? Math.hypot(sx / n - ex, sy / n - ey) : 9999
                  }),
                )
              }
              out.push({
                sourceRotation: 90,
                addedRotation: rotation,
                objectAngle: angle,
                text: values[0],
                watermark: values[1],
              })
            } finally {
              await releasePdfDocument(result)
            }
          }
      } finally {
        await releasePdfDocument(source)
      }
      return out
    }, input)
    const max = Math.max(...records.flatMap((r) => [...r.text, ...r.watermark]))
    console.log(
      `12 rotation/page combinations, 72 colour centroids, worst error ${max.toFixed(3)} display pixels`,
    )
    if (process.argv[3])
      await fs.writeFile(
        process.argv[3],
        JSON.stringify({ renderScale: 2, maxPixelError: max, records }, null, 2),
      )
    assert(max <= 2, 'exported marks do not match screen-space centre, angle or crop origin')
  } finally {
    await b.close()
  }
}
run().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
