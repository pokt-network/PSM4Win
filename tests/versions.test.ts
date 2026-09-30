import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { ELECTRON_VERSION } from '@core/versions'

describe('pinned versions', () => {
  it('package.json pins exactly the Electron version recorded in versions.ts', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
    expect(pkg.devDependencies.electron).toBe(ELECTRON_VERSION)
    const installed = JSON.parse(readFileSync('node_modules/electron/package.json', 'utf8'))
    expect(installed.version).toBe(ELECTRON_VERSION)
  })
})
