// Main process entry. Sets the data folder, starts the log, registers IPC, and
// opens the window. With `--selftest=beta` it runs the phase 1 exit check
// headless and exits (src/main/selftest.ts).
import { app, BrowserWindow, Notification } from 'electron'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { configureAppPaths, dataFiles } from './paths'
import { initLog, log } from './state/log'
import { clearScratch } from './signer/work'
import { registerIpc } from './ipc'
import { createMainWindow } from './window'
import { runSelfTest } from './selftest'
import { bridge } from './bridge'
import { updater } from './update'
import { performance } from './performance'
import { readSettings } from './state/settings'
import { applyPrefs, hideOnClose, initTray, setTrayWarnings, HIDDEN_ARG } from './tray'

configureAppPaths()

const selftestArg = process.argv.find((a) => a.startsWith('--selftest'))
const smokeMode = process.argv.includes('--smoke') || process.env.PSM_SMOKE === '1'
// `--screenshot=<file.png>`: open the window on example data, capture it, and exit (README image).
const screenshotArg = process.argv.find((a) => a.startsWith('--screenshot='))
const screenshotPath = screenshotArg ? screenshotArg.slice('--screenshot='.length) : null
// Headless checks may run beside a normal instance; only the interactive app takes the lock.
const gotLock = selftestArg || smokeMode || screenshotPath ? true : app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  let mainWindow: BrowserWindow | null = null

  // The window may be hidden in the tray: a second start, the tray, or a notification shows it.
  const showWindow = async (): Promise<BrowserWindow> => {
    if (!mainWindow) {
      mainWindow = await createMainWindow()
      watchWindow(mainWindow)
    }
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    return mainWindow
  }
  const openPerformance = async (): Promise<void> => {
    const w = await showWindow()
    w.webContents.send('psm:navigate', 'performance')
  }
  const watchWindow = (w: BrowserWindow): void => {
    w.on('closed', () => {
      mainWindow = null
    })
    hideOnClose(w, () => {
      if (!Notification.isSupported()) return
      new Notification({
        title: 'Pocket Service Manager is still running',
        body: 'It keeps watching your suppliers from the system tray. Quit it from the tray icon.'
      }).show()
    })
  }

  app.on('second-instance', () => void showWindow())

  app.whenReady().then(async () => {
    initLog(dataFiles.appLog(), is.dev || !!selftestArg)
    log.info('app start', {
      version: app.getVersion(),
      electron: process.versions.electron,
      dev: is.dev
    })
    await clearScratch()

    if (selftestArg) {
      const net = selftestArg.split('=')[1] || 'beta'
      const code = await runSelfTest(net)
      await log.flush()
      app.exit(code)
      return
    }

    electronApp.setAppUserModelId('network.pocket.servicemanager')
    app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))
    registerIpc(() => mainWindow)
    if (screenshotPath) {
      const win = await createMainWindow({ demo: true })
      mainWindow = win
      setTimeout(async () => {
        try {
          const image = await win.webContents.capturePage()
          const { promises: fsp } = await import('node:fs')
          const { dirname, resolve } = await import('node:path')
          const out = resolve(screenshotPath)
          await fsp.mkdir(dirname(out), { recursive: true })
          await fsp.writeFile(out, image.toPNG())
          console.log(
            `screenshot: wrote ${out} (${image.getSize().width}x${image.getSize().height})`
          )
          await log.flush()
          app.exit(0)
        } catch (e) {
          console.log('screenshot: failed: ' + (e as Error).message)
          app.exit(1)
        }
      }, 6000)
      return
    }
    // Started by Windows at sign-in (Settings, Start with Windows): stay in the tray.
    mainWindow = await createMainWindow({ hidden: process.argv.includes(HIDDEN_ARG) })
    if (!smokeMode) {
      initTray({ open: () => void showWindow(), check: () => void performance.check() })
      const s = await readSettings()
      applyPrefs({ trayEnabled: s.trayEnabled !== false, startWithWindows: !!s.startWithWindows })
      // Hidden with no tray to open it from would leave the app running out of reach.
      if (s.trayEnabled === false) mainWindow.show()
      watchWindow(mainWindow)
      performance.init(
        (st) => {
          setTrayWarnings(st.warnings)
          if (mainWindow && !mainWindow.isDestroyed())
            mainWindow.webContents.send('psm:performance', st)
        },
        () => void openPerformance()
      )
    }
    // The local MCP action bridge starts only when Settings enabled it.
    await bridge.init(() => mainWindow)
    // Release checks: 20 s after start, then every six hours, and on demand from Settings.
    if (!smokeMode) updater.init(() => mainWindow)

    // `--smoke`: prove the window, preload, and renderer load without console errors, then exit.
    if (smokeMode) {
      const errors: string[] = []
      mainWindow.webContents.on('console-message', (ev) => {
        if (ev.level === 'error') errors.push(ev.message)
      })
      setTimeout(async () => {
        const title = mainWindow?.getTitle() ?? ''
        const ok = errors.length === 0 && /Pocket Service Manager/.test(title)
        console.log(
          `smoke: title="${title}" consoleErrors=${errors.length} ${ok ? 'PASS' : 'FAIL'}`
        )
        for (const e of errors) console.log('smoke: error: ' + e)
        await log.flush()
        app.exit(ok ? 0 : 1)
      }, 2500)
    }

    app.on('activate', async () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = await createMainWindow()
    })
  })

  app.on('window-all-closed', () => {
    // phase 3: macOS keeps the app alive until Cmd+Q
    void bridge.stop()
    updater.stop()
    performance.stop()
    app.quit()
  })
}
