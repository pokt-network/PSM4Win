// The upgrade check (docs/ARCHITECTURE.md section 11): shortly after start and every six hours,
// it reads upstream's latest RelayMiner release (counted only once its image is on ghcr.io)
// and, per network, the poktroll version the nodes run and the next upgrade, from the chain's
// current plan or the poktroll repository's upgrade file. Read-only. A newer RelayMiner than
// a provisioned stack runs raises one Windows notification per version; the owner updates the
// stack with Update stack, never the app on its own. Network upgrades are shown, not notified:
// the app's stacks use the public endpoints and need nothing at the upgrade height.
import { app, Notification } from 'electron'
import { NETWORKS, type Network } from '@core/networks'
import { getJson, lcd, measureBlockTime } from '@core/lcd'
import {
  RELAYMINER_GHCR_TOKEN,
  RELAYMINER_LATEST_API,
  RELAYMINER_TAG_RE,
  relayminerBehind,
  relayminerManifestUrl,
  nextVersionCandidates,
  parseCurrentPlan,
  parseUpgradeTx,
  pickUpgrade,
  upgradeEta,
  upgradeTxUrl,
  type NetworkUpgrade,
  type PlannedUpgrade
} from '@core/upgrades'
import { compareVersions } from '@core/update'
import { APP_VERSION_PREFIX, POCKETD_VERSION, RELAYMINER_VERSION } from '@core/versions'
import { readSettings } from './state/settings'
import { log } from './state/log'
import { setRelayminerLatest } from './relayminer-target'

export interface UpgradeStatus {
  checking: boolean
  checkedAt: string
  relayminer: {
    /** Upstream's latest release with a published image; null when unknown. */
    latest: string | null
    /** What Update stack installs now: `latest` when newer than the floor, else the floor. */
    target: string
    /** The floor this app was released with. */
    pinned: string
    url: string
    error: string
  }
  networks: Partial<Record<Network, NetworkUpgrade>>
}

const FIRST_CHECK_MS = 30_000
const CHECK_EVERY_MS = 6 * 60 * 60_000
const TIMEOUT_MS = 20_000
const NET_LABEL: Record<Network, string> = { main: 'MainNet', beta: 'Beta TestNet' }

const ua = (): string => `${APP_VERSION_PREFIX}${app.getVersion()} (${process.platform})`

/** upstream's latest release tag, or null when it has no image on ghcr.io yet. */
async function latestRelayminer(): Promise<{ tag: string | null; url: string }> {
  const res = await fetch(RELAYMINER_LATEST_API, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': ua() },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status} for the RelayMiner release.`)
  const rel = (await res.json()) as { tag_name?: unknown; html_url?: unknown }
  const tag = String(rel.tag_name ?? '')
  const url = typeof rel.html_url === 'string' ? rel.html_url : ''
  if (!RELAYMINER_TAG_RE.test(tag)) return { tag: null, url }
  return { tag: (await imagePublished(tag)) ? tag : null, url }
}

/** Whether ghcr.io serves the image for a tag (an anonymous pull token, then the manifest). */
async function imagePublished(tag: string): Promise<boolean> {
  const t = await fetch(RELAYMINER_GHCR_TOKEN, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!t.ok) throw new Error(`ghcr.io answered HTTP ${t.status} for a pull token.`)
  const { token } = (await t.json()) as { token?: string }
  const m = await fetch(relayminerManifestUrl(tag), {
    method: 'HEAD',
    headers: {
      Authorization: `Bearer ${token ?? ''}`,
      Accept: [
        'application/vnd.oci.image.index.v1+json',
        'application/vnd.docker.distribution.manifest.list.v2+json',
        'application/vnd.oci.image.manifest.v1+json',
        'application/vnd.docker.distribution.manifest.v2+json'
      ].join(', ')
    },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  if (m.status === 404) return false
  if (!m.ok) throw new Error(`ghcr.io answered HTTP ${m.status} for RelayMiner ${tag}.`)
  return true
}

/** The first upgrade file published for a version after `running`; null when there is none. */
async function repoUpgrade(running: string, net: Network): Promise<PlannedUpgrade | null> {
  for (const v of nextVersionCandidates(running)) {
    const res = await fetch(upgradeTxUrl(v, net), { signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (res.status === 404) continue
    if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status} for the ${v} upgrade file.`)
    const u = parseUpgradeTx(await res.json())
    if (u) return u
  }
  return null
}

async function networkUpgrade(net: Network): Promise<NetworkUpgrade> {
  const base: NetworkUpgrade = {
    network: net,
    running: '',
    next: null,
    eta: null,
    appBehind: false,
    error: ''
  }
  try {
    const info = await getJson<{ application_version?: { version?: string } }>(
      lcd(net, '/cosmos/base/tendermint/v1beta1/node_info'),
      0,
      TIMEOUT_MS
    )
    const running = String(info.application_version?.version ?? '').replace(/^v/, '')
    const chain = parseCurrentPlan(
      await getJson(lcd(net, '/cosmos/upgrade/v1beta1/current_plan'), 0, TIMEOUT_MS)
    )
    const repo = chain ? null : await repoUpgrade(running, net)
    const bt = await measureBlockTime(net)
    const next = pickUpgrade(chain, repo, bt.height)
    return {
      ...base,
      running,
      next,
      eta: next ? upgradeEta(next.height, bt.height, bt.seconds) : null,
      appBehind: !!running && compareVersions(running, POCKETD_VERSION) > 0
    }
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : String(e) }
  }
}

class UpgradeMonitor {
  private st: UpgradeStatus = {
    checking: false,
    checkedAt: '',
    relayminer: {
      latest: null,
      target: RELAYMINER_VERSION,
      pinned: RELAYMINER_VERSION,
      url: '',
      error: ''
    },
    networks: {}
  }
  private timer: NodeJS.Timeout | null = null
  private running: Promise<UpgradeStatus> | null = null
  /** RelayMiner versions already notified this run. */
  private notified = new Set<string>()
  private shown = new Set<Notification>()
  private onChange: (s: UpgradeStatus) => void = () => undefined
  private onOpen: () => void = () => undefined

  init(onChange: (s: UpgradeStatus) => void, onOpen: () => void): void {
    this.onChange = onChange
    this.onOpen = onOpen
    setTimeout(() => void this.check(), FIRST_CHECK_MS)
    this.timer = setInterval(() => void this.check(), CHECK_EVERY_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  status(): UpgradeStatus {
    return this.st
  }

  check(): Promise<UpgradeStatus> {
    if (!this.running)
      this.running = this.pass().finally(() => {
        this.running = null
      })
    return this.running
  }

  private async pass(): Promise<UpgradeStatus> {
    this.st = { ...this.st, checking: true }
    this.onChange(this.st)
    let relayminer = this.st.relayminer
    try {
      const r = await latestRelayminer()
      relayminer = {
        ...relayminer,
        latest: r.tag,
        target: setRelayminerLatest(r.tag),
        url: r.url,
        error: ''
      }
    } catch (e) {
      // Keep the last good answer; say why this one failed.
      relayminer = { ...relayminer, error: e instanceof Error ? e.message : String(e) }
    }
    const networks: Partial<Record<Network, NetworkUpgrade>> = {}
    for (const net of NETWORKS) networks[net] = await networkUpgrade(net)
    this.st = { checking: false, checkedAt: new Date().toISOString(), relayminer, networks }
    log.info('upgrade check', {
      relayminer: relayminer.latest,
      target: relayminer.target,
      error: relayminer.error || undefined,
      networks: NETWORKS.map((n) => {
        const u = networks[n]
        return `${n}:${u?.running || '?'}${u?.next ? `->${u.next.name}@${u.next.height ?? 'unset'}` : ''}`
      }).join(' ')
    })
    await this.notify()
    this.onChange(this.st)
    return this.st
  }

  private async notify(): Promise<void> {
    const target = this.st.relayminer.target
    if (target === RELAYMINER_VERSION || this.notified.has(target)) return
    const s = await readSettings()
    const behind: string[] = []
    for (const sv of s.servers)
      for (const net of NETWORKS)
        if (relayminerBehind(sv.suppliers?.[net], target))
          behind.push(`${sv.name} (${NET_LABEL[net]})`)
    if (!behind.length) return
    this.notified.add(target)
    if (!Notification.isSupported()) return
    const n = new Notification({
      title: `RelayMiner ${target} is out`,
      body: `Press Update stack under Suppliers for ${behind.join(', ')}. Nothing changes until you do.`
    })
    n.on('click', () => this.onOpen())
    n.on('close', () => this.shown.delete(n))
    this.shown.add(n)
    n.show()
    log.info('upgrade notification', { relayminer: target, stacks: behind.length })
  }
}

export const upgrades = new UpgradeMonitor()
