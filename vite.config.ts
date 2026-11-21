import { cpSync, readdirSync, readFile } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { offlineQpdf } from './build/qpdf-engine.mjs'

const pdfJsRoot = fileURLToPath(
  new URL('./node_modules/pdfjs-dist/', import.meta.url),
)

function pdfJsRuntimeAssets(outDir: string, legacy: boolean): Plugin {
  return {
    name: 'pdfjs-runtime-assets',
    configureServer(server) {
      server.middlewares.use('/pdfjs', (request, response, next) => {
        const pathname = decodeURIComponent(
          (request.url ?? '').split('?', 1)[0],
        ).replace(/^\/+/, '')

        if (
          !/^(cmaps|standard_fonts)\/[a-zA-Z0-9_.-]+$/.test(
            pathname,
          )
        ) {
          next()
          return
        }

        const file = resolve(pdfJsRoot, pathname)
        readFile(file, (error, data) => {
          if (error) {
            next()
            return
          }

          response.statusCode = 200
          response.setHeader(
            'Content-Type',
            'application/octet-stream',
          )
          response.setHeader(
            'Cache-Control',
            'public, max-age=31536000, immutable',
          )
          response.end(data)
        })
      })
    },
    closeBundle() {
      const output = resolve(outDir, 'pdfjs')
      if (!legacy) {
        // The reader requests /pdfjs/{cmaps,standard_fonts}; don't ship the
        // legacy public/ copies a second time. Keep all other public artwork.
        const assets = fileURLToPath(new URL('./public/', import.meta.url))
        for (const name of readdirSync(assets)) {
          if (name !== 'cmaps' && name !== 'standard_fonts') {
            cpSync(resolve(assets, name), resolve(outDir, name), { recursive: true })
          }
        }
      }
      cpSync(
        resolve(pdfJsRoot, 'cmaps'),
        resolve(output, 'cmaps'),
        { recursive: true },
      )
      cpSync(
        resolve(pdfJsRoot, 'standard_fonts'),
        resolve(output, 'standard_fonts'),
        { recursive: true },
      )
    },
  }
}

export default defineConfig(async ({ mode }) => {
  const legacy = mode === 'electron'
  const outDir = fileURLToPath(new URL(legacy ? './dist/' : './dist-tauri/', import.meta.url))
  const plugins = [react(), offlineQpdf(), pdfJsRuntimeAssets(outDir, legacy)]
  return {
  base: './',
  worker: { format: 'es' as const, plugins: () => [offlineQpdf()] }, // the offline compression worker loads additional local modules
  resolve: { dedupe: ['react', 'react-dom'] },
  optimizeDeps: { include: ['@tanstack/react-virtual', '@dnd-kit/core', '@dnd-kit/sortable'] },
  server: { watch: { ignored: ['**/src-tauri/**', '**/dist-tauri/**', '**/release*/**', '**/.work-notes/**'] } },
  plugins: [
    ...plugins,
    legacy && (await import('vite-plugin-electron/simple')).default({
      main: {
        entry: {
          main: 'electron/main.ts',
          ocrWorker: 'electron/ocrWorker.ts',
        },
        ...(process.env.PDF_FACTORY_NO_AUTO_START === '1'
          ? { onstart() {} }
          : {}),
      },
      preload: { input: 'electron/preload.ts' },
    }),
  ],
  build: {
    outDir,
    copyPublicDir: legacy,
    // Production source maps add several megabytes to every desktop package
    // and are not consumed by the local-first release build.
    sourcemap: false,
    rollupOptions: {
      output: {
        // Keep the two PDF engines independently cacheable. They change far
        // less often than application code and no longer invalidate the main
        // renderer chunk on every UI edit.
        manualChunks(id: string) {
          if (id.includes('/pdfjs-dist/')) return 'pdfjs'
          if (id.includes('/pdf-lib/') || id.includes('/@pdf-lib/')) return 'pdf-lib'
          if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/scheduler/')) return 'react'
        },
      },
    },
  },
  }
})
