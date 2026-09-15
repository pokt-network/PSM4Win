import { describe, it, expect } from 'vitest'
import {
  quoteArgWindows,
  shQuote,
  renderCommand,
  stripBom,
  firstLine,
  renderTemplate,
  toLf
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
