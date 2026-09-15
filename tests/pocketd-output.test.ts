import { describe, it, expect } from 'vitest'
import {
  cleanErr,
  summarizeErr,
  parseFirstJson,
  parseTxOutput,
  operatorFromOutput,
  lastErrorLine,
  upstreamHttp
} from '@core/pocketd-output'

describe('Clean-Err port', () => {
  it('drops usage blocks, go frames, and file references', () => {
    const err = [
      'Error: something went wrong',
      'Usage:',
      '  pocketd tx service add-service [flags]',
      'Flags:',
      '  -h, --help   help',
      '  --card-file string',
      'github.com/pokt-network/poktroll/x/service.(*Keeper).Foo',
      '\t/go/src/x/y.go:123',
      'runtime.goexit',
      'real message'
    ].join('\n')
    expect(cleanErr(err)).toBe('Error: something went wrong\nreal message')
  })
  it('keeps the last 3000 characters', () => {
    expect(cleanErr('x'.repeat(5000)).length).toBe(3000)
  })
})

describe('Summarize-Err port', () => {
  it('maps known failures', () => {
    expect(summarizeErr('rpc error: code = NotFound desc = account pokt1abc not found')).toMatch(
      /does not exist on this network yet/
    )
    expect(summarizeErr('... insufficient funds ...')).toMatch(/not hold enough POKT/)
    expect(summarizeErr('account sequence mismatch')).toMatch(/still pending/)
    expect(summarizeErr('out of gas')).toMatch(/ran out of gas/)
    expect(summarizeErr('too many failed passphrase attempts')).toMatch(/sealed passphrase/)
    expect(summarizeErr('duplicated address created')).toMatch(/already in the keyring/)
    expect(summarizeErr('invalid mnemonic')).toMatch(/not a valid recovery phrase/)
    expect(summarizeErr('card does not match the service card schema: field x\nRe-run with')).toBe(
      'card does not match the service card schema: field x'
    )
  })
  it('falls back to the last line and strips rpc prefixes', () => {
    expect(summarizeErr('first\nrpc error: code = InvalidArgument desc = bad thing')).toBe(
      'bad thing'
    )
    expect(summarizeErr('')).toBe('pocketd failed without a message.')
  })
})

describe('output parsing (contract 6.4)', () => {
  it('finds the first JSON object on either stream', () => {
    expect(
      parseFirstJson({ code: 0, out: 'noise\n{"address":"pokt1x","mnemonic":"a b"}', err: '' })
    ).toEqual({ address: 'pokt1x', mnemonic: 'a b' })
    expect(parseFirstJson({ code: 0, out: '', err: 'warn {"address":"pokt1y"}' })).toEqual({
      address: 'pokt1y'
    })
    expect(parseFirstJson({ code: 0, out: 'nothing', err: '' })).toBeNull()
  })
  it('parses tx output with log noise and gas from stderr', () => {
    const r = parseTxOutput({
      code: 0,
      out: 'log line\n{"txhash":"ABC","code":0,"raw_log":""}',
      err: 'gas estimate: 123456\n'
    })
    expect(r.json?.txhash).toBe('ABC')
    expect(r.gas).toBe('123456')
    expect(parseTxOutput({ code: 1, out: '', err: 'boom' }).json).toBeNull()
  })
  it('reads supplier.sh output', () => {
    const out =
      'created: new operator key\noperator: pokt1qgpqyqszqgpqyqszqgpqyqszqgpqyqsz73c06j\nerror: first\nerror: last one'
    expect(operatorFromOutput(out)).toBe('pokt1qgpqyqszqgpqyqszqgpqyqszqgpqyqsz73c06j')
    expect(lastErrorLine(out.split('\n'))).toBe('last one')
    expect(upstreamHttp('... upstream returned HTTP 404 ...')).toBe(404)
    expect(upstreamHttp('nothing')).toBe(0)
  })
})
