import { describe, it, expect } from 'vitest'
import {
  quoteArgWindows,
  shQuote,
  renderCommand,
  stripBom,
  firstLine,
  renderTemplate,
  toLf,
  serviceFolderName
} from '@core/text'

describe('quoting (contract 6.3)', () => {
  it('Windows quoting matches Quote-Arg', () => {
    expect(quoteArgWindows('plain')).toBe('plain')
    expect(quoteArgWindows('')).toBe('""')
    expect(quoteArgWindows('has space')).toBe('"has space"')
    expect(quoteArgWindows('say "hi"')).toBe('"say \\"hi\\""')
    expect(quoteArgWindows('back\\"slash')).toBe('"back\\\\\\"slash"')
  })
  it('POSIX single quoting matches Sh-Quote', () => {
    expect(shQuote('service-manager')).toBe("'service-manager'")
    expect(shQuote("it's")).toBe("'it'\\''s'")
  })
  it('renders a dry-run command like the HTA', () => {
    expect(renderCommand('pocketd', ['tx', 'service', 'add-service', 'x', 'My Service', '7'])).toBe(
      'pocketd tx service add-service x "My Service" 7'
    )
  })
})

describe('text helpers', () => {
  it('strips a BOM and reads first lines', () => {
    expect(stripBom('﻿{"a":1}')).toBe('{"a":1}')
    expect(firstLine('\r\n  first\r\nsecond')).toBe('first')
    expect(firstLine(null)).toBe('')
  })
  it('renders templates and normalises line endings', () => {
    expect(renderTemplate('a {{X}} b {{X}} {{Y}}', { '{{X}}': '1' })).toBe('a 1 b 1 {{Y}}')
    expect(toLf('a\r\nb\r\n')).toBe('a\nb\n')
  })
})

describe('serviceFolderName', () => {
  const root = String.raw`Z:\work\services`
  const under = (rest: string): string => `${root}\\${rest}`

  it('accepts a folder one level under the root', () => {
    expect(serviceFolderName(root, under('meme-watch'))).toBe('meme-watch')
    expect(serviceFolderName(root, under('example-charts'))).toBe('example-charts')
  })
  it('tolerates trailing separators, forward slashes and surrounding space', () => {
    expect(serviceFolderName(root, under('meme-watch') + '\\')).toBe('meme-watch')
    expect(serviceFolderName(root, 'Z:/work/services/meme-watch')).toBe('meme-watch')
    expect(serviceFolderName(root + '\\', `  ${under('meme-watch')}  `)).toBe('meme-watch')
  })
  it('matches the root case-insensitively, as Windows does', () => {
    expect(serviceFolderName(root, String.raw`z:\WORK\Services\meme-watch`)).toBe('meme-watch')
  })
  it('refuses the root itself, deeper paths, and anything outside it', () => {
    expect(serviceFolderName(root, root)).toBe('')
    expect(serviceFolderName(root, root + '\\')).toBe('')
    expect(serviceFolderName(root, under('meme-watch') + '\\deploy')).toBe('')
    expect(serviceFolderName(root, String.raw`C:\elsewhere\meme-watch`)).toBe('')
  })
  it('refuses a sibling directory that merely starts with the root name', () => {
    expect(serviceFolderName(root, `${root}-old\\meme-watch`)).toBe('')
  })
  it('refuses empty input', () => {
    expect(serviceFolderName(root, '')).toBe('')
    expect(serviceFolderName('', under('meme-watch'))).toBe('')
  })
})
