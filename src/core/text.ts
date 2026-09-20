// Small text helpers shared by main and renderer.

/** Removes a leading UTF-8 byte-order mark (the HTA's PowerShell wrote one). */
export function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s
}

export function firstLine(s: string | undefined | null): string {
  if (!s) return ''
  return s.trim().split(/\r?\n/)[0] ?? ''
}

export function toLf(s: string): string {
  return s.replace(/\r\n/g, '\n')
}

export function nonEmptyLines(s: string): string[] {
  return s.split(/\r?\n/).filter((l) => l.trim() !== '')
}

/** Windows argument quoting, used only to render dry-run command strings for display. */
export function quoteArgWindows(a: string): string {
  if (a === '' || /[\s"]/.test(a)) return '"' + a.replace(/(\\*)"/g, '$1$1\\"') + '"'
  return a
}

/** Single-quotes a value for the POSIX shell inside a container. */
export function shQuote(a: string): string {
  return "'" + a.replace(/'/g, "'\\''") + "'"
}

export function renderCommand(exe: string, args: readonly string[]): string {
  return [exe, ...args.map(quoteArgWindows)].join(' ')
}

export function nowIso(): string {
  return new Date().toISOString()
}

export function tail(s: string, n: number): string {
  return s.length > n ? s.slice(s.length - n) : s
}

export function head(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s
}

/** Replaces {{TOKEN}} placeholders; tokens not in the map are left as they are. */
export function renderTemplate(text: string, tokens: Record<string, string>): string {
  let out = text
  for (const [k, v] of Object.entries(tokens)) out = out.split(k).join(v)
  return out
}

/**
 * The folder name of a service, given the services root and an absolute path
 * chosen in a folder picker.
 *
 * The app addresses a service by its folder name under the services root, so a
 * picked path counts only when it sits exactly one level below that root.
 * Returns '' for the root itself, for anything deeper, for a path outside the
 * root, and for a sibling directory whose name merely starts with the root's.
 * Separator-agnostic and case-insensitive, because Windows pickers return
 * either separator and any casing.
 */
export function serviceFolderName(root: string, picked: string): string {
  const SEP = '\\'
  const norm = (s: string): string =>
    String(s ?? '')
      .trim()
      .replace(/[\\/]+/g, SEP)
      .replace(/\\+$/, '')
  const r = norm(root)
  const p = norm(picked)
  if (!r || !p) return ''
  if (p.length <= r.length + 1) return ''
  if (p.slice(0, r.length).toLowerCase() !== r.toLowerCase()) return ''
  if (p.charAt(r.length) !== SEP) return ''
  const rest = p.slice(r.length + 1)
  return rest.includes(SEP) ? '' : rest
}
