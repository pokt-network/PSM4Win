// The Performance monitor (docs/ARCHITECTURE.md section 10): every 30 minutes while the app
// runs, in the window or in the tray, it asks each provisioned stack's helper what its miner
// did (supplier.sh health, read-only), compares that with the claims the indexer saw, and
// raises a Windows notification for a supplier that has stopped claiming. Operators who never
// look at their servers are told; the screen shows the same results.
import { Notification } from 'electron'
import { existsSync } from 'node:fs'
import { NETWORKS, type Network } from '@core/networks'
import { latestHeight } from '@core/lcd'
import {
  parseHealth,
  judgeStack,
  claimParams,
  claimedSessions,
  type StackVerdict,
  type ClaimParams
} from '@core/performance'
import { readSettings } from './state/settings'
import { signer } from './signer'
import { log } from './state/log'

export interface StackCheck {
  server: string
  network: Network
  operator: string
  checkedAt: string
  /** Null when the check could not be made; `error` says why. */
  verdict: StackVerdict | null
  error: string
  lastHeight: number
  sessions: number
}

export interface PerformanceStatus {
  checking: boolean
  checkedAt: string
  stacks: StackCheck[]
  /** Stacks whose verdict is a warning. */
  warnings: number
}

const FIRST_CHECK_MS = 60_000
const CHECK_EVERY_MS = 30 * 60_000
const NET_LABEL: Record<Network, string> = { main: 'MainNet', beta: 'Beta TestNet' }

class PerformanceMonitor {
  private st: PerformanceStatus = { checking: false, checkedAt: '', stacks: [], warnings: 0 }
  private timer: NodeJS.Timeout | null = null
  private running: Promise<PerformanceStatus> | null = null
  /** Warnings already notified, so each episode is announced once (cleared when it is fine). */
  private notified = new Set<string>()
  /** Shown notifications, held until closed: one collected early loses its click on Windows. */
  private shown = new Set<Notification>()
  private onChange: (s: PerformanceStatus) => void = () => undefined
  private onOpen: () => void = () => undefined

  init(onChange: (s: PerformanceStatus) => void, onOpen: () => void): void {
    this.onChange = onChange
    this.onOpen = onOpen
    setTimeout(() => void this.check(), FIRST_CHECK_MS)
    this.timer = setInterval(() => void this.check(), CHECK_EVERY_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  status(): PerformanceStatus {
    return this.st
  }

  /** One pass over every provisioned stack; a pass already under way is joined, not doubled. */
  check(): Promise<PerformanceStatus> {
    if (!this.running)
      this.running = this.pass().finally(() => {
        this.running = null
      })
    return this.running
  }

  private async pass(): Promise<PerformanceStatus> {
    this.st = { ...this.st, checking: true }
    this.onChange(this.st)
    const s = await readSettings()
    const heads = new Map<Network, number>()
    const params = new Map<Network, ClaimParams>()
    const stacks: StackCheck[] = []
    for (const sv of s.servers) {
      for (const net of NETWORKS) {
        const stk = sv.suppliers?.[net]
        if (!stk?.provisioned_at || !stk.dir || !stk.operator) continue
        stacks.push(await this.checkStack(sv, net, stk.dir, stk.operator, heads, params))
      }
    }
    const warnings = stacks.filter((x) => x.verdict && !x.verdict.ok).length
    this.st = { checking: false, checkedAt: new Date().toISOString(), stacks, warnings }
    this.notify(stacks)
    log.info('performance check', {
      stacks: stacks.length,
      warnings,
      errors: stacks.filter((x) => x.error).length
    })
    this.onChange(this.st)
    return this.st
  }

  private async checkStack(
    sv: { name: string; host: string; port: number; user: string; keyPath: string },
    net: Network,
    dir: string,
    operator: string,
    heads: Map<Network, number>,
    params: Map<Network, ClaimParams>
  ): Promise<StackCheck> {
    const base: StackCheck = {
      server: sv.name,
      network: net,
      operator,
      checkedAt: new Date().toISOString(),
      verdict: null,
      error: '',
      lastHeight: 0,
      sessions: 0
    }
    if (!existsSync(sv.keyPath))
      return { ...base, error: `The SSH key file for ${sv.name} is not on this PC.` }
    try {
      const r = await signer.run('supplier-run', {
        host: sv.host,
        port: sv.port,
        user: sv.user,
        key_path: sv.keyPath,
        path: dir,
        step: 'health'
      })
      if (/unknown step health/.test(r.out))
        return {
          ...base,
          error: `This stack's helper predates Performance. Press Update stack for ${sv.name} under Suppliers.`
        }
      const h = parseHealth(r.out)
      if (typeof h === 'string')
        return { ...base, error: r.ok ? h : r.err || (r as { error?: string }).error || h }
      if (!heads.has(net)) heads.set(net, await latestHeight(net))
      if (!params.has(net)) params.set(net, await claimParams(net))
      const head = heads.get(net)!
      const p = params.get(net)!
      // Judged first without claims: the miner being down or behind, or too few sessions to
      // judge, does not depend on them. Only an "unclaimed" verdict needs the claims of the
      // periods it judged.
      let verdict = judgeStack(h, new Set(), head, p)
      if (verdict.kind === 'unclaimed') {
        const claimed = await claimedSessions(net, operator, Math.min(...verdict.periods))
        verdict = judgeStack(h, claimed.sessions, head, p)
        // A read that missed claims can wrongly say none were made; say that the check could
        // not be made instead.
        if (verdict.kind === 'unclaimed' && !claimed.complete)
          return {
            ...base,
            error: `${sv.name}'s claims could not all be read, so whether it is claiming is not known.`,
            lastHeight: h.last_height,
            sessions: h.sessions.length
          }
      }
      return {
        ...base,
        verdict,
        lastHeight: h.last_height,
        sessions: h.sessions.length
      }
    } catch (e) {
      return { ...base, error: e instanceof Error ? e.message : String(e) }
    }
  }

  private notify(stacks: StackCheck[]): void {
    for (const x of stacks) {
      const key = `${x.server}|${x.network}`
      if (!x.verdict) continue
      if (x.verdict.ok) {
        this.notified.delete(key)
        continue
      }
      if (this.notified.has(key)) continue
      this.notified.add(key)
      if (!Notification.isSupported()) continue
      const n = new Notification({
        title: `${x.server} is not claiming on ${NET_LABEL[x.network]}`,
        body: `${x.verdict.text} Open Performance to restart its miner.`
      })
      n.on('click', () => this.onOpen())
      n.on('close', () => this.shown.delete(n))
      this.shown.add(n)
      n.show()
      log.info('performance notification', {
        server: x.server,
        network: x.network,
        kind: x.verdict.kind
      })
    }
  }
}

export const performance = new PerformanceMonitor()
