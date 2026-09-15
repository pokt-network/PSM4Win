// Structured app log with redaction at the sink (CLAUDE.md, security model).
// One JSON object per line in app.log. Never receives env blocks or secrets on
// purpose; the redaction filter is the last line of defence, not the first.
import { appendFile } from 'node:fs/promises'
import { redact, redactDeep } from '@core/redact'
import { ensureDirSync } from './files'
import { dirname } from 'node:path'

type Level = 'debug' | 'info' | 'warn' | 'error'

let logPath: string | null = null
let echo = false
let queue: Promise<void> = Promise.resolve()

export function initLog(path: string, echoToConsole = false): void {
  ensureDirSync(dirname(path))
  logPath = path
  echo = echoToConsole
}

function write(level: Level, msg: string, fields?: Record<string, unknown>): void {
  const entry = {
    time: new Date().toISOString(),
    level,
    msg: redact(msg),
    ...(fields ? redactDeep(fields) : {})
  }
  const line = JSON.stringify(entry)
  if (echo) {
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
    fn(line)
  }
  if (!logPath) return
  const p = logPath
  queue = queue.then(() => appendFile(p, line + '\n', 'utf8')).catch(() => undefined)
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>): void => write('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>): void => write('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>): void => write('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>): void => write('error', msg, fields),
  flush: (): Promise<void> => queue
}
