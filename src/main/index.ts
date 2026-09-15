// Main process entry. Sets the data folder, starts the log, registers IPC, and
// opens the window. With `--selftest=beta` it runs the phase 1 exit check
// headless and exits (src/main/selftest.ts).
import { app, BrowserWindow } from 'electron'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { configureAppPaths, dataFiles } from './paths'
import { initLog, log } from './state/log'
import { clearScratch } from './signer/work'
import { registerIpc } from './ipc'
import { createMainWindow } from './window'
import { runSelfTest } from './selftest'

configureAppPaths()

const selftestArg = process.argv.find((a) => a.startsWith('--selftest'))
const smokeMode = process.argv.includes('--smoke') || process.env.PSM_SMOKE === '1'
// Headless checks may run beside a normal instance; only the interactive app takes the lock.
const gotLock = selftestArg || smokeMode ? true : app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  let mainWindow: BrowserWindow | null = null

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

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
    mainWindow = await createMainWindow()
    mainWindow.on('closed', () => {
      mainWindow = null
    })

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
    app.quit()
  })
}
