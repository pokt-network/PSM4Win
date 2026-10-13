import { describe, it, expect } from 'vitest'
import { settingsPatchSchema } from '../src/main/ipc/schemas'

// 0.1.28 wrote the stack's RelayMiner into settings with a pattern that had lost its
// backslashes, so every save after Update stack was refused and the servers vanished from
// the window. The stack entry Provision writes must pass the settings check.
const server = (relayminer?: string): unknown => ({
  servers: [
    {
      name: 'example-host',
      host: '203.0.113.10',
      port: 22,
      user: 'REPLACE-user',
      keyPath: 'C:\\Users\\REPLACE-user\\.ssh\\id_supplier',
      deployRoot: '/opt/pocket/services',
      suppliers: {
        main: {
          dir: '/opt/pocket/supplier-main',
          project: 'pocket-supplier-main',
          url: 'https://services.example.org',
          operator: 'pokt1qexampleoperator',
          provisioned_at: '2026-10-13T00:00:00.000Z',
          layout: 5,
          ...(relayminer === undefined ? {} : { relayminer })
        }
      }
    }
  ]
})

describe('settings check: stack entries', () => {
  it('accepts the entry Provision writes, with and without the RelayMiner', () => {
    expect(settingsPatchSchema.safeParse(server('v0.1.3')).success).toBe(true)
    expect(settingsPatchSchema.safeParse(server('v12.34.567')).success).toBe(true)
    expect(settingsPatchSchema.safeParse(server()).success).toBe(true)
  })
  it('refuses a RelayMiner that is not a plain release tag', () => {
    for (const v of ['vd1.d2.d3', '0.1.3', 'v0.1.3-rc.1', 'latest', 'v0.1.3\nX=1'])
      expect(settingsPatchSchema.safeParse(server(v)).success).toBe(false)
  })
})
