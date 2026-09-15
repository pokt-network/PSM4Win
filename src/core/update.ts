// The updater's pure part: version comparison, release parsing, install-kind rules,
// and the download allow-list. The main process (src/main/update) does the fetching,
// hashing, and spawning; the renderer shows the status.

export const UPDATE_REPO = 'pokt-network/PSM4Win'
export const RELEASES_API = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`
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

/**
 * How this copy was installed. A Scoop install lives under `...\scoop\apps\...`; the NSIS
 * installer leaves an uninstaller next to the executable; anything else packaged is the
 * portable zip; an unpackaged run is a development build.
 */
export function detectInstallKind(
  execPath: string,
  packaged: boolean,
  hasUninstaller: boolean
): InstallKind {
  if (!packaged) return 'dev'
  if (/[\\/]scoop[\\/]apps[\\/]/i.test(execPath)) return 'scoop'
  if (hasUninstaller) return 'installer'
  return 'portable'
}

/** Release notes as plain text for the dialog: no markdown headings or links, bounded length. */
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
