// Parsing and cleaning of pocketd output (SIGNER-CONTRACT.md sections 6.4 and 6.5).
// Pure functions so they can be unit-tested without Docker.
import { tail } from './text'

export interface NativeOutput {
  code: number
  out: string
  err: string
}

/** Keeps only the lines a person can act on from pocketd's stderr. */
export function cleanErr(err: string | undefined | null): string {
  if (!err) return ''
  const keep: string[] = []
  let inUsage = false
  for (const raw of err.split(/\r?\n/)) {
    const l = raw.replace(/\s+$/, '')
    const t = l.trim()
    if (t === '') continue
    if (/^(Usage:|Flags:|Global Flags:|Examples?:)/.test(t)) {
      inUsage = true
      continue
    }
    if (inUsage && (/^(-{1,2}[A-Za-z]|pocketd |\$ )/.test(t) || /^\s{2,}/.test(l))) continue
    inUsage = false
    if (/\.go:\d+$/.test(t)) continue
    if (
      /^(github\.com\/|net\/http|reflect\.|runtime\.|main\.|golang\.org|google\.golang\.org|created by )/.test(
        t
      )
    )
      continue
    keep.push(l)
  }
  return tail(keep.join('\n').trim(), 3000)
}

/** One friendly sentence for the most common pocketd failures. */
export function summarizeErr(err: string | undefined | null): string {
  const clean = cleanErr(err)
  let m: RegExpMatchArray | null
  if ((m = clean.match(/(card does not match the service card schema:[\s\S]*?)(\n\s*Re-run|$)/)))
    return m[1].trim()
  if ((m = clean.match(/code = NotFound[\s\S]*?account (pokt1[0-9a-z]+) not found/)))
    return `The account ${m[1]} does not exist on this network yet. It is created by its first deposit, so send it some POKT first.`
  if (/insufficient funds/.test(clean))
    return 'The wallet does not hold enough POKT for this transaction plus gas.'
  if (/account sequence mismatch/.test(clean))
    return 'Another transaction from this wallet is still pending. Wait a block and try again.'
  if (/out of gas/.test(clean))
    return 'The transaction ran out of gas. Try again; the gas simulation was too low.'
  if (/too many failed passphrase attempts/.test(clean))
    return 'The keyring did not accept the sealed passphrase. If this persists, revoke and import the wallet again.'
  if (/duplicated address created/.test(clean))
    return 'A key with this address is already in the keyring under another name.'
  if (/invalid mnemonic/.test(clean))
    return 'That is not a valid recovery phrase. Check the words and their order.'
  const lines = clean.split('\n').filter((l) => l.trim() !== '')
  if (lines.length === 0) return 'pocketd failed without a message.'
  let last = lines[lines.length - 1].trim()
  const rpc = last.match(/^rpc error: code = \w+ desc = (.*)$/)
  if (rpc) last = rpc[1].trim()
  return last
}

/** The first JSON object in stdout, then stderr (keys add prints on either). */
export function parseFirstJson(r: NativeOutput): Record<string, unknown> | null {
  for (const txt of [r.out ?? '', r.err ?? '']) {
    const i = txt.indexOf('{')
    if (i >= 0) {
      try {
        const v = JSON.parse(txt.slice(i))
        if (v && typeof v === 'object') return v as Record<string, unknown>
      } catch {
        /* try the next stream */
      }
    }
  }
  return null
}

export interface ParsedTx {
  json: Record<string, unknown> | null
  gas: string
}

/** stdout as JSON, else from the first `{`; gas from stderr `gas estimate: N`. */
export function parseTxOutput(r: NativeOutput): ParsedTx {
  let json: Record<string, unknown> | null = null
  const txt = (r.out ?? '').trim()
  if (txt) {
    try {
      json = JSON.parse(txt)
    } catch {
      const i = txt.indexOf('{')
      if (i >= 0) {
        try {
          json = JSON.parse(txt.slice(i))
        } catch {
          json = null
        }
      }
    }
  }
  const m = (r.err ?? '').match(/gas estimate:\s*(\d+)/)
  return { json: json && typeof json === 'object' ? json : null, gas: m ? m[1] : '' }
}

/** Operator address from supplier.sh output. */
export function operatorFromOutput(out: string): string {
  const m = out.match(/operator:\s*(pokt1[0-9a-z]{38})/)
  return m ? m[1] : ''
}

/** The last `error: ...` line from supplier.sh output, or ''. */
export function lastErrorLine(lines: string[]): string {
  let err = ''
  for (const l of lines) {
    const m = l.match(/^error:\s*(.*)$/)
    if (m) err = m[1]
  }
  return err
}

/** HTTP status pocket-ap reported, or 0. */
export function upstreamHttp(diagnostics: string): number {
  const m = diagnostics.match(/upstream returned HTTP (\d{3})/)
  return m ? Number(m[1]) : 0
}
