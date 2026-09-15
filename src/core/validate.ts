// Input validation shared by the signer and the renderer's preflights. These
// regexes are part of the injection defence (SIGNER-CONTRACT.md section 6.3):
// values that pass them are later single-quoted into remote commands without
// further escaping, so keep them exactly as the HTA had them.
import { fail } from './errors'
import { OWNER_KEY_NAME } from './versions'
import { isNetwork, type Network } from './networks'

export const RE = {
  address: /^pokt1[0-9a-z]{38}$/,
  serviceId: /^[A-Za-z0-9_-]{1,42}$/,
  serviceName: /^[A-Za-z0-9 _-]{1,169}$/,
  walletName: /^[a-z0-9][a-z0-9_-]{0,39}$/,
  hexKey: /^[0-9a-fA-F]{64}$/,
  linuxPath: /^\/[A-Za-z0-9._/-]+$/,
  healthPath: /^\/[A-Za-z0-9._/-]*$/,
  backendUrl: /^http:\/\/[A-Za-z0-9._-]+:[0-9]{2,5}$/,
  endpointUrl: /^https:\/\/[^\s]+$/,
  hostname: /^[A-Za-z0-9.-]+$/,
  sshUser: /^[A-Za-z0-9._-]+$/,
  project: /^[a-z0-9][a-z0-9-]{0,40}$/,
  keyName: /^[A-Za-z0-9._-]+$/,
  relayPath: /^\/[^\s]*$/,
  passphrase: /^[A-Za-z0-9+/]{43}=$/
} as const

export const RPC_TYPES = ['REST', 'JSON_RPC', 'WEBSOCKET', 'GRPC', 'COMET_BFT'] as const
export type RpcType = (typeof RPC_TYPES)[number]

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'PATCH'] as const
export type HttpMethod = (typeof HTTP_METHODS)[number]

export const MAX_CUPR = 1_048_576
export const MAX_CARD_BYTES = 262_144

export function requireNetwork(n: unknown): Network {
  const s = String(n ?? '')
  if (!isNetwork(s)) fail(`Unknown network '${s}'. Use beta or main.`)
  return s
}

export function validateServiceId(id: string): string {
  if (!RE.serviceId.test(id))
    fail('Service ID must be 1 to 42 characters of letters, digits, hyphen, or underscore.')
  return id
}

export function validateWalletName(name: string): string {
  if (!RE.walletName.test(name))
    fail('Wallet name must be 1 to 40 characters: lowercase letters, digits, hyphen, underscore.')
  if (name === OWNER_KEY_NAME) fail(`'${OWNER_KEY_NAME}' is the owner wallet's name.`)
  return name
}

export function validateAddress(addr: string, what = 'Address'): string {
  if (!RE.address.test(addr)) fail(`${what} is not a valid pokt1 address.`)
  return addr
}

/** Trims, strips an optional 0x, and checks the 64-hex shape. Returns the bare hex. */
export function normalizeHexKey(input: string): string {
  let hex = (input ?? '').trim()
  if (!hex) fail('No private key was provided.')
  if (/^0[xX]/.test(hex)) hex = hex.slice(2)
  if (!RE.hexKey.test(hex))
    fail(
      'The private key must be 64 hexadecimal characters (32 bytes), optionally prefixed with 0x.'
    )
  return hex
}

export function normalizeMnemonic(input: string): string {
  const phrase = (input ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
  if (!phrase) fail('No recovery phrase was provided.')
  const n = phrase.split(' ').length
  if (![12, 15, 18, 21, 24].includes(n))
    fail(`A recovery phrase has 12 or 24 words; this one has ${n}.`)
  if (!/^[a-z ]+$/.test(phrase))
    fail('A recovery phrase contains only lowercase words separated by spaces.')
  return phrase
}

export function validateLinuxPath(p: string, what: string): string {
  if (!RE.linuxPath.test(p)) fail(`${what} must be an absolute Linux path.`)
  return p
}

export function validateHealthPath(hp: string | undefined): string {
  const v = hp && hp !== '' ? hp : '/healthz'
  if (!RE.healthPath.test(v)) fail('Health path must start with /.')
  return v
}

export function toInt64(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v)
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return Number(v.trim())
  if (typeof v === 'bigint') return Number(v)
  return NaN
}
