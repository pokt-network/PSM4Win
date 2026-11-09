import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { dockerDesktopCandidates } from '../src/core/docker-desktop'

const root = join(__dirname, '..')

describe('packaged resources', () => {
  // 0.1.27 to 0.1.33 shipped without pocket.ico; Electron 45 throws on a missing tray icon,
  // which stopped startup before the bridge, the update check, and the monitors.
  it('ships every file the main process loads from resourcesDir()', () => {
    const yml = readFileSync(join(root, 'electron-builder.yml'), 'utf8')
    const shipped = [...yml.matchAll(/^\s*to:\s*(\S+)\s*$/gm)].map((m) => m[1])
    const used = new Set<string>()
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (p.endsWith('.ts'))
          for (const m of readFileSync(p, 'utf8').matchAll(/join\(resourcesDir\(\),\s*'([^']+)'/g))
            used.add(m[1])
      }
    }
    walk(join(root, 'src', 'main'))
    expect(used.size).toBeGreaterThan(0)
    for (const name of used) {
      expect(shipped, `${name} is loaded but not in extraResources`).toContain(name)
      expect(existsSync(join(root, 'resources', name)), `resources/${name}`).toBe(true)
    }
  })
})

describe('dockerDesktopCandidates', () => {
  it('starts with the all-users install', () => {
    expect(dockerDesktopCandidates({})[0]).toBe(
      'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe'
    )
  })

  it('includes the per-user install', () => {
    const c = dockerDesktopCandidates({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' })
    expect(c).toContain('C:\\Users\\u\\AppData\\Local\\Programs\\DockerDesktop\\Docker Desktop.exe')
  })

  it('derives a custom folder from docker.exe on PATH', () => {
    const c = dockerDesktopCandidates({
      Path: 'C:\\Windows;"D:\\Apps\\Docker Desktop\\resources\\bin\\";C:\\Tools'
    })
    expect(c).toContain('D:\\Apps\\Docker Desktop\\Docker Desktop.exe')
    expect(c).toHaveLength(2)
  })

  it('lists each path once', () => {
    const c = dockerDesktopCandidates({
      ProgramFiles: 'C:\\Program Files',
      PATH: 'C:\\Program Files\\Docker\\Docker\\resources\\bin'
    })
    expect(c).toEqual(['C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe'])
  })
})
