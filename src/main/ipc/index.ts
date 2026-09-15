// IPC registration: one ipcMain.handle per signer operation (channel
// `signer:<op>`), plus window controls, settings, constrained service-folder
// file access, and the importer. Every payload is validated with zod first.
import { app, ipcMain, dialog, BrowserWindow, shell } from 'electron'
import { join, resolve, sep, isAbsolute } from 'node:path'
import { promises as fs } from 'node:fs'
import { SIGNER_OPS, type SignerOp, type ProgressEvent } from '@core/contract'
import {
  POCKETD_IMAGE,
  POCKET_AP_IMAGE,
  POCKETD_VERSION,
  MCP_ENDPOINT,
  APP_VERSION_PREFIX
} from '@core/versions'
import {
  requestSchemas,
  windowBoundsSchema,
  settingsPatchSchema,
  serviceFileSchema,
  importSchema,
  serviceReadFileSchema
} from './schemas'
import { signer } from '../signer'
import { readSettings, writeSettings } from '../state/settings'
import { readText, writeText, exists, isDir } from '../state/files'
import { detectHta, importFromHta } from '../migration/importer'
import { dataDir } from '../paths'
import { log } from '../state/log'

function bad(msg: string): { ok: false; error: string; detail: string } {
  return { ok: false, error: msg, detail: '' }
}

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  // Progress events stream to the renderer by runId.
  signer.on('progress', (ev: ProgressEvent) => {
    const w = getWindow()
    if (w && !w.isDestroyed()) w.webContents.send('psm:progress', ev)
  })

  for (const op of SIGNER_OPS) {
    ipcMain.handle(`signer:${op}`, async (_e, payload: unknown, runId?: unknown) => {
      const parsed = requestSchemas[op].safeParse(payload ?? {})
      if (!parsed.success)
        return bad(
          'Invalid request: ' +
            parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')
        )
      const id = typeof runId === 'string' && /^[a-z0-9]{1,32}$/.test(runId) ? runId : undefined
      return signer.run(op as SignerOp, parsed.data, { runId: id })
    })
  }
  ipcMain.handle('signer:cancel', (_e, runId: unknown) =>
    typeof runId === 'string' ? signer.cancel(runId) : false
  )
  ipcMain.handle('signer:new-run-id', () => signer.newRunId())

  // Window chrome.
  ipcMain.handle('window:minimize', () => getWindow()?.minimize())
  ipcMain.handle('window:toggle-maximize', () => {
    const w = getWindow()
    if (!w) return false
    if (w.isMaximized()) w.unmaximize()
    else w.maximize()
    return w.isMaximized()
  })
  ipcMain.handle('window:is-maximized', () => getWindow()?.isMaximized() ?? false)
  ipcMain.handle('window:close', () => getWindow()?.close())

  // App info for Settings.
  ipcMain.handle('app:info', async () => ({
    version: app.getVersion(),
    compatVersion: APP_VERSION_PREFIX + app.getVersion(),
    electron: process.versions.electron,
    pocketdImage: POCKETD_IMAGE,
    pocketdVersion: POCKETD_VERSION,
    pocketApImage: POCKET_AP_IMAGE,
    mcpEndpoint: MCP_ENDPOINT,
    dataDir: dataDir(),
    packaged: app.isPackaged
  }))
  ipcMain.handle('app:open-external', async (_e, url: unknown) => {
    if (typeof url !== 'string' || !/^https:\/\//.test(url)) return false
    await shell.openExternal(url)
    return true
  })
  ipcMain.handle('app:open-path', async (_e, p: unknown) => {
    if (typeof p !== 'string') return false
    const s = await readSettings()
    const root = s.servicesRoot ? resolve(s.servicesRoot) : null
    const target = resolve(p)
    if (
      target !== resolve(dataDir()) &&
      !(root && (target === root || target.startsWith(root + sep)))
    )
      return false
    await shell.openPath(target)
    return true
  })

  // Reachability probe for a stack or endpoint URL: any HTTP status counts as answering.
  // The renderer's CSP forbids it from fetching arbitrary hosts, so main does it.
  ipcMain.handle('net:probe-url', async (_e, url: unknown) => {
    if (typeof url !== 'string' || !/^https?:\/\/[^\s]+$/.test(url) || url.length > 2048) return 0
    try {
      const res = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(20_000)
      })
      return res.status || 0
    } catch {
      return 0
    }
  })
  ipcMain.handle('files:pick-file', async (_e, opts: unknown) => {
    const o = (opts && typeof opts === 'object' ? opts : {}) as { initial?: string; json?: boolean }
    const w = getWindow()
    const r = await dialog.showOpenDialog(w ?? new BrowserWindow({ show: false }), {
      properties: ['openFile'],
      defaultPath: typeof o.initial === 'string' ? o.initial : undefined,
      filters: o.json
        ? [
            { name: 'JSON', extensions: ['json'] },
            { name: 'All files', extensions: ['*'] }
          ]
        : undefined
    })
    return r.canceled ? null : r.filePaths[0]
  })
  ipcMain.handle('files:exists', async (_e, p: unknown) =>
    typeof p === 'string' && p.length < 2048 ? exists(p) : false
  )
  ipcMain.handle('files:is-dir', async (_e, p: unknown) =>
    typeof p === 'string' && p.length < 2048 ? isDir(p) : false
  )
  ipcMain.handle('files:clear-relay-tests', async () => {
    try {
      await fs.rm(join(dataDir(), 'relay-tests.log'), { force: true })
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  // Settings.
  ipcMain.handle('settings:get', () => readSettings())
  ipcMain.handle('settings:set', async (_e, patch: unknown) => {
    const parsed = settingsPatchSchema.safeParse(patch)
    if (!parsed.success)
      return bad('Invalid settings: ' + parsed.error.issues.map((i) => i.path.join('.')).join(', '))
    return writeSettings(parsed.data as Parameters<typeof writeSettings>[0])
  })
  ipcMain.handle('settings:set-window', async (_e, bounds: unknown) => {
    const parsed = windowBoundsSchema.safeParse(bounds)
    if (parsed.success) await writeSettings({ window: parsed.data })
  })
  ipcMain.handle('files:pick-dir', async (_e, initial: unknown) => {
    const w = getWindow()
    const r = await dialog.showOpenDialog(w ?? new BrowserWindow({ show: false }), {
      properties: ['openDirectory'],
      defaultPath: typeof initial === 'string' ? initial : undefined
    })
    return r.canceled ? null : r.filePaths[0]
  })

  // Service folders under settings.servicesRoot: the renderer's only file access.
  async function servicesRoot(): Promise<string | null> {
    const s = await readSettings()
    return s.servicesRoot && exists(s.servicesRoot) ? resolve(s.servicesRoot) : null
  }
  function servicePath(root: string, id: string, name: string): string {
    const p = resolve(join(root, id, ...name.split('/')))
    if (!p.startsWith(root + sep)) throw new Error('Path escapes the services folder.')
    return p
  }
  ipcMain.handle('files:read-service-folders', async () => {
    const root = await servicesRoot()
    if (!root) return { root: null, folders: [] }
    const folders: {
      folder: string
      manifest: unknown
      hasCard: boolean
      hasDockerfile: boolean
      hasCompose: boolean
    }[] = []
    for (const d of await fs.readdir(root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue
      const manifestText = await readText(join(root, d.name, 'service.json'))
      if (manifestText === null) continue
      let manifest: unknown = null
      try {
        manifest = JSON.parse(manifestText)
      } catch {
        manifest = null
      }
      const cardRel =
        manifest &&
        typeof manifest === 'object' &&
        typeof (manifest as { card?: unknown }).card === 'string'
          ? (manifest as { card: string }).card || 'card.json'
          : 'card.json'
      folders.push({
        folder: d.name,
        manifest,
        hasCard: exists(isAbsolute(cardRel) ? cardRel : join(root, d.name, cardRel)),
        hasDockerfile: exists(join(root, d.name, 'backend', 'Dockerfile')),
        hasCompose: exists(join(root, d.name, 'deploy', 'docker-compose.yaml'))
      })
    }
    return { root, folders }
  })
  ipcMain.handle('files:read-service-file', async (_e, req: unknown) => {
    const parsed = serviceReadFileSchema.safeParse(req)
    const root = await servicesRoot()
    if (!parsed.success || !root) return null
    try {
      return await readText(servicePath(root, parsed.data.id, parsed.data.name.replace(/\\/g, '/')))
    } catch {
      return null
    }
  })
  ipcMain.handle('files:write-service-file', async (_e, req: unknown, text: unknown) => {
    const parsed = serviceFileSchema.safeParse(req)
    const root = await servicesRoot()
    if (!parsed.success || !root || typeof text !== 'string' || text.length > 2_000_000)
      return false
    await writeText(servicePath(root, parsed.data.id, parsed.data.name), text)
    return true
  })
  ipcMain.handle(
    'files:read-relay-tests',
    async () => (await readText(join(dataDir(), 'relay-tests.log'))) ?? ''
  )
  ipcMain.handle('files:append-relay-test', async (_e, line: unknown) => {
    if (typeof line !== 'string' || line.length > 200_000)
      return { ok: false, error: 'Invalid log line.' }
    try {
      await fs.appendFile(
        join(dataDir(), 'relay-tests.log'),
        line.replace(/\r?\n/g, ' ') + '\n',
        'utf8'
      )
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  // Migration.
  ipcMain.handle('migration:detect', () => detectHta())
  ipcMain.handle('migration:import', async (_e, opts: unknown) => {
    const parsed = importSchema.safeParse(opts ?? {})
    if (!parsed.success) return bad('Invalid import request.')
    const w = getWindow()
    return importFromHta({
      servicesRoot: parsed.data.servicesRoot,
      progress: (ev) => {
        if (w && !w.isDestroyed())
          w.webContents.send('psm:progress', {
            ...ev,
            runId: 'import',
            op: 'history',
            time: new Date().toISOString()
          })
      }
    })
  })

  log.info('ipc registered', { ops: SIGNER_OPS.length })
}
