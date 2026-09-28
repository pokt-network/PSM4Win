// A new service needs a provisioned server first (Register preflight, the bridge's
// psm_register_service, psm_status next_step, and the Dashboard notice share this rule).
import { describe, it, expect } from 'vitest'
import { hasProvisionedStack } from '@core/stack'
import { serverFirstNote, bridgeTool } from '@core/bridge'

describe('server first', () => {
  const ready = { suppliers: { beta: { provisioned_at: '2026-09-27T00:00:00Z' } } }
  const pending = { suppliers: { main: { provisioned_at: undefined } } }

  it('counts only a finished stack on the network asked about', () => {
    expect(hasProvisionedStack([], 'beta')).toBe(false)
    expect(hasProvisionedStack([{}], 'beta')).toBe(false)
    expect(hasProvisionedStack([ready], 'beta')).toBe(true)
    expect(hasProvisionedStack([ready], 'main')).toBe(false)
    expect(hasProvisionedStack([pending], 'main')).toBe(false)
    expect(hasProvisionedStack([pending, ready], 'beta')).toBe(true)
  })

  it('tells an assistant to use the app, never the command line', () => {
    const note = serverFirstNote('main')
    expect(note).toContain('MainNet')
    expect(note).toContain('Settings, Servers')
    expect(note).toMatch(/Never provision a server, create an operator key, or stake a supplier/)
    expect(serverFirstNote('beta')).toContain('Beta TestNet')
  })

  it('is stated where an assistant looks', () => {
    expect(bridgeTool('psm_status')!.description).toContain('next_step')
    expect(bridgeTool('psm_register_service')!.description).toContain(
      'refused until a server is provisioned'
    )
  })
})
