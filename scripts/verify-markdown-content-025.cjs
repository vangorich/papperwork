// Offline proof: the Vitest suite synthesizes every PDF and inspects the returned PNG pixels.
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const vitest = path.join(path.dirname(require.resolve('vitest/package.json', { paths: [root] })), 'vitest.mjs')
const run = spawnSync(process.execPath, [vitest, 'run', 'src/lib/pdfMarkdown.test.ts', '--reporter=verbose'], { cwd: root, stdio: 'inherit' })
if (run.error) throw run.error
process.exitCode = run.status ?? 1
