// history.jsonl: one compact JSON object per line, append-only. Same shape as the HTA.
import { dataFiles } from '../paths'
import { appendLine, readJsonLines } from './files'
import type { HistoryEntry } from '@core/contract'
import { nowIso } from '@core/text'

export async function addHistory(entry: Omit<HistoryEntry, 'time'>): Promise<void> {
  const full: HistoryEntry = { ...entry, time: nowIso() }
  await appendLine(dataFiles.history(), JSON.stringify(full))
}

export async function readHistory(): Promise<HistoryEntry[]> {
  return readJsonLines<HistoryEntry>(dataFiles.history())
}
