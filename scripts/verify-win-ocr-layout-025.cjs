// Run on Windows with Node 22.18+ (native type stripping), installed project dependencies and cached Cargo deps.
// No daemon / install / document input. Keep fixtures, raw WinRT output and scores in one new TEMP folder.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { createCanvas } = require('@napi-rs/canvas')
const root = path.resolve(__dirname, '..'), width = 1240, height = 1040

function turn(x, y, degrees) {
  const a = degrees * Math.PI / 180, dx = x - width / 2, dy = y - height / 2
  return { x: width / 2 + dx * Math.cos(a) - dy * Math.sin(a), y: height / 2 + dx * Math.sin(a) + dy * Math.cos(a) }
}
function bounds(points) {
  const x = Math.min(...points.map(p => p.x)), y = Math.min(...points.map(p => p.y))
  return { x, y, width: Math.max(...points.map(p => p.x)) - x, height: Math.max(...points.map(p => p.y)) - y }
}
function corners({ x, y, width: w, height: h }) { return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }] }
function intersection(a, b) {
  return Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
}
function iou(a, b) { const n = intersection(a, b); return n / (a.width * a.height + b.width * b.height - n) }

function fixture(name, qa) {
  const mixed = name !== 'control', angle = name === 'skew' ? 3 : 0
  const c = createCanvas(width, height), g = c.getContext('2d')
  g.fillStyle = 'white'; g.fillRect(0, 0, width, height); g.fillStyle = '#181818'
  const tables = [
    [[mixed ? '品名 Item' : 'Stock item', mixed ? '数量' : 'Count', mixed ? '金额' : 'Amount'],
      ['Paper clips', '12', '48.50'], [mixed ? '附页' : 'Insert', '', ''], [mixed ? '墨水 refill' : 'Ink refill', '2', '1200.00']],
    [[mixed ? '批次' : 'Batch', mixed ? '份数' : 'Units'], [mixed ? '信封' : 'Envelopes', '24'], [mixed ? '纸张' : 'Sheets', '8']],
  ]
  const tokens = [], lines = []
  function put(text, anchor, baseline, id, size = 32, right = false) {
    if (!text) return
    g.font = `${size}px "Microsoft YaHei"`
    const words = text.split(' '), space = g.measureText(' ').width
    const metrics = words.map(w => g.measureText(w))
    let x = anchor - (right ? metrics.reduce((sum, m) => sum + m.width, space * (words.length - 1)) : 0)
    words.forEach((word, i) => {
      const m = metrics[i]
      g.fillText(word, x, baseline)
      // Font metrics give a search window only. The oracle below measures actual dark pixels in the final PNG.
      tokens.push({ text: word, id, approx: { x: x - m.actualBoundingBoxLeft - 2, y: baseline - m.actualBoundingBoxAscent - 2,
        width: m.actualBoundingBoxLeft + m.actualBoundingBoxRight + 4, height: m.actualBoundingBoxAscent + m.actualBoundingBoxDescent + 4 } })
      x += m.width + space
    })
  }
  function prose(text, y, id, size) { put(text, 90, y, id, size); lines.push(text) }
  prose(mixed ? '印刷校样 AB 207。' : 'Printed proof AB 207.', 79, 'title', 35)
  tables.forEach((table, t) => {
    table.forEach((row, r) => {
      row.forEach((text, col) => put(text, (t ? [154, 845] : [110, 684, 1105])[col], (t ? 580 : 174) + r * 55,
        `${t}:${r}:${col}`, 32, col > 0))
      lines.push(row.filter(Boolean).join(' '))
    })
    if (!t) prose(mixed ? '本页金额以印刷原稿为准。' : 'Use the signed copy for comparison.', 452, 'body', 27)
  })
  const article = [
    ['Each left column has a complete sentence.', 'This second line belongs to the article.'],
    ['The right column is independent prose.', 'No amounts belong in either paragraph.'],
  ]
  article.forEach((column, j) => column.forEach((text, i) => {
    put(text, j ? 682 : 90, 823 + i * 34, `article:${i}:${j}`, 21); lines.push(text)
  }))
  prose(mixed ? '小字行尾 END 39。' : 'Small print reaches the final word.', 980, 'footer', 20)
  const out = createCanvas(width, height), ctx = out.getContext('2d')
  ctx.fillStyle = 'white'; ctx.fillRect(0, 0, width, height)
  ctx.translate(width / 2, height / 2); ctx.rotate(angle * Math.PI / 180); ctx.drawImage(c, -width / 2, -height / 2)
  fs.writeFileSync(path.join(qa, name + '.png'), out.toBuffer('image/png'))
  const { data } = ctx.getImageData(0, 0, width, height)
  for (const t of tokens) {
    const a = t.approx, b = bounds(corners(a).map(p => turn(p.x, p.y, angle)))
    let l = width, r = 0, top = height, bottom = 0
    for (let y = Math.floor(b.y); y < Math.ceil(b.y + b.height); y++) for (let x = Math.floor(b.x); x < Math.ceil(b.x + b.width); x++) {
      if (data[(y * width + x) * 4] >= 160) continue
      const p = turn(x + .5, y + .5, -angle)
      if (p.x < a.x || p.x > a.x + a.width || p.y < a.y || p.y > a.y + a.height) continue
      l = Math.min(l, x); r = Math.max(r, x + 1); top = Math.min(top, y); bottom = Math.max(bottom, y + 1)
    }
    assert(r > l && bottom > top, 'no printed ink for ' + t.text)
    t.box = { x: l, y: top, width: r - l, height: bottom - top }; delete t.approx
  }
  return { name, angle, width, height, tables, text: lines.join('\n'), tokens }
}

function score(run, gt, ocr) {
  const { result, profile, language, sheet } = run
  assert.equal(result.engine, 'Windows.Media.Ocr')
  // The profile result already contains production quads. For a language explicitly selected in
  // the test, project WinRT's raw deskew-space rectangle back into source pixels exactly once.
  const items = profile ? result.items : result.rects.map(({ text, rect: [x, y, w, h] }) => {
    const points = corners({ x, y, width: w, height: h }).map(p => turn(p.x, p.y, result.angle))
    return { text, confidence: 0, box: { ...bounds(points), points, rotation: result.angle } }
  })
  const words = ocr.normalizeOcrWords(items.map(i => ({ text: i.text, confidence: i.confidence, ...i.box })), gt)
  assert(words.length && words.length === items.length, 'empty result or off-page boxes')
  for (const { box, confidence } of items) {
    assert.equal(confidence, 0, 'WinRT does not supply a confidence score')
    assert.equal(box.points.length, 4)
    for (const p of box.points) assert(p.x >= 0 && p.x <= width && p.y >= 0 && p.y <= height, 'invalid word quad')
  }
  const tables = ocr.reconstructOcrTables(words, result.text), text = ocr.buildOcrText(words)
  // Independent ownership from the printed ink, not the recognizer's strings or reconstruction.
  const owner = items.map(({ box }) => {
    let index = -1, overlap = 0
    gt.tokens.forEach((t, i) => { const v = intersection(box, t.box); if (v > overlap) { overlap = v; index = i } })
    return index
  })
  const wordBoxes = gt.tokens.map((t, i) => {
    const indexes = items.flatMap((_, j) => owner[j] === i ? [j] : [])
    const got = indexes.length ? bounds(indexes.flatMap(j => corners(items[j].box))) : null
    const delta = got && [got.x - t.box.x, got.y - t.box.y, got.x + got.width - t.box.x - t.box.width,
      got.y + got.height - t.box.y - t.box.height]
    return { ...t, indexes, actualText: ocr.buildOcrText(indexes.map(j => words[j])), got, edgeDeltaPx: delta,
      maxEdgeErrorPx: delta && Math.max(...delta.map(Math.abs)), iou: got ? iou(t.box, got) : 0 }
  })
  const cells = gt.tables.flatMap((table, t) => table.flatMap((row, r) => row.map((expected, c) => {
    const id = `${t}:${r}:${c}`, cell = tables[t]?.cells?.[r]?.[c]
    const expectedIndexes = owner.flatMap((i, j) => gt.tokens[i]?.id === id ? [j] : [])
    const gotIndexes = cell?.wordIndexes ?? []
    const correctlyOwned = Boolean(cell) && (!expected || expectedIndexes.length > 0) &&
      expectedIndexes.length === gotIndexes.length && expectedIndexes.every(i => gotIndexes.includes(i))
    return { id, expected, actual: cell?.text ?? null, expectedIndexes, gotIndexes, correctlyOwned, bounds: cell?.bounds }
  })))
  const claims = words.map(() => [])
  tables.forEach((t, ti) => t.cells?.forEach((row, ri) => row.forEach((cell, ci) => {
    for (const idx of cell.wordIndexes) claims[idx].push(`${ti}:${ri}:${ci}`)
  })))
  const tableWords = owner.flatMap((i, j) => /^\d+:/.test(gt.tokens[i]?.id ?? '') ? [j] : [])
  const correctWordClaims = tableWords.filter(j => claims[j].length === 1 && claims[j][0] === gt.tokens[owner[j]].id).length
  const proseInTable = owner.filter((i, j) => !/^\d+:/.test(gt.tokens[i]?.id ?? '') && claims[j].length).length
  const expectedTsv = gt.tables.map(table => table.map(row => row.join('\t')).join('\n'))
  const actualTsv = tables.map(ocr.tableToTsv)
  const placed = wordBoxes.filter(w => w.got), edgeErrors = placed.map(w => w.maxEdgeErrorPx)
  const summary = { sheet, language, path: profile ? 'native_support::binary' : 'WinRT explicit language',
    angle: items[0].box.rotation, nativeWords: words.length, tokens: gt.tokens.length,
    tokensWithBoxes: placed.length, verbatimTokens: wordBoxes.filter(t => t.text === t.actualText).length,
    exactBoxes: edgeErrors.filter(x => x < 1e-6).length, boxesWithin2px: edgeErrors.filter(x => x <= 2.000001).length,
    meanTokenIoU: +(wordBoxes.reduce((sum, w) => sum + w.iou, 0) / wordBoxes.length).toFixed(4),
    maxEdgeErrorPx: edgeErrors.length ? +Math.max(...edgeErrors).toFixed(2) : null,
    unplacedWords: owner.filter(i => i < 0).length, shape: tables.map(t => `${t.rows.length}x${t.columnCount}`).join(' + '),
    locatedTableWords: tableWords.length, correctWordClaims, proseInTable,
    cells: cells.length, verbatimCells: cells.filter(c => c.expected === c.actual).length,
    correctlyOwned: cells.filter(c => c.correctlyOwned).length, exactTables: expectedTsv.filter((v, i) => v === actualTsv[i]).length,
    rawPageExact: result.text === gt.text, rebuiltPageExact: text === gt.text }
  return { summary, expectedText: gt.text, rawText: result.text, rebuiltText: text, expectedTsv, actualTsv, cells, wordBoxes }
}

async function main() {
  assert.equal(process.platform, 'win32', 'requires installed Windows.Media.Ocr recognizers')
  const qa = fs.mkdtempSync(path.join(os.tmpdir(), 'paperwork-layout-025-')); console.log('QA:', qa)
  const sheets = Object.fromEntries(['control', 'mixed', 'skew'].map(n => [n, fixture(n, qa)]))
  fs.writeFileSync(path.join(qa, 'ground-truth.json'), JSON.stringify(sheets, null, 2))
  const cmd = '& ./scripts/with-x64-env.ps1 -Program cargo -CommandArgs @("test","--locked","--offline","--target","x86_64-pc-windows-msvc","--manifest-path","src-tauri/native-support/Cargo.toml","--test","folio_ocr_layout_025","--","--ignored","--exact","recognize_generated_sheets")'
  const p = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', cmd], { cwd: root, stdio: 'inherit',
    env: { ...process.env, PAPERWORK_LAYOUT_025_QA: qa, CARGO_TARGET_DIR: path.join(os.tmpdir(), 'paperwork-layout-025-target') } })
  if (p.error) throw p.error
  assert.equal(p.status, 0, 'native recognition failed')
  const { caps, status, runs } = JSON.parse(fs.readFileSync(path.join(qa, 'recognition.json'), 'utf8'))
  const ocr = await import('../src/lib/ocr.ts')
  const results = runs.map(run => score(run, sheets[run.sheet], ocr))
  fs.writeFileSync(path.join(qa, 'scores.json'), JSON.stringify(results, null, 2))
  console.log(status.model, 'installed:', caps.languages.join(', '))
  console.table(results.map(r => r.summary))
  for (const r of results) {
    const failures = r.cells.filter(c => c.expected !== c.actual || !c.correctlyOwned)
    if (failures.length) console.log(r.summary.language, r.summary.sheet, 'cell differences:', failures.map(c => [c.id, c.expected, c.actual]))
  }
  for (const sheet of Object.keys(sheets)) {
    const rr = runs.filter(r => r.sheet === sheet)
    assert.deepEqual(rr.map(r => r.language).sort(), [...caps.languages].sort())
    assert.equal(rr.filter(r => r.profile).length, 1, 'production default-language path was not tested')
  }
  // The paired-language production path must pass the actual mixed and skew sheets,
  // not merely return some words or pass the single-language English control.
  const mixedProfile = results.filter(r => r.summary.path === 'native_support::binary')
  const canVerifyMixed = /^Windows OCR \(zh(?:-|\))/i.test(status.model) && caps.languages.some(t => /^en(?:-|$)/i.test(t))
  if (canVerifyMixed) {
    for (const r of mixedProfile) {
      const z = r.summary
      assert.deepEqual(r.actualTsv, r.expectedTsv, `${z.sheet}: two exact production tables including sparse/empty cells`)
      assert.equal(z.correctlyOwned, z.cells, `${z.sheet}: every recognized word in its intended cell`)
      assert.equal(z.proseInTable, 0, `${z.sheet}: no article words assigned to a table`)
      assert.equal(z.tokensWithBoxes, z.tokens, `${z.sheet}: a positioned result for every printed token`)
      assert(z.maxEdgeErrorPx <= (z.sheet === 'skew' ? 6 : 2.1), `${z.sheet}: token box exceeds source-pixel tolerance`)
      const text = r.rebuiltText.toLowerCase(), sections = ['each left', 'this second', 'the right', 'no amounts'].map(s => text.indexOf(s))
      assert(sections.every((v, i) => v >= 0 && (!i || v > sections[i - 1])), `${z.sheet}: expected column-major article reading order`)
    }
    console.log('PASS real bilingual production path: exact table text, ownership, source geometry and prose-column order on all three sheets')
  } else if (process.argv.includes('--require-bilingual')) {
    throw new Error('The production bilingual validation requires a Chinese profile recognizer and an installed English recognizer; preferences were not changed.')
  } else console.log('NOT TESTED: production Chinese/English table gate (required languages not present); use --require-bilingual for release verification')
  // An explicitly selected English-only recognizer reading Han is diagnostic, not a fallback promise.
  const control = results.find(r => r.summary.sheet === 'control' && /^en\b/i.test(r.summary.language))
  if (control) {
    assert.deepEqual(control.actualTsv, control.expectedTsv, 'clean English control TSV')
    assert.equal(control.summary.correctlyOwned, control.summary.cells, 'clean English cell attribution')
    assert(control.summary.meanTokenIoU >= .70 && control.summary.tokensWithBoxes >= control.summary.tokens * .95, 'clean control boxes')
    console.log('PASS English control: exact TSV / word-index attribution and pixel geometry threshold')
  } else console.log('NO English control gate: English recognizer not installed')
}
main().catch(e => { console.error(e); process.exitCode = 1 })
