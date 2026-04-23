import { copyFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig } from 'vite'

/**
 * Build mode switch:
 *   `vite build`                      → site build, dist/
 *   `vite build --mode extension`     → extension build, dist-extension/
 *
 * The extension build bundles the same app, copies web/extension/*
 * (manifest.json, background.js) into the output root, and relies on
 * base: './' so assets resolve from chrome-extension://<id>/ correctly.
 */
export default defineConfig(({ mode }) => {
  const isExtension = mode === 'extension'
  return {
    base: './',
    build: {
      outDir: isExtension ? 'dist-extension' : 'dist',
      target: 'es2022',
      sourcemap: true
    },
    plugins: isExtension ? [copyExtensionFilesPlugin()] : []
  }
})

function copyExtensionFilesPlugin() {
  return {
    name: 'copy-extension-files',
    closeBundle() {
      const src = 'extension'
      const dest = 'dist-extension'
      for (const entry of readdirSync(src)) {
        const from = join(src, entry)
        const to = join(dest, entry)
        if (statSync(from).isFile()) copyFileSync(from, to)
      }
    }
  }
}
