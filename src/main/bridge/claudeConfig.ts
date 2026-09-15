// Registers the bridge with Claude Code by writing the one entry Claude Code needs
// into its user-level configuration (~/.claude.json, key mcpServers). That file is
// Claude Code's, not ours: read it whole, change only our entry, write it back in
// one atomic step, and never touch it when it cannot be parsed.
import { app } from 'electron'
import { promises as fs, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The name the tools appear under in Claude Code (`psm_status` shows as psm:psm_status). */
export const CLAUDE_SERVER_NAME = 'psm'

export interface ClaudeCodeStatus {
  /** Where Claude Code keeps its user-level settings. */
  path: string
  /** The file exists (Claude Code has run at least once on this PC). */
  configFound: boolean
  /** Our entry is present. */
  installed: boolean
  /** Our entry matches the current endpoint and token. */
  upToDate: boolean
  /** The file exists but is not valid JSON; the app will not touch it. */
  unreadable: boolean
}

interface ServerEntry {
  type: 'http'
  url: string
  headers: { Authorization: string }
}

export function claudeConfigPath(): string {
  return join(app.getPath('home'), '.claude.json')
}

function entryFor(endpoint: string, token: string): ServerEntry {
  return { type: 'http', url: endpoint, headers: { Authorization: `Bearer ${token}` } }
}

function readConfig(): {
  data: Record<string, unknown> | null
  found: boolean
  unreadable: boolean
} {
  const p = claudeConfigPath()
  if (!existsSync(p)) return { data: null, found: false, unreadable: false }
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return { data: null, found: true, unreadable: true }
    return { data: parsed as Record<string, unknown>, found: true, unreadable: false }
  } catch {
    return { data: null, found: true, unreadable: true }
  }
}

export function claudeCodeStatus(endpoint: string, token: string): ClaudeCodeStatus {
  const { data, found, unreadable } = readConfig()
  const servers = (data?.mcpServers ?? {}) as Record<string, Partial<ServerEntry> | undefined>
  const e = servers[CLAUDE_SERVER_NAME]
  const want = entryFor(endpoint, token)
  const installed = !!e
  const upToDate =
    installed &&
    e?.type === want.type &&
    e?.url === want.url &&
    e?.headers?.Authorization === want.headers.Authorization
  return { path: claudeConfigPath(), configFound: found, installed, upToDate, unreadable }
}

async function writeConfig(data: Record<string, unknown>): Promise<void> {
  const p = claudeConfigPath()
  const tmp = p + '.psm-tmp'
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
  await fs.rename(tmp, p)
}

/** Adds or refreshes our entry. Creates the file when Claude Code has never run here. */
export async function addToClaudeCode(
  endpoint: string,
  token: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data, unreadable } = readConfig()
  if (unreadable)
    return {
      ok: false,
      error: `Claude Code's settings file could not be read as JSON; nothing was changed (${claudeConfigPath()}).`
    }
  const cfg = data ?? {}
  const servers = { ...((cfg.mcpServers as Record<string, unknown> | undefined) ?? {}) }
  servers[CLAUDE_SERVER_NAME] = entryFor(endpoint, token)
  await writeConfig({ ...cfg, mcpServers: servers })
  return { ok: true }
}

/** Removes our entry and nothing else. */
export async function removeFromClaudeCode(): Promise<{ ok: true } | { ok: false; error: string }> {
  const { data, unreadable, found } = readConfig()
  if (!found || !data) return { ok: true }
  if (unreadable)
    return {
      ok: false,
      error: `Claude Code's settings file could not be read as JSON; nothing was changed (${claudeConfigPath()}).`
    }
  const servers = { ...((data.mcpServers as Record<string, unknown> | undefined) ?? {}) }
  if (!(CLAUDE_SERVER_NAME in servers)) return { ok: true }
  delete servers[CLAUDE_SERVER_NAME]
  await writeConfig({ ...data, mcpServers: servers })
  return { ok: true }
}
