// Node upgrades (docs/ARCHITECTURE.md section 11): which RelayMiner a stack should run, and
// what the network's next poktroll upgrade is. Pure: the main process fetches, this decides.
//
// RelayMiner: upstream releases often and the app follows its `latest` release, so a new
// RelayMiner needs no app release. RELAYMINER_VERSION (versions.ts) is the floor and the
// fallback when the check fails; the app never offers a version older than it.
//
// poktroll: an upgrade happens at a height the release team publishes in the poktroll
// repository (tools/scripts/upgrades/upgrade_tx_v<ver>_<net>.json, `plan.height`, "UPDATE_ME"
// until it is set) and then proposes on chain (cosmos/upgrade current_plan). The app's stacks
// use the public endpoints, so a network upgrade asks nothing of them; the notice is information.
import type { Network } from './networks'
import { compareVersions, parseVersion } from './update'
import { RELAYMINER_REPO_IMAGE, RELAYMINER_VERSION } from './versions'

export const RELAYMINER_REPO = 'pokt-network/pocket-relay-miner'
export const RELAYMINER_LATEST_API = `https://api.github.com/repos/${RELAYMINER_REPO}/releases/latest`
export const RELAYMINER_RELEASES_PAGE = `https://github.com/${RELAYMINER_REPO}/releases`
/** Anonymous pull token and manifest URL on ghcr.io: a release only counts once its image is there. */
export const RELAYMINER_GHCR_TOKEN = `https://ghcr.io/token?scope=repository:${RELAYMINER_REPO}:pull`
export const relayminerManifestUrl = (tag: string): string =>
  `https://ghcr.io/v2/${RELAYMINER_REPO}/manifests/${tag}`

/** A release tag the app will put in an image name and in stack.env: plain vX.Y.Z only. */
export const RELAYMINER_TAG_RE = /^v\d{1,4}\.\d{1,4}\.\d{1,4}$/

export function relayminerImage(version: string): string {
  return `${RELAYMINER_REPO_IMAGE}:${version}`
}

/**
 * The RelayMiner Update stack installs: upstream's latest release when it is newer than the
 * floor, otherwise the floor. Anything that is not a plain tag is ignored.
 */
export function relayminerTarget(latest: string | null | undefined): string {
  const v = String(latest ?? '')
  return RELAYMINER_TAG_RE.test(v) && compareVersions(v, RELAYMINER_VERSION) > 0
    ? v
    : RELAYMINER_VERSION
}

/** 0.1.27 shipped layout 5 with this RelayMiner and did not record the version in the stack entry. */
const LAYOUT_5_RELAYMINER = 'v0.1.2'

/** The RelayMiner a provisioned stack runs, from its record; null when the record does not say. */
export function stackRelayminer(
  st: { provisioned_at?: string; layout?: number; relayminer?: string } | null | undefined
): string | null {
  if (!st?.provisioned_at) return null
  if (st.relayminer && RELAYMINER_TAG_RE.test(st.relayminer)) return st.relayminer
  return st.layout === 5 ? LAYOUT_5_RELAYMINER : null
}

/** Whether a stack runs an older RelayMiner than `target` (a stack of an older layout needs an update anyway). */
export function relayminerBehind(
  st: { provisioned_at?: string; layout?: number; relayminer?: string } | null | undefined,
  target: string
): boolean {
  const v = stackRelayminer(st)
  return !!v && compareVersions(v, target) < 0
}

export interface PlannedUpgrade {
  /** "v0.1.36" */
  name: string
  /** Null while the repository file still says UPDATE_ME. */
  height: number | null
  /** Proposed on chain, or only published in the poktroll repository so far. */
  source: 'chain' | 'repo'
}

/** The versions whose upgrade file may come next after the one the network runs. */
export function nextVersionCandidates(running: string): string[] {
  const p = parseVersion(running)
  if (!p) return []
  return [`v${p[0]}.${p[1]}.${p[2] + 1}`, `v${p[0]}.${p[1] + 1}.0`]
}

export function upgradeTxUrl(version: string, net: Network): string {
  return `https://raw.githubusercontent.com/pokt-network/poktroll/main/tools/scripts/upgrades/upgrade_tx_${version}_${net}.json`
}

function heightOf(v: unknown): number | null {
  const s = String(v ?? '')
  return /^\d{1,12}$/.test(s) && Number(s) > 0 ? Number(s) : null
}

/** upgrade_tx_v<ver>_<net>.json: the MsgSoftwareUpgrade's plan. */
export function parseUpgradeTx(j: unknown): PlannedUpgrade | null {
  const msgs = (j as { body?: { messages?: unknown[] } })?.body?.messages
  if (!Array.isArray(msgs)) return null
  for (const m of msgs) {
    const plan = (m as { plan?: { name?: unknown; height?: unknown } })?.plan
    if (plan && typeof plan.name === 'string' && plan.name)
      return { name: plan.name, height: heightOf(plan.height), source: 'repo' }
  }
  return null
}

/** cosmos/upgrade/v1beta1/current_plan: `{"plan": null}` until a proposal passes. */
export function parseCurrentPlan(j: unknown): PlannedUpgrade | null {
  const plan = (j as { plan?: { name?: unknown; height?: unknown } | null })?.plan
  if (!plan || typeof plan.name !== 'string' || !plan.name) return null
  return { name: plan.name, height: heightOf(plan.height), source: 'chain' }
}

export interface NetworkUpgrade {
  network: Network
  /** The poktroll version the network's nodes report (node_info application_version). */
  running: string
  next: PlannedUpgrade | null
  /** Estimated time of `next.height`, from the live block time. */
  eta: string | null
  /** The network runs a newer poktroll than the pocketd this app pins. */
  appBehind: boolean
  error: string
}

/**
 * The next upgrade to show: the on-chain plan when there is one, else the repository's;
 * none once its height has been reached (the network has upgraded or is upgrading).
 */
export function pickUpgrade(
  chain: PlannedUpgrade | null,
  repo: PlannedUpgrade | null,
  latestHeight: number
): PlannedUpgrade | null {
  const u = chain ?? repo
  if (!u) return null
  if (u.height !== null && latestHeight >= u.height) return null
  return u
}

export function upgradeEta(
  height: number | null,
  latestHeight: number,
  blockSeconds: number,
  now = Date.now()
): string | null {
  if (height === null || !(blockSeconds > 0) || height <= latestHeight) return null
  return new Date(now + (height - latestHeight) * blockSeconds * 1000).toISOString()
}
