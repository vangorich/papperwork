// Offline: no browser server, real documents, printer, or desktop save APIs.
// The producer is the real compositor, not Python recreating the PDF operations.
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { spawnSync } = require('node:child_process')
const root = resolve(__dirname, '..')
const tmp = mkdtempSync(join(tmpdir(), 'paperwork-persistence-'))
function run(command, args, env = process.env) {
  const r = spawnSync(command, args, { cwd: root, env, stdio: 'inherit' })
  if (r.error) throw r.error
  if (r.status !== 0) throw Error(`${command} failed (${r.signal || r.status})`)
}
try {
  run(process.execPath, [join(root,'node_modules/vitest/vitest.mjs'), 'run', '--silent', '--fileParallelism=false', 'src/lib/pdfPersistence025.test.ts'], { ...process.env, PW_PERSISTENCE_PROOF_DIR: tmp })
  run(process.env.PYTHON || 'python', ['-I', '-c', String.raw`
import sys
from pathlib import Path
import pymupdf as mu
import pypdfium2 as pdfium
root = Path(sys.argv[1])
def file(name): return root/(name + '.pdf')
def pixels(name, i=0):
    with mu.open(file(name)) as doc:
        return doc[i].get_pixmap(matrix=mu.Matrix(2,2), alpha=False).samples
mixed = '合同 A9 café 𠀀'
for name in ['ocr', 'ocr-again']:
    with mu.open(file(name)) as doc:
        p = doc[0]
        text = p.get_text()
        assert text.count(mixed) == 1 and text.count('NATIVE') == 1, repr(text)
        hit = p.search_for(mixed)
        assert len(hit) == 1, hit
        # Unrotated, crop-relative, top-left units. Source CropBox = (32,40,240,160).
        assert max(abs(a-b) for a,b in zip(hit[0], (36,64,168,80))) < 1, hit
    assert pixels(name) == pixels('base'), name + ' changed pixels'
    with pdfium.PdfDocument(file(name)) as d:
        pg = d[0]; txt = pg.get_textpage()
        try:
            s = txt.get_text_bounded()
            assert s.count(mixed) == 1 and s.count('NATIVE') == 1, repr(s)
        finally:
            txt.close(); pg.close()
assert pixels('flat') == pixels('flat-ocr'), 'post-flatten OCR changed the raster'
with mu.open(file('flat-ocr')) as flat:
    assert flat[0].get_text().count(mixed) == 1
print('MuPDF + PDFium: mixed Unicode searchable once on both byte reopens; MuPDF search box within 1 pt; 2x RGB identical including post-flatten OCR.')
for kind in ['image','text']:
    for i in [0,1]:
        marked = pixels(kind+'-marked',i); base = pixels('base')
        assert marked != base, kind
        assert pixels(kind+'-round',i) == marked, kind+' stacked its opacity'
        edited = pixels(kind+'-edit',i)
        assert edited != base and edited != marked, kind+' edit missing'
        assert pixels(kind+'-removed',i) == base, kind+' left ink or removed third-party artwork'
print('MuPDF: both pages of text/image editions visibly marked and edited, repeated exports identical, removal pixel-exact to third-party original.')
`, tmp], { ...process.env, PYTHONIOENCODING: 'utf-8' })
} catch (e) {
  console.error(e.message); process.exitCode = 1
} finally {
  rmSync(tmp,{ recursive:true, force:true })
}
