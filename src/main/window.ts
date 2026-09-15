// The frameless main window (docs/ARCHITECTURE.md section 5).
import { BrowserWindow, shell, screen } from 'electron'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import { readSettings, writeSettings, type WindowBounds } from './state/settings'
import { resourcesDir } from './paths'

const LCD_HOSTS = [
  'https://sauron-api.infra.pocket.network',
  'https://sauron-api.beta.infra.pocket.network'
]

export async function createMainWindow(): Promise<BrowserWindow> {
  const settings = await readSettings()
  const saved = settings.window
  const bounds: WindowBounds =
    saved && saved.width >= 600 && saved.height >= 400 ? saved : { width: 1320, height: 900 }
  const win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 1000,
    minHeight: 700,
    frame: false, // phase 3: titleBarStyle 'hidden' with trafficLightPosition on macOS
    show: false,
    backgroundColor: settings.theme === 'dark' ? '#101418' : '#f6f7f9',
    icon: join(resourcesDir(), 'pocket.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      devTools: is.dev
    }
  })
  if (!saved || saved.x === undefined) win.center()
  else {
    // Keep the window on a connected display.
    const area = screen.getDisplayMatching(win.getBounds()).workArea
    const b = win.getBounds()
    if (
      b.x < area.x - b.width + 80 ||
      b.x > area.x + area.width - 80 ||
      b.y < area.y ||
      b.y > area.y + area.height - 80
    )
      win.center()
  }
  if (saved?.maximized) win.maximize()

  win.on('ready-to-show', () => win.show())

  // Only a small allow-list of navigation and window opening.
  win.webContents.on('will-navigate', (e, url) => {
    // Vite's dev server may reload the page on its own origin; nothing else may navigate.
    const devUrl = is.dev ? process.env['ELECTRON_RENDERER_URL'] : undefined
    if (devUrl && url.startsWith(devUrl)) return
    e.preventDefault()
  })
  win.webContents.setWindowOpenHandler((details) => {
    if (/^https:\/\//.test(details.url)) shell.openExternal(details.url)
    return { action: 'deny' }
  })
  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    // Development: Vite injects an inline React-refresh preamble and opens an HMR websocket.
    const devScript = is.dev ? " 'unsafe-inline'" : ''
    const devConnect = is.dev ? ' ws://localhost:* http://localhost:*' : ''
    const csp = [
      "default-src 'self'",
      `script-src 'self'${devScript}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self' data:",
      `connect-src 'self' ${LCD_HOSTS.join(' ')} https://explorer.pocket.network${devConnect}`,
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'"
    ].join('; ')
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } })
  })

  let saveTimer: NodeJS.Timeout | null = null
  const persist = (): void => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      const b = win.getNormalBounds()
      void writeSettings({
        window: { x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized() }
      })
    }, 400)
  }
  const tellRenderer = (): void => {
    if (!win.isDestroyed()) win.webContents.send('psm:window-maximized', win.isMaximized())
  }
  win.on('resize', persist)
  win.on('move', persist)
  win.on('maximize', () => {
    persist()
    tellRenderer()
  })
  win.on('unmaximize', () => {
    persist()
    tellRenderer()
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL'])
    await win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else await win.loadFile(join(__dirname, '../renderer/index.html'))
  return win
}
