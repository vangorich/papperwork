const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { execFileSync } = require('node:child_process')
const { _electron: electron } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib')

;(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-actions-'))
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  let app
  try {
    const files = []
    for (const [name, count] of [['A', 1], ['B', 2]]) {
      const pdf = await PDFDocument.create(); const font = await pdf.embedFont(StandardFonts.Helvetica)
      for (let i = 0; i < count; i++) {
        const page = pdf.addPage([400, 500])
        page.drawText(`${name}-${i + 1}`, { x: 80, y: 350, size: 32, font, color: rgb(0, 0, 0) })
      }
      const file = path.join(dir, `${name}.pdf`); fs.writeFileSync(file, await pdf.save()); files.push(file)
    }
    app = await electron.launch({ executablePath: process.env.OCR_E2E_EXECUTABLE, args: [`--user-data-dir=${path.join(dir, 'profile')}`, files[0]], env, timeout: 60000 })
    const page = await app.firstWindow(); const errors = []
    page.on('pageerror', e => errors.push(e.message))
    const active = () => page.locator('.app-shell:not([hidden])')
    await page.locator('#pdf-stage .stage-page canvas').first().waitFor({ state: 'visible', timeout: 60000 })
    await active().getByRole('button', { name: '工作区', exact: true }).click()
    await app.evaluate(({ dialog }, files) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: files }) }, files)
    await active().getByRole('button', { name: '打开', exact: true }).click()
    await active().locator('.sidebar .thumbnail').nth(2).waitFor({ timeout: 30000 })
    assert.equal(await active().locator('.sidebar .thumbnail').count(), 3, 'Merge workspace hid imported pages')
    assert.equal(await active().getByText('页面拼接工作区', { exact: true }).count(), 0)
    const tab = active().locator('.workspace-tabs [role="tab"]').first()
    await tab.click({ button: 'right' })
    assert.deepEqual(await page.getByRole('menu', { name: '工作区菜单' }).getByRole('menuitem').allTextContents(), ['工作区信息', '重命名工作区', '新建工作区', '关闭工作区'])
    await page.getByRole('menuitem', { name: '工作区信息', exact: true }).click()
    const info = page.getByRole('dialog', { name: '工作区信息' })
    assert.equal(await info.locator('dl > div').first().locator('dd').textContent(), '3')
    await info.getByRole('button', { name: '关闭', exact: true }).click()
    await tab.click({ button: 'right' })
    await page.getByRole('menuitem', { name: '重命名工作区', exact: true }).click()
    await page.getByRole('textbox', { name: '工作区名称', exact: true }).fill('整理测试工作区')
    await page.getByRole('button', { name: '保存名称', exact: true }).click()
    assert.equal((await tab.textContent()).trim(), '整理测试工作区')
    if (process.env.DEBUG_SCREENSHOTS) await page.screenshot({ path: path.join(process.env.DEBUG_SCREENSHOTS, 'workspace-tabs.png') })
    await tab.click({ button: 'right' }); await tab.click()
    assert.equal(await page.getByRole('menu', { name: '工作区菜单' }).count(), 0)
    await active().getByRole('button', { name: '页面多选：批量选择页面缩略图', exact: true }).click()
    const placement = await active().getByRole('toolbar').evaluate(el => {
      const page = el.querySelector('.toolbar__section[data-tone="page"]')
      const selection = el.querySelector('.toolbar__section--selection')
      const protection = el.querySelector('.toolbar__section--security')
      return { adjacent: page.nextElementSibling === selection, next: selection.nextElementSibling === protection, label: protection.firstElementChild.textContent }
    })
    assert.deepEqual(placement, { adjacent: true, next: true, label: '保护' })
    await active().getByRole('button', { name: '退出多选 Esc', exact: true }).click()
    const profilePath = await app.evaluate(({ app }) => app.getPath('userData'))
    const queue = path.join(profilePath, 'VirtualPrintQueue')
    fs.mkdirSync(queue, { recursive: true })
    fs.copyFileSync(files[0], path.join(queue, '01-A.pdf'))
    fs.copyFileSync(files[1], path.join(queue, '02-B.pdf'))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('virtual-printer:job-ready'))
    await active().getByRole('button', { name: /打印清单/ }).click()
    await active().locator('.sidebar .thumbnail').nth(2).waitFor({ timeout: 30000 })
    assert.equal(await active().locator('.sidebar .thumbnail').count(), 3, 'Virtual print collector hid queued pages')
    await app.evaluate(({ ipcMain }) => {
      globalThis.__printCaptures = []
      ipcMain.removeHandler('print:pages')
      ipcMain.handle('print:pages', (_event, payload) => {
        globalThis.__printCaptures.push(payload.pages.map(page => {
          let hash = 2166136261
          for (const byte of page.png) hash = Math.imul(hash ^ byte, 16777619)
          return `${page.widthPt}:${page.heightPt}:${page.png.length}:${hash >>> 0}`
        }))
        return true
      })
    })
    await active().getByRole('button', { name: '批量打印 / 打印设置', exact: true }).click()
    await page.locator('.print-preview__drag').nth(2).waitFor()
    await page.getByRole('button', { name: '开始打印', exact: true }).click()
    await page.locator('.dialog__panel--print').waitFor({ state: 'detached', timeout: 60000 })
    const baseline = await app.evaluate(() => globalThis.__printCaptures[0])
    assert.equal(baseline.length, 3)
    await active().getByRole('button', { name: '批量打印 / 打印设置', exact: true }).click()
    const handles = page.locator('.print-preview__drag')
    await handles.nth(2).waitFor()
    const movedHandle = page.getByRole('button', { name: /调整第 1 页打印顺序/ })
    const firstHandle = await handles.first().boundingBox(), lastHandle = await handles.nth(2).boundingBox()
    await page.mouse.move(firstHandle.x + firstHandle.width / 2, firstHandle.y + firstHandle.height / 2)
    await page.mouse.down()
    await page.mouse.move(lastHandle.x + lastHandle.width / 2, lastHandle.y + lastHandle.height / 2, { steps: 20 })
    await page.mouse.up()
    assert((await handles.nth(2).getAttribute('aria-label')).includes('第 1 页'), 'Pointer drag did not reorder preview')
    await movedHandle.focus(); await page.keyboard.press('Space'); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft'); await page.keyboard.press('Space')
    assert((await handles.first().getAttribute('aria-label')).includes('第 1 页'))
    await movedHandle.focus(); await page.keyboard.press('Space'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('Space')
    assert((await handles.nth(2).getAttribute('aria-label')).includes('第 1 页'))
    await page.getByRole('button', { name: '开始打印', exact: true }).click()
    await page.locator('.dialog__panel--print').waitFor({ state: 'detached', timeout: 60000 })
    const reordered = await app.evaluate(() => globalThis.__printCaptures[1])
    assert.deepEqual(reordered, [baseline[1], baseline[2], baseline[0]], 'Actual print raster sequence did not match preview drag order')
    assert.deepEqual(errors, [])
    console.log(JSON.stringify({ ok: true, workspaceThumbnails: 3, virtualPrintThumbnails: 3, pageActionsAdjacent: true, pageErrors: errors }))
  } finally {
    if (app) try { execFileSync('taskkill.exe', ['/PID', String(app.process().pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  }
})().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
