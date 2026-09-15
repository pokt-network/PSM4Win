import { describe, it, expect } from 'vitest'
import {
  compareVersions,
  parseVersion,
  pickReleaseAssets,
  parseChecksums,
  detectInstallKind,
  plainNotes,
  DOWNLOAD_PREFIX
} from '../src/core/update'

describe('updater: versions', () => {
  it('parses plain and v-prefixed semver, rejects the rest', () => {
    expect(parseVersion('v0.1.0')).toEqual([0, 1, 0])
    expect(parseVersion('1.2.3')).toEqual([1, 2, 3])
    expect(parseVersion('v1.2.3-beta.1')).toEqual([1, 2, 3])
    expect(parseVersion('latest')).toBeNull()
    expect(parseVersion('1.2')).toBeNull()
  })
  it('compares numerically, not lexically', () => {
    expect(compareVersions('0.1.0', 'v0.2.0')).toBe(-1)
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1)
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('junk', '0.1.0')).toBe(-1)
  })
})

describe('updater: releases', () => {
  const rel = {
    tag_name: 'v0.2.0',
    html_url: 'https://github.com/pokt-network/PSM4Win/releases/tag/v0.2.0',
    body: '## Changes\n- One [link](https://x) here\n- *Two*',
    assets: [
      {
        name: 'PocketServiceManager-Setup-0.2.0.exe',
        browser_download_url: DOWNLOAD_PREFIX + 'v0.2.0/PocketServiceManager-Setup-0.2.0.exe'
      },
      {
        name: 'PocketServiceManager-0.2.0-win-x64.zip',
        browser_download_url: DOWNLOAD_PREFIX + 'v0.2.0/PocketServiceManager-0.2.0-win-x64.zip'
      },
      { name: 'SHA256SUMS', browser_download_url: 'https://evil.example/SHA256SUMS' }
    ]
  }
  it('picks the three assets by exact name and refuses foreign hosts', () => {
    const a = pickReleaseAssets(rel, '0.2.0')
    expect(a.setup?.name).toBe('PocketServiceManager-Setup-0.2.0.exe')
    expect(a.zip?.name).toBe('PocketServiceManager-0.2.0-win-x64.zip')
    expect(a.sums).toBeNull()
  })
  it('parses SHA256SUMS lines', () => {
    const m = parseChecksums(
      'ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef0123456789  PocketServiceManager-Setup-0.2.0.exe\nnot a line\n'
    )
    expect(m.get('PocketServiceManager-Setup-0.2.0.exe')).toBe(
      'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'
    )
    expect(m.size).toBe(1)
  })
  it('turns release notes into bounded plain text', () => {
    expect(plainNotes(rel.body)).toBe('Changes\n- One link here\n- Two')
    expect(plainNotes('')).toBeNull()
    expect(plainNotes('x'.repeat(1000), 100)?.length).toBe(101)
  })
})

describe('updater: install kind', () => {
  it('classifies scoop, installer, portable, and dev', () => {
    expect(
      detectInstallKind(
        'C:\\Users\\me\\scoop\\apps\\pocket-service-manager\\current\\Pocket Service Manager.exe',
        true,
        false
      )
    ).toBe('scoop')
    expect(
      detectInstallKind(
        'C:\\Users\\me\\AppData\\Local\\Programs\\Pocket Service Manager\\Pocket Service Manager.exe',
        true,
        true
      )
    ).toBe('installer')
    expect(detectInstallKind('D:\\tools\\psm\\Pocket Service Manager.exe', true, false)).toBe(
      'portable'
    )
    expect(
      detectInstallKind('Z:\\repo\\node_modules\\electron\\dist\\electron.exe', false, false)
    ).toBe('dev')
  })
})
