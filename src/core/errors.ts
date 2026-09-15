// The signer's failure type. Thrown anywhere inside an operation, caught once at
// the dispatch boundary and turned into the `{ ok: false, error, detail }` envelope.

export class SignerFailure extends Error {
  readonly detail: string
  constructor(message: string, detail = '') {
    super(message)
    this.name = 'SignerFailure'
    this.detail = detail
  }
}

export function fail(message: string, detail = ''): never {
  throw new SignerFailure(message, detail)
}

export interface FailResult {
  ok: false
  error: string
  detail: string
}

export function toFailResult(e: unknown): FailResult {
  if (e instanceof SignerFailure) return { ok: false, error: e.message, detail: e.detail }
  const msg = e instanceof Error ? e.message : String(e)
  return { ok: false, error: 'The signer hit an unexpected error.', detail: msg }
}
