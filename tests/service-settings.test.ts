import { describe, it, expect } from 'vitest'
import {
  parseSettingsFile,
  validateSettingsDecl,
  envNameFor,
  envNameProblem,
  hostAllowed,
  valueProblem,
  normaliseValue,
  variablesFor,
  missingRequired,
  settingsPatch,
  checkArgs,
  composeSettingsProblems,
  parseSettingsRead,
  parseSettingsCheck,
  helperTooOld,
  restartPorts,
  type SettingsDecl
} from '@core/service-settings'

// The shape a service with operator alerts declares (deploy/settings.json).
const EXAMPLE = {
  settings: [
    {
      env: 'EXSVC_{NETWORK}_ALERT_WEBHOOK',
      scope: 'network',
      label: 'Discord webhook',
      help: 'Where the report is posted.',
      type: 'url',
      secret: true,
      hosts: ['discord.com', 'discordapp.com']
    },
    {
      env: 'EXSVC_{NETWORK}_ALERT_INTERVAL_MIN',
      scope: 'network',
      label: 'Report every (minutes)',
      type: 'number',
      min: 15,
      max: 1440,
      default: 60
    },
    {
      env: 'EXSVC_{NETWORK}_ALERT_MODE',
      scope: 'network',
      label: 'What to send',
      type: 'choice',
      choices: [{ value: 'report', label: 'A full report' }, 'problems'],
      default: 'report'
    },
    { env: 'EXSVC_DEBUG', label: 'Debug log', type: 'boolean', default: false },
    {
      env: 'EXSVC_TOKEN',
      label: 'API key',
      type: 'text',
      secret: true,
      required: true,
      pattern: '^[a-z0-9]{8,}$'
    }
  ],
  check: {
    label: 'Send a test alert',
    command: ['node', 'src/operator.js', '{network}', 'alert-test'],
    scope: 'network',
    timeout_s: 60
  }
}

const parse = (j: unknown): ReturnType<typeof validateSettingsDecl> => validateSettingsDecl(j)
const decl = (): SettingsDecl => {
  const r = parse(EXAMPLE)
  if (!r.ok) throw new Error(r.error)
  return r.decl
}
const err = (j: unknown): string => {
  const r = parse(j)
  return r.ok ? '' : r.error
}
const one = (s: Record<string, unknown>): Record<string, unknown> => ({ settings: [s] })

describe('deploy/settings.json: parsing', () => {
  it('parses the example and fills in the defaults', () => {
    const d = decl()
    expect(d.settings).toHaveLength(5)
    expect(d.settings[0]).toMatchObject({ scope: 'network', secret: true, required: false })
    expect(d.settings[1].default).toBe('60')
    expect(d.settings[1].integer).toBe(true)
    expect(d.settings[2].choices).toEqual([
      { value: 'report', label: 'A full report' },
      { value: 'problems', label: 'problems' }
    ])
    expect(d.settings[3]).toMatchObject({ scope: 'service', default: 'false' })
    expect(d.check).toEqual(EXAMPLE.check)
  })
  it('reports bad JSON and a missing list', () => {
    expect(parseSettingsFile('{').ok).toBe(false)
    expect(err({})).toMatch(/"settings" list/)
    expect(err({ settings: [] })).toMatch(/no settings/)
  })
  it('refuses unknown fields and types', () => {
    expect(err({ ...EXAMPLE, extra: 1 })).toMatch(/"extra" is not a known field/)
    expect(err(one({ env: 'A_B', label: 'x', type: 'secret' }))).toMatch(/"type" must be one of/)
    expect(err(one({ env: 'A_B', label: 'x', type: 'text', hostz: [] }))).toMatch(
      /"hostz" is not a setting field\./
    )
    expect(err(one({ env: 'A_B', label: 'x', type: 'text', hosts: ['a.com'] }))).toMatch(
      /"hosts" is not a setting field for type text/
    )
    expect(err({ ...EXAMPLE, check: { ...EXAMPLE.check, shell: true } })).toMatch(
      /"shell" is not a check field/
    )
  })
  it('checks names and the network token', () => {
    expect(err(one({ env: 'lower', label: 'x', type: 'text' }))).toMatch(/not a usable variable/)
    expect(err(one({ env: 'PATH', label: 'x', type: 'text' }))).toMatch(/relies on/)
    expect(err(one({ env: 'LD_PRELOAD', label: 'x', type: 'text' }))).toMatch(/relies on/)
    expect(err(one({ env: 'A_{NETWORK}', label: 'x', type: 'text' }))).toMatch(/only for settings/)
    expect(err(one({ env: 'A_B', scope: 'network', label: 'x', type: 'text' }))).toMatch(
      /once in its name/
    )
    expect(err(one({ env: 'A_B', scope: 'everywhere', label: 'x', type: 'text' }))).toMatch(
      /"scope"/
    )
    expect(
      err({
        settings: [
          { env: 'A_{NETWORK}', scope: 'network', label: 'x', type: 'text' },
          { env: 'A_MAIN', label: 'y', type: 'text' }
        ]
      })
    ).toMatch(/A_MAIN is declared twice/)
  })
  it('secret only on text and url, and never with a default', () => {
    expect(err(one({ env: 'A', label: 'x', type: 'number', secret: true }))).toMatch(
      /only text and url/
    )
    expect(err(one({ env: 'A', label: 'x', type: 'text', secret: true, default: 'k' }))).toMatch(
      /cannot have a default/
    )
  })
  it("checks each type's rules and the default against them", () => {
    expect(err(one({ env: 'A', label: 'x', type: 'text', pattern: 'abc' }))).toMatch(
      /start with \^/
    )
    expect(err(one({ env: 'A', label: 'x', type: 'text', pattern: '^(a$' }))).toMatch(/not a valid/)
    expect(err(one({ env: 'A', label: 'x', type: 'text', min_length: 5, max_length: 2 }))).toMatch(
      /more than "max_length"/
    )
    expect(err(one({ env: 'A', label: 'x', type: 'number', min: 5, max: 2 }))).toMatch(
      /more than "max"/
    )
    expect(err(one({ env: 'A', label: 'x', type: 'number', min: 15, default: 5 }))).toMatch(
      /default does not fit.*at least 15/
    )
    expect(err(one({ env: 'A', label: 'x', type: 'number', default: '60' }))).toMatch(
      /must be a number/
    )
    expect(err(one({ env: 'A', label: 'x', type: 'choice', choices: [] }))).toMatch(
      /"choices" list/
    )
    expect(err(one({ env: 'A', label: 'x', type: 'choice', choices: ['a b'] }))).toMatch(
      /value must be/
    )
    expect(err(one({ env: 'A', label: 'x', type: 'choice', choices: ['a', 'a'] }))).toMatch(/twice/)
    expect(err(one({ env: 'A', label: 'x', type: 'url', hosts: ['Discord.com'] }))).toMatch(
      /lowercase/
    )
    expect(err(one({ env: 'A', label: 'x', type: 'boolean', default: 'yes' }))).toMatch(
      /true or false/
    )
    expect(err(one({ env: 'A', type: 'text' }))).toMatch(/needs a "label"/)
  })
  it('checks the check command', () => {
    const c = (patch: Record<string, unknown>): string =>
      err({ ...EXAMPLE, check: { ...EXAMPLE.check, ...patch } })
    expect(c({ command: 'node check.js' })).toMatch(/list of 1 to 16/)
    expect(c({ command: [] })).toMatch(/list of 1 to 16/)
    expect(c({ command: ['node', 'a\nb'] })).toMatch(/list of 1 to 16/)
    expect(c({ command: ['node', 'check.js'] })).toMatch(/must have \{network\}/)
    expect(c({ scope: 'service' })).toMatch(/only for a check with/)
    expect(c({ timeout_s: 600 })).toMatch(/1 to 60/)
    expect(c({ label: '' })).toMatch(/needs a "label"/)
  })
})

describe('deploy/settings.json: names and values', () => {
  it('fills in the network token', () => {
    const d = decl()
    expect(envNameFor(d.settings[0], 'main')).toBe('EXSVC_MAIN_ALERT_WEBHOOK')
    expect(envNameFor(d.settings[0], 'beta')).toBe('EXSVC_BETA_ALERT_WEBHOOK')
    expect(envNameFor(d.settings[3])).toBe('EXSVC_DEBUG')
    expect(() => envNameFor(d.settings[0])).toThrow(/which network/)
    expect(variablesFor(d, ['main']).map((v) => v.name)).toEqual([
      'EXSVC_MAIN_ALERT_WEBHOOK',
      'EXSVC_MAIN_ALERT_INTERVAL_MIN',
      'EXSVC_MAIN_ALERT_MODE',
      'EXSVC_DEBUG',
      'EXSVC_TOKEN'
    ])
    expect(envNameProblem('GOOD_NAME_2')).toBe('')
  })
  it('matches hosts exactly or under a wildcard', () => {
    expect(hostAllowed('discord.com', ['discord.com'])).toBe(true)
    expect(hostAllowed('DISCORD.COM', ['discord.com'])).toBe(true)
    expect(hostAllowed('evil-discord.com', ['discord.com'])).toBe(false)
    expect(hostAllowed('discord.com.evil.org', ['discord.com'])).toBe(false)
    expect(hostAllowed('hooks.example.com', ['*.example.com'])).toBe(true)
    expect(hostAllowed('example.com', ['*.example.com'])).toBe(false)
    expect(hostAllowed('badexample.com', ['*.example.com'])).toBe(false)
  })
  it('checks values by type', () => {
    const [hook, interval, mode, debug, token] = decl().settings
    expect(valueProblem(hook, 'https://discord.com/api/webhooks/1/abc')).toBe('')
    expect(valueProblem(hook, 'http://discord.com/api/webhooks/1/abc')).toMatch(/https/)
    expect(valueProblem(hook, 'https://evil.org/discord.com')).toMatch(/discord\.com or/)
    expect(valueProblem(hook, 'https://u:p@discord.com/x')).toMatch(/user name/)
    expect(valueProblem(hook, 'not a url')).toMatch(/web address/)
    expect(valueProblem(interval, '30')).toBe('')
    expect(valueProblem(interval, '10')).toMatch(/at least 15/)
    expect(valueProblem(interval, '30.5')).toMatch(/whole number/)
    expect(valueProblem(interval, 'abc')).toMatch(/must be a number/)
    expect(valueProblem(mode, 'problems')).toBe('')
    expect(valueProblem(mode, 'loud')).toMatch(/one of report, problems/)
    expect(valueProblem(debug, 'true')).toBe('')
    expect(valueProblem(debug, 'yes')).toMatch(/true or false/)
    expect(valueProblem(token, 'abcd1234')).toBe('')
    expect(valueProblem(token, 'ABCD1234')).toMatch(/expected form/)
    expect(valueProblem(token, '')).toBe('')
    expect(normaliseValue(interval, ' 060 ')).toBe('60')
  })
  it('refuses what the values file cannot hold, without repeating the value', () => {
    const t = decl().settings[4]
    const open = { ...t, pattern: undefined }
    expect(valueProblem(open, "abc'def")).toMatch(/single quote/)
    expect(valueProblem(open, 'abc\ndef')).toMatch(/one line/)
    expect(valueProblem(open, 'x'.repeat(2000))).toMatch(/at most 1024/)
    expect(valueProblem(open, "secret'value")).not.toContain('secret')
  })
})

describe('deploy/settings.json: patches and state', () => {
  it('builds a patch, clears empty values, and names nothing it was not given', () => {
    const p = settingsPatch(decl(), [
      { name: 'EXSVC_MAIN_ALERT_INTERVAL_MIN', value: ' 30 ' },
      { name: 'EXSVC_BETA_ALERT_MODE', value: '' },
      { name: 'EXSVC_TOKEN', value: null }
    ])
    expect(p).toEqual({
      set: { EXSVC_MAIN_ALERT_INTERVAL_MIN: '30' },
      clear: ['EXSVC_BETA_ALERT_MODE', 'EXSVC_TOKEN']
    })
  })
  it('refuses undeclared names, repeats, and bad values without echoing them', () => {
    const d = decl()
    expect(() => settingsPatch(d, [])).toThrow(/No settings were changed/)
    expect(() => settingsPatch(d, [{ name: 'PATH', value: '/x' }])).toThrow(/not declared/)
    expect(() =>
      settingsPatch(d, [
        { name: 'EXSVC_DEBUG', value: 'true' },
        { name: 'EXSVC_DEBUG', value: 'false' }
      ])
    ).toThrow(/twice/)
    let msg = ''
    try {
      settingsPatch(d, [
        { name: 'EXSVC_MAIN_ALERT_WEBHOOK', value: 'https://evil.org/hook-s3cr3t' }
      ])
    } catch (e) {
      msg = (e as Error).message
    }
    expect(msg).toMatch(/Discord webhook \(main\): It must point at/)
    expect(msg).not.toContain('s3cr3t')
    expect(() => settingsPatch(d, [{ name: 'EXSVC_MAIN_ALERT_WEBHOOK', value: 1 }])).toThrow(
      /must be text/
    )
  })
  it('only names a network it was given', () => {
    expect(() =>
      settingsPatch(decl(), [{ name: 'EXSVC_BETA_ALERT_MODE', value: 'report' }], ['main'])
    ).toThrow(/not declared/)
  })
  it('lists required variables with no value and no default', () => {
    const d = decl()
    expect(missingRequired(d, ['main'], {}).map((v) => v.name)).toEqual(['EXSVC_TOKEN'])
    expect(missingRequired(d, ['main'], { EXSVC_TOKEN: { set: true } })).toEqual([])
  })
  it('fills the check command for a network', () => {
    const c = decl().check!
    expect(checkArgs(c, 'beta')).toEqual(['node', 'src/operator.js', 'beta', 'alert-test'])
    expect(() => checkArgs(c)).toThrow(/which network/)
  })
})

describe('deploy/settings.json: the service compose', () => {
  const base = `services:\n  backend:\n    build: ../backend\n`
  it('needs env_file pointing at the values file', () => {
    expect(composeSettingsProblems(base, decl()).error).toMatch(/env_file: \.\.\/settings\.env/)
    expect(composeSettingsProblems(`${base}    env_file: ../settings.env\n`, decl()).error).toBe('')
    expect(
      composeSettingsProblems(`${base}    env_file:\n      - path: ../settings.env\n`, decl()).error
    ).toBe('')
    expect(
      composeSettingsProblems(`${base}    env_file: ../settings.env.bak\n`, decl()).error
    ).not.toBe('')
  })
  it('warns when environment: also lists a setting', () => {
    const c = `${base}    env_file: ../settings.env\n    environment:\n      EXSVC_DEBUG: \${EXSVC_DEBUG:-}\n      - "EXSVC_TOKEN=x"\n`
    const w = composeSettingsProblems(c, decl()).warnings
    expect(w).toHaveLength(2)
    expect(w[0]).toMatch(/EXSVC_DEBUG is also listed/)
  })
})

describe('what the server helper answers', () => {
  const line = (j: unknown): string => `some noise\nsettings: ${JSON.stringify(j)}\n`
  it('parses settings-read, checks the declaration, and keeps only known networks', () => {
    const r = parseSettingsRead(
      line({
        declared: EXAMPLE,
        values: {
          EXSVC_MAIN_ALERT_MODE: { set: true, value: 'problems', applied: false },
          EXSVC_TOKEN: { set: true, value: 'leaked', applied: true },
          OLD_THING: { set: true, value: 'x', declared: false },
          'bad name': { set: true }
        },
        container: true,
        served: [{ network: 'main', port: 8080 }, { network: 'mars', port: 1 }, 'x']
      })
    )
    if (typeof r === 'string') throw new Error(r)
    expect(r.declared?.settings).toHaveLength(5)
    expect(r.declared_error).toBe('')
    expect(r.values).toEqual({
      EXSVC_MAIN_ALERT_MODE: { set: true, value: 'problems', applied: false },
      // A secret's value is dropped even if a helper sent one.
      EXSVC_TOKEN: { set: true, applied: true },
      OLD_THING: { set: true, declared: false }
    })
    expect(r.container).toBe(true)
    expect(r.served).toEqual([{ network: 'main', port: 8080 }])
  })
  it('reports a deployed declaration the app cannot use, and a service without one', () => {
    const bad = parseSettingsRead(line({ declared: { settings: 'no' }, values: {} }))
    if (typeof bad === 'string') throw new Error(bad)
    expect(bad.declared).toBeNull()
    expect(bad.declared_error).toMatch(/^On the server: /)
    const none = parseSettingsRead(line({ declared: null, values: {}, container: false }))
    if (typeof none === 'string') throw new Error(none)
    expect(none).toEqual({
      declared: null,
      declared_error: '',
      values: {},
      container: false,
      served: []
    })
    expect(parseSettingsRead('nothing')).toMatch(/did not report/)
    expect(parseSettingsRead('settings: {')).toMatch(/cannot read/)
  })
  it('parses settings-check', () => {
    expect(parseSettingsCheck('check: passed\noutput: sent\n')).toEqual({
      passed: true,
      summary: 'passed',
      output: ['sent']
    })
    expect(parseSettingsCheck('check: failed (exit 3)\noutput: no hook\noutput: x\n')).toEqual({
      passed: false,
      summary: 'failed (exit 3)',
      output: ['no hook', 'x']
    })
    expect(parseSettingsCheck('error: x').summary).toBe('')
  })
  it('knows an old helper and checks restart ports', () => {
    expect(helperTooOld('error: unknown step settings-read\n')).toBe(true)
    expect(helperTooOld('error: unknown step backend-restart')).toBe(true)
    expect(helperTooOld('error: something else')).toBe(false)
    expect(restartPorts([])).toEqual([8080])
    expect(restartPorts([8080, 8081, 8080])).toEqual([8080, 8081])
    expect(() => restartPorts([80])).toThrow(/1024 to 65535/)
    expect(() => restartPorts([8080, 8081, 8082, 8083, 8084])).toThrow(/at most 4/)
  })
})
