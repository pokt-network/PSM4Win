// Where Docker Desktop's launcher may be (docker-start). Pure: the caller passes the
// environment and checks which candidate exists.
import { DOCKER_DESKTOP_EXE } from './versions'

const LAUNCHER = 'Docker Desktop.exe'

function winJoin(...parts: string[]): string {
  return parts
    .map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, '') : p.replace(/^[\\/]+|[\\/]+$/g, '')))
    .filter(Boolean)
    .join('\\')
}

/**
 * Candidate launcher paths, most likely first: the all-users install, the per-user install
 * (%LOCALAPPDATA%\Programs\DockerDesktop), and the folder of a `docker.exe` on PATH that
 * Docker Desktop put there (<install>\resources\bin\docker.exe), which covers a custom
 * installation folder.
 */
export function dockerDesktopCandidates(env: Record<string, string | undefined>): string[] {
  const out: string[] = [DOCKER_DESKTOP_EXE]
  const pf = env.ProgramFiles ?? env.PROGRAMFILES
  if (pf) out.push(winJoin(pf, 'Docker', 'Docker', LAUNCHER))
  const local = env.LOCALAPPDATA
  if (local) {
    out.push(winJoin(local, 'Programs', 'DockerDesktop', LAUNCHER))
    out.push(winJoin(local, 'Programs', 'Docker', 'Docker', LAUNCHER))
  }
  const path = env.Path ?? env.PATH ?? ''
  for (const dir of path.split(';')) {
    const d = dir.trim().replace(/^"|"$/g, '').replace(/[\\/]+$/, '')
    const m = /^(.*)[\\/]resources[\\/]bin$/i.exec(d)
    if (m && m[1]) out.push(winJoin(m[1], LAUNCHER))
  }
  const seen = new Set<string>()
  return out.filter((p) => {
    const k = p.toLowerCase()
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}
