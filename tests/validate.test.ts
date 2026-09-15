import { describe, it, expect } from 'vitest'
import {
  RE,
  requireNetwork,
  validateServiceId,
  validateWalletName,
  normalizeHexKey,
  normalizeMnemonic,
  validateLinuxPath,
  validateHealthPath,
  toInt64
} from '@core/validate'
import { SignerFailure } from '@core/errors'

describe('validation regexes (contract 6.15)', () => {
  it('addresses', () => {
    expect(RE.address.test('pokt1qyqszqgpqyqszqgpqyqszqgpqyqszqgp04723y')).toBe(true)
    expect(RE.address.test('pokt1QYQ')).toBe(false)
    expect(RE.address.test('cosmos1qyqszqgpqyqszqgpqyqszqgpqyqszqgp04723y')).toBe(false)
  })
  it('service ids and names', () => {
    expect(() => validateServiceId('example-charts')).not.toThrow()
    expect(() => validateServiceId('a'.repeat(43))).toThrow(SignerFailure)
    expect(() => validateServiceId('bad id')).toThrow(/Service ID/)
    expect(RE.serviceName.test('Example Charts')).toBe(true)
    expect(RE.serviceName.test('Bad;Name')).toBe(false)
  })
  it('wallet names', () => {
    expect(validateWalletName('app-example-charts')).toBe('app-example-charts')
    expect(() => validateWalletName('Upper')).toThrow(/Wallet name/)
    expect(() => validateWalletName('service-manager')).toThrow(/owner wallet's name/)
  })
  it('hex keys', () => {
    const hex = 'ab'.repeat(32)
    expect(normalizeHexKey(' 0x' + hex + ' ')).toBe(hex)
    expect(() => normalizeHexKey('')).toThrow(/No private key/)
    expect(() => normalizeHexKey('abc')).toThrow(/64 hexadecimal/)
  })
  it('recovery phrases', () => {
    const twelve = Array(12).fill('word').join('  ')
    expect(normalizeMnemonic(' ' + twelve.toUpperCase() + ' ')).toBe(
      Array(12).fill('word').join(' ')
    )
    expect(() => normalizeMnemonic(Array(13).fill('word').join(' '))).toThrow(/this one has 13/)
    expect(() => normalizeMnemonic(Array(12).fill('w0rd').join(' '))).toThrow(/lowercase words/)
  })
  it('networks', () => {
    expect(requireNetwork('beta')).toBe('beta')
    expect(() => requireNetwork('devnet')).toThrow("Unknown network 'devnet'. Use beta or main.")
  })
  it('paths and urls', () => {
    expect(validateLinuxPath('/opt/pocket/supplier', 'x')).toBe('/opt/pocket/supplier')
    expect(() => validateLinuxPath('opt/pocket', 'Stack directory')).toThrow(/absolute Linux path/)
    expect(() => validateLinuxPath("/opt/'; rm -rf /", 'x')).toThrow()
    expect(validateHealthPath('')).toBe('/healthz')
    expect(validateHealthPath(undefined)).toBe('/healthz')
    expect(() => validateHealthPath('healthz')).toThrow(/start with/)
    expect(RE.backendUrl.test('http://example-charts-backend:8080')).toBe(true)
    expect(RE.backendUrl.test('http://x:8080/path')).toBe(false)
    expect(RE.endpointUrl.test('https://services.example.com')).toBe(true)
    expect(RE.endpointUrl.test('http://services.example.com')).toBe(false)
  })
  it('int64 coercion', () => {
    expect(toInt64('59500000000')).toBe(59500000000)
    expect(toInt64(7.9)).toBe(7)
    expect(Number.isNaN(toInt64('x'))).toBe(true)
  })
})
