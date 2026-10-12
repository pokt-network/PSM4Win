// The system tray (docs/ARCHITECTURE.md section 10): closing the window hides it while the
// tray setting is on, so the Performance monitor keeps watching the suppliers; the tray menu
// opens the window, checks now, or quits. Start with Windows registers the app to start in
// the tray at sign-in.
import { app, Menu, Tray, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import { resourcesDir } from './paths'
import { loginItemPath } from '@core/update'

export interface AppPrefs {
  /** Keep running in the tray when the window is closed (default on). */
  trayEnabled: boolean
  /** Start in the tray when Windows starts (default off; packaged builds only). */
  startWithWindows: boolean
}

let tray: Tray | null = null
let quitting = false
let prefs: AppPrefs = { trayEnabled: true, startWithWindows: false }
let menu: { open: () => void; check: () => void } | null = null

/** Sets what the tray menu does; call once at start, before applyPrefs. */
export function initTray(m: { open: () => void; check: () => void }): void {
  menu = m
}

/** The launch argument start-with-Windows passes, so the app starts in the tray. */
export const HIDDEN_ARG = '--hidden'

export function isQuitting(): boolean {
  return quitting
}

export function trayPrefs(): AppPrefs {
  return prefs
}

/** Applies the settings: shows or removes the tray icon, and the sign-in entry. */
export function applyPrefs(next: Partial<AppPrefs>): void {
  prefs = { ...prefs, ...next }
  if (prefs.trayEnabled && !tray && menu) createTray(menu)
  if (!prefs.trayEnabled && tray) {
    tray.destroy()
    tray = null
  }
  if (app.isPackaged)
    app.setLoginItemSettings({
      openAtLogin: prefs.startWithWindows,
      path: loginItemPath(process.execPath),
      args: [HIDDEN_ARG]
    })
}

function createTray(menu: { open: () => void; check: () => void }): void {
  tray = new Tray(join(resourcesDir(), 'pocket.ico'))
  tray.setToolTip('Pocket Service Manager')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Pocket Service Manager', click: menu.open },
      { label: 'Check suppliers now', click: menu.check },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          quitting = true
          app.quit()
        }
      }
    ])
  )
  tray.on('click', menu.open)
}

/** The tray's hover text: says how many suppliers need attention. */
export function setTrayWarnings(n: number): void {
  tray?.setToolTip(
    n
      ? `Pocket Service Manager: ${n} supplier${n > 1 ? 's' : ''} not claiming`
      : 'Pocket Service Manager'
  )
}

/**
 * Closing the window hides it to the tray while the tray is on, unless the app is quitting
 * (the tray's Quit, the updater, or Windows shutting down).
 */
export function hideOnClose(win: BrowserWindow, onFirstHide: () => void): void {
  let told = false
  app.on('before-quit', () => {
    quitting = true
  })
  win.on('close', (e) => {
    if (quitting || !prefs.trayEnabled || !tray) return
    e.preventDefault()
    win.hide()
    if (!told) {
      told = true
      onFirstHide()
    }
  })
}
