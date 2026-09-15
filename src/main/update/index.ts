// The updater (docs/ARCHITECTURE.md section 8). Checks the repository's latest release
// on a timer and on demand, and installs the way the running copy was installed:
// Scoop hands off to the user's Scoop; an installer copy downloads the new installer,
// verifies its SHA-256 against the release's SHA256SUMS, and runs it; a portable copy
// downloads the zip, verifies it, and shows it; a development build only reports.
import { app, shell, type BrowserWindow } from 'electron'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  RELEASES_API,
  RELEASES_PAGE,
  compareVersions,
  detectInstallKind,
  parseChecksums,
  parseVersion,
  pickReleaseAssets,
  plainNotes,
  type ReleaseInfo,
  type UpdateStatus
} from '@core/update'
import { APP_VERSION_PREFIX } from '@core/versions'
import { log } from '../state/log'

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
const FIRST_CHECK_DELAY_MS = 20_000
const FETCH_TIMEOUT_MS = 20_000
const SCOOP_APP = 'pocket-service-manager'

class UpdateService {
  private getWindow: () => BrowserWindow | null = () => null
  private timer: NodeJS.Timeout | null = null
  private release: ReleaseInfo | null = null
  private st: UpdateStatus = {
    current: '',
    latest: null,
    available: false,
    url: null,
    notes: null,
    checkedAt: null,
    state: 'idle',
    error: null,
    installKind: 'dev',
    progress: null,
    savedTo: null
  }

  init(getWindow: () => BrowserWindow | null): void {
    this.getWindow = getWindow
    const exe = process.execPath
    const hasUninstaller = existsSync(join(dirname(exe), 'Uninstall Pocket Service Manager.exe'))
    this.st = {
      ...this.st,
      current: app.getVersion(),
      installKind: detectInstallKind(exe, app.isPackaged, hasUninstaller)
    }
    setTimeout(() => void this.check(), FIRST_CHECK_DELAY_MS)
    this.timer = setInterval(() => void this.check(), CHECK_INTERVAL_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  status(): UpdateStatus {
    return this.st
  }

  private set(patch: Partial<UpdateStatus>): void {
    this.st = { ...this.st, ...patch }
    const w = this.getWindow()
    if (w && !w.isDestroyed()) w.webContents.send('psm:update-status', this.st)
  }

  async check(): Promise<UpdateStatus> {
    if (this.st.state === 'downloading' || this.st.state === 'installing') return this.st
    this.set({ state: 'checking', error: null })
    try {
      const res = await fetch(RELEASES_API, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': `${APP_VERSION_PREFIX}${app.getVersion()} (${process.platform})`
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      })
      if (res.status === 404) {
        // No release published yet: nothing to offer.
        this.release = null
        this.set({
          state: 'idle',
          latest: null,
          available: false,
          url: RELEASES_PAGE,
          notes: null,
          checkedAt: new Date().toISOString()
        })
        return this.st
      }
      if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status}.`)
      const rel = (await res.json()) as ReleaseInfo
      const latestV = parseVersion(rel.tag_name)
      if (!latestV || rel.draft) throw new Error(`Unexpected release tag '${rel.tag_name}'.`)
      const latest = latestV.join('.')
      this.release = rel
      this.set({
        state: 'idle',
        latest,
        available: compareVersions(latest, this.st.current) > 0,
        url: rel.html_url,
        notes: plainNotes(rel.body),
        checkedAt: new Date().toISOString()
      })
      log.info('update check', { current: this.st.current, latest, available: this.st.available })
    } catch (e) {
      this.set({ state: 'error', error: (e as Error).message, checkedAt: new Date().toISOString() })
      log.error('update check failed', { error: (e as Error).message })
    }
    return this.st
  }

  async install(): Promise<UpdateStatus> {
    if (!this.st.available || !this.st.latest || !this.release) return this.st
    if (this.st.state === 'downloading' || this.st.state === 'installing') return this.st
    try {
      switch (this.st.installKind) {
        case 'dev':
          throw new Error('This is a development build; run it from the repository instead.')
        case 'scoop':
          await this.installWithScoop()
          break
        case 'installer':
          await this.installWithSetup()
          break
        case 'portable':
          await this.downloadPortable()
          break
      }
    } catch (e) {
      this.set({ state: 'error', error: (e as Error).message, progress: null })
      log.error('update install failed', { error: (e as Error).message })
    }
    return this.st
  }

  /** Scoop owns the files: open a visible console that runs its updater, then quit so it can replace them. */
  private async installWithScoop(): Promise<void> {
    this.set({ state: 'installing', error: null })
    const child = spawn(
      'cmd.exe',
      [
        '/c',
        'start',
        '"Pocket Service Manager update"',
        'cmd.exe',
        '/k',
        `scoop update ${SCOOP_APP}`
      ],
      { detached: true, stdio: 'ignore', windowsHide: false, shell: false }
    )
    child.unref()
    log.info('update: handed off to scoop')
    setTimeout(() => app.quit(), 1500)
  }

  private async installWithSetup(): Promise<void> {
    const v = this.st.latest!
    const assets = pickReleaseAssets(this.release!, v)
    if (!assets.setup || !assets.sums)
      throw new Error('The release is missing its installer or checksum file.')
    const dir = join(app.getPath('temp'), 'pocket-service-manager-update')
    await fs.mkdir(dir, { recursive: true })
    const file = join(dir, assets.setup.name)
    await this.download(assets.setup.browser_download_url, file)
    await this.verify(file, assets.setup.name, assets.sums.browser_download_url)
    this.set({ state: 'installing', progress: null })
    const child = spawn(file, [], { detached: true, stdio: 'ignore' })
    child.unref()
    log.info('update: installer started', { file })
    setTimeout(() => app.quit(), 1500)
  }

  private async downloadPortable(): Promise<void> {
    const v = this.st.latest!
    const assets = pickReleaseAssets(this.release!, v)
    if (!assets.zip || !assets.sums)
      throw new Error('The release is missing its portable zip or checksum file.')
    const file = join(app.getPath('downloads'), assets.zip.name)
    await this.download(assets.zip.browser_download_url, file)
    await this.verify(file, assets.zip.name, assets.sums.browser_download_url)
    this.set({ state: 'idle', progress: null, savedTo: file })
    shell.showItemInFolder(file)
    log.info('update: portable zip downloaded', { file })
  }

  private async download(url: string, dest: string): Promise<void> {
    this.set({ state: 'downloading', progress: 0, error: null, savedTo: null })
    const res = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) })
    if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}.`)
    const total = Number(res.headers.get('content-length') ?? 0)
    const chunks: Buffer[] = []
    let got = 0
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(Buffer.from(value))
      got += value.byteLength
      if (total > 0) this.set({ progress: Math.min(1, got / total) })
    }
    await fs.writeFile(dest, Buffer.concat(chunks))
  }

  private async verify(file: string, name: string, sumsUrl: string): Promise<void> {
    const res = await fetch(sumsUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (!res.ok) throw new Error(`Could not read SHA256SUMS: HTTP ${res.status}.`)
    const want = parseChecksums(await res.text()).get(name)
    if (!want) throw new Error(`SHA256SUMS has no entry for ${name}.`)
    const have = createHash('sha256')
      .update(await fs.readFile(file))
      .digest('hex')
    if (have !== want) {
      await fs.rm(file, { force: true })
      throw new Error('The download did not match its published checksum; it was deleted.')
    }
  }
}

export const updater = new UpdateService()
