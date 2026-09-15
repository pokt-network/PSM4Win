// File helpers for the app data folder. JSON is read BOM-tolerant (the HTA's
// PowerShell wrote a BOM) and written without one, UTF-8, LF.
import { promises as fs, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { stripBom } from '@core/text'

export function ensureDirSync(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
}

export function exists(p: string): boolean {
  return existsSync(p)
}

export async function readText(p: string): Promise<string | null> {
  try {
    return stripBom(await fs.readFile(p, 'utf8'))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

export async function readJson<T>(p: string): Promise<T | null> {
  const t = await readText(p)
  if (t === null) return null
  try {
    return JSON.parse(t) as T
  } catch {
    return null
  }
}

export async function writeText(p: string, text: string): Promise<void> {
  await ensureDir(dirname(p))
  await fs.writeFile(p, text, { encoding: 'utf8' })
}

export async function writeJson(p: string, value: unknown): Promise<void> {
  await writeText(p, JSON.stringify(value, null, 2) + '\n')
}

export async function appendLine(p: string, line: string): Promise<void> {
  await ensureDir(dirname(p))
  await fs.appendFile(p, line + '\n', { encoding: 'utf8' })
}

export async function removeFile(p: string): Promise<void> {
  await fs.rm(p, { force: true })
}

export async function removeDir(p: string): Promise<void> {
  await fs.rm(p, { recursive: true, force: true })
}

export async function fileSize(p: string): Promise<number> {
  return (await fs.stat(p)).size
}

/** Reads a JSON-lines file, skipping blank and unparseable lines. */
export async function readJsonLines<T>(p: string): Promise<T[]> {
  const t = await readText(p)
  if (t === null) return []
  const out: T[] = []
  for (const line of t.split(/\r?\n/)) {
    const s = stripBom(line).trim()
    if (!s) continue
    try {
      out.push(JSON.parse(s) as T)
    } catch {
      /* skip */
    }
  }
  return out
}
