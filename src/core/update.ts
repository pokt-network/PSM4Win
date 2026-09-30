// The updater's pure part: version comparison, release parsing, install-kind rules,
// and the download allow-list. The main process (src/main/update) does the fetching,
// hashing, and spawning; the renderer shows the status.

export const UPDATE_REPO = 'pokt-network/PSM4Win'
/** Recent releases, newest first: enough to find a priority release the user has not installed
 *  even when a later, ordinary release came out after it. */
export const RELEASES_API = `https://api.github.com/repos/${UPDATE_REPO}/releases?per_page=30`
export const RELEASES_PAGE = `https://github.com/${UPDATE_REPO}/releases`
/** Downloads are accepted only from the repository's own release assets. */
export const DOWNLOAD_PREFIX = `https://github.com/${UPDATE_REPO}/releases/download/`

/** How the running copy was installed; decides what "install" means. */
export type InstallKind = 'scoop' | 'installer' | 'portable' | 'dev'

export type UpdateState = 'idle' | 'checking' | 'downloading' | 'installing' | 'error'

export interface UpdateStatus {
  current: string
  latest: string | null
  available: boolean
  /** The release page for the latest version. */
  url: string | null
  /** Release notes, plain text, trimmed. */
  notes: string | null
  /**
   * Why an update is a priority, from the newest release above the running version whose
   * notes open with the priority marker; null for an ordinary update.
   */
  priority: string | null
  checkedAt: string | null
  state: UpdateState
  error: string | null
  installKind: InstallKind
  /** Download progress, 0 to 1, while downloading. */
  progress: number | null
  /** After a portable download: where the file went. */
  savedTo: string | null
}

/** "v1.2.3" or "1.2.3" to [1, 2, 3]; null when it is not a plain semver. */
export function parseVersion(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(v.trim())
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

/**
 * What changed up to a version: CHANGELOG.md as tagged for that release, opened at the
 * version's own heading (GitHub drops the dots from "## 0.1.9", giving #019). The file
 * is newest first, so every version since the user's own is on the page from there down.
 * A version that is not plain semver gets the releases page instead.
 */
export function changesUrl(version: string | null | undefined): string {
  const p = parseVersion(String(version ?? ''))
  if (!p) return RELEASES_PAGE
  const v = p.join('.')
  return `https://github.com/${UPDATE_REPO}/blob/v${v}/CHANGELOG.md#${p.join('')}`
}

/** -1, 0, or 1 for a < b, a == b, a > b. Unparseable versions compare as older. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa && !pb) return 0
  if (!pa) return -1
  if (!pb) return 1
  for (let i = 0; i < 3; i++) {
    if (pa[i] < pb[i]) return -1
    if (pa[i] > pb[i]) return 1
  }
  return 0
}

export interface ReleaseAsset {
  name: string
  browser_download_url: string
}
export interface ReleaseInfo {
  tag_name: string
  html_url: string
  body?: string | null
  draft?: boolean
  prerelease?: boolean
  assets?: ReleaseAsset[]
}

/** The assets the updater needs for a version: the installer, the portable zip, the checksums. */
export function pickReleaseAssets(
  rel: ReleaseInfo,
  version: string
): { setup: ReleaseAsset | null; zip: ReleaseAsset | null; sums: ReleaseAsset | null } {
  const assets = rel.assets ?? []
  const find = (name: string): ReleaseAsset | null => {
    const a = assets.find((x) => x.name === name)
    return a && a.browser_download_url.startsWith(DOWNLOAD_PREFIX) ? a : null
  }
  return {
    setup: find(`PocketServiceManager-Setup-${version}.exe`),
    zip: find(`PocketServiceManager-${version}-win-x64.zip`),
    sums: find('SHA256SUMS')
  }
}

/** Reads a SHA256SUMS file (hex, two spaces, file name) into a map by file name. */
export function parseChecksums(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line)
    if (m) out.set(m[2], m[1].toLowerCase())
  }
  return out
}

/** The app's name in the Scoop bucket (bucket/pocket-service-manager.json). */
export const SCOOP_APP = 'pocket-service-manager'

/**
 * How this copy was installed. A Scoop install lives under `...\scoop\apps\...`, or, when
 * Scoop was put in a folder of another name, under `apps\pocket-service-manager\current`
 * (or a version folder); the NSIS installer leaves an uninstaller next to the executable;
 * anything else packaged is the portable zip; an unpackaged run is a development build.
 */
export function detectInstallKind(
  execPath: string,
  packaged: boolean,
  hasUninstaller: boolean
): InstallKind {
  if (!packaged) return 'dev'
  if (/[\\/]scoop[\\/]apps[\\/]/i.test(execPath)) return 'scoop'
  if (/[\\/]apps[\\/]pocket-service-manager[\\/](current|\d[^\\/]*)[\\/]/i.test(execPath))
    return 'scoop'
  if (hasUninstaller) return 'installer'
  return 'portable'
}

/**
 * The command line, for `cmd.exe /c`, that opens a console window running the user's Scoop
 * updater. It must reach cmd exactly as written (spawn with windowsVerbatimArguments):
 * Node's own quoting turns the window title's quotes into \" sequences, which cmd does not
 * understand, so `start` took the title for a program named "Pocket" and nothing ran (every
 * in-app Scoop update up to 0.1.19). The inner cmd waits about two seconds for the app to
 * finish quitting, refreshes Scoop and its buckets, updates the app, and stays open so the
 * user can read the result. No quote may
 * appear inside the /k string: cmd strips only its first and last one.
 */
export function scoopUpdateCommandLine(app = SCOOP_APP): string {
  if (!/^[a-z0-9-]+$/.test(app)) throw new Error('not a Scoop app name')
  const inner = [
    'ping -n 3 127.0.0.1 >nul',
    // Scoop refreshes its buckets before an app update only when its last refresh is hours
    // old; otherwise it reports the installed version as the latest. Refresh first.
    'scoop update',
    `scoop update ${app}`,
    'echo.',
    'echo When it says the update finished, close this window and open Pocket Service Manager again.'
  ].join(' & ')
  return `start "Pocket Service Manager update" cmd.exe /k "${inner}"`
}

/** Release notes as plain text for the dialog: no markdown headings or links, bounded length. */
/**
 * A priority release opens its CHANGELOG section, and so its release notes, with the
 * line `**Priority update.** <why, in one sentence>` (docs/PACKAGING.md). Returns the
 * reason, or null for an ordinary release.
 */
export const PRIORITY_MARKER = '**Priority update.**'
export function priorityReason(body: string | null | undefined): string | null {
  const m = /^\s*\*\*Priority update\.\*\*\s*(.+)$/m.exec(String(body ?? '').replace(/\r/g, ''))
  return m ? m[1].trim() || 'This update fixes a problem that needs to be fixed now.' : null
}

export interface ReleaseSummary {
  /** The newest published release, or null when there is none. */
  release: ReleaseInfo | null
  latest: string | null
  /** The reason from the newest priority release above `current`, or null. */
  priority: string | null
}

/**
 * The newest published release (drafts, prereleases and unparsable tags ignored), and
 * whether any release above the running version was a priority. The newest release
 * alone is not enough: a priority 0.1.11 followed by an ordinary 0.1.12 must still
 * read as a priority for someone on 0.1.10.
 */
export function summarizeReleases(list: ReleaseInfo[], current: string): ReleaseSummary {
  const usable = list
    .filter((r) => !r.draft && !r.prerelease && parseVersion(r.tag_name))
    .sort((a, b) => compareVersions(b.tag_name, a.tag_name))
  const release = usable[0] ?? null
  const newer = usable.filter((r) => compareVersions(r.tag_name, current) > 0)
  let priority: string | null = null
  for (const r of newer) {
    priority = priorityReason(r.body)
    if (priority) break
  }
  return {
    release,
    latest: release ? parseVersion(release.tag_name)!.join('.') : null,
    priority
  }
}

export function plainNotes(body: string | null | undefined, max = 800): string | null {
  if (!body) return null
  const t = body
    .replace(/\r/g, '')
    .replace(/^#+\s*/gm, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '')
    .trim()
  if (!t) return null
  return t.length > max ? t.slice(0, max).trimEnd() + '…' : t
}
