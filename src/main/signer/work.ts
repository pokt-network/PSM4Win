// Per-call scratch directories under <data>/work, mounted read-only into containers.
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { dataFiles } from '../paths'
import { ensureDir, removeDir } from '../state/files'

export async function newWorkDir(): Promise<string> {
  const dir = join(dataFiles.work(), randomBytes(6).toString('hex'))
  await ensureDir(dir)
  return dir
}

export async function removeWorkDir(dir: string | null | undefined): Promise<void> {
  if (dir) await removeDir(dir)
}

/** Runs `fn` with a fresh work directory and removes it afterwards, success or not. */
export async function withWorkDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await newWorkDir()
  try {
    return await fn(dir)
  } finally {
    await removeWorkDir(dir)
  }
}

/** Clears scratch folders on start. */
export async function clearScratch(): Promise<void> {
  await removeDir(dataFiles.work())
  await removeDir(dataFiles.runs())
  await ensureDir(dataFiles.work())
}
