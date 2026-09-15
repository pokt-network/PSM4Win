// Redaction applied at the log sink (CLAUDE.md, security model). Anything that
// looks like a hex key, a sealed or plain passphrase, or a recovery phrase is
// replaced before the line is written. The renderer never sees the log.

const HEX_KEY = /\b[0-9a-fA-F]{64}\b/g
// 44-character base64 with a trailing '=': the shape of the keyring passphrase.
const PASSPHRASE = /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{43}=(?![A-Za-z0-9+/=])/g
// Long hex blobs (a DPAPI seal is hundreds of hex chars).
const LONG_HEX = /\b[0-9a-fA-F]{128,}\b/g
// Twelve or more lowercase words in a row: a recovery phrase.
const PHRASE = /\b(?:[a-z]{3,8}\s+){11,23}[a-z]{3,8}\b/g
// Environment variables that carry secrets, if they ever reach a message.
const ENV =
  /\b(PSM_STDIN|PSM_IMPORT_KEY|PSM_IMPORT_MNEMONIC|POCKET_APP_PRIVATE_KEY|PSM_SEALED)=\S+/g

export function redact(text: string): string {
  if (!text) return text
  return text
    .replace(ENV, '$1=[redacted]')
    .replace(LONG_HEX, '[redacted-blob]')
    .replace(HEX_KEY, '[redacted-hex]')
    .replace(PASSPHRASE, '[redacted]')
    .replace(PHRASE, '[redacted-phrase]')
}

/** Redacts every string inside a JSON-able value, recursively. */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as unknown as T
  if (Array.isArray(value)) return value.map(redactDeep) as unknown as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (
        /^(privateKeyHex|mnemonic|hex|env|PSM_STDIN|PSM_IMPORT_KEY|PSM_IMPORT_MNEMONIC|POCKET_APP_PRIVATE_KEY)$/.test(
          k
        )
      )
        out[k] = '[redacted]'
      else out[k] = redactDeep(v)
    }
    return out as T
  }
  return value
}
