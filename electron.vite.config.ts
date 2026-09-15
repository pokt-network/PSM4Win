import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

const core = resolve('src/core')

// Production pages load over file://, where a CSP header is not delivered, so the
// strict policy is injected as a meta tag at build time only. In development the
// main process sends a header relaxed for Vite's inline refresh preamble and HMR.
const PROD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self' https://sauron-api.infra.pocket.network https://sauron-api.beta.infra.pocket.network https://explorer.pocket.network",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ')

const cspMeta: Plugin = {
  name: 'psm-csp-meta',
  apply: 'build',
  transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: PROD_CSP }, injectTo: 'head-prepend' }]
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@core': core } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@core': core } }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@core': core
      }
    },
    plugins: [react(), cspMeta]
  }
})
