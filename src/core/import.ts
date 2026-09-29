// Importing a supplier set up by hand: the plan an import follows, worked out from the
// server survey (src/core/survey.ts). Pure; the wizard carries it out step by step.
//
// The plan: where the operator key comes from; how the app's relayer reaches each of
// their backends (their container, joined to the shared pocket-supplier network, called
// by its container name); what of theirs is stopped, and in which order (relayers first,
// so no new relays arrive; then miners, once their claims are proved; then their proxy,
// only when it serves nothing but the supplier's hostname); and what stands in the way.
import type { SurveyReport } from './survey'

/** App-made containers are never part of what an import stops or attaches. */
export function isAppContainer(name: string): boolean {
  return /^pocket-supplier(-|$)|^pocket-caddy$/.test(name)
}

export interface ImportTarget {
  kind: 'container' | 'unit'
  name: string
  role: 'relayer' | 'miner' | 'relayminer' | 'legacy-relayminer' | 'proxy'
}

export interface ImportBackend {
  service: string
  /** The backend URL in their RelayMiner config. */
  theirs: string
  /** The container that serves it, found by name or network alias. */
  container: string | null
  /** The URL the app's relayer will call: http://<container>:<port>. */
  url: string | null
  problem: string | null
}

export interface ImportPlan {
  /** Where the operator key is on the server; null means the user pastes it. */
  key: { kind: 'keysfile' | 'keyring'; path: string } | null
  backends: ImportBackend[]
  /** What of theirs is stopped at the switch-over, in order. */
  stop: ImportTarget[]
  /** Sentences for things that must be fixed before the import can go ahead. */
  blockers: string[]
  /** Sentences the user should read, which do not stop the import. */
  notes: string[]
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', 'host.docker.internal'])

function hostPort(url: string): { host: string; port: string } | null {
  const m = /^https?:\/\/([^/:]+)(?::(\d+))?/.exec(url.trim())
  if (!m) return null
  return { host: m[1], port: m[2] ?? (url.startsWith('https') ? '443' : '80') }
}

/**
 * The plan for importing the supplier whose operator is `operator` and whose staked URL is
 * `stakedUrl`. `hasAppStack` is true when this server already has an app stack for the
 * network (then the import has nowhere to go).
 */
export function planImport(
  r: SurveyReport,
  opts: { operator: string; stakedUrl: string; hasAppStack: boolean }
): ImportPlan {
  const blockers: string[] = []
  const notes: string[] = []

  if (!r.complete) blockers.push('The survey of the server did not finish; run it again.')
  if (r.partial)
    blockers.push('The server has no python3, which the import needs to read its configs and keys.')
  if (r.docker === 'none' || r.docker === 'unreachable')
    blockers.push(
      r.docker === 'none'
        ? 'Docker is not installed on the server.'
        : 'The server user cannot use Docker; add it to the docker group.'
    )
  if (opts.hasAppStack)
    blockers.push(
      'This server already has a stack from the app for this network, so there is nowhere to import this supplier to.'
    )
  if (!r.sudo)
    blockers.push(
      'The server user needs passwordless sudo, which the app uses to set up the stack and read keys only root may read.'
    )

  // ---- the operator key ----
  let key: ImportPlan['key'] = null
  const file = r.keysFiles.find((k) => k.address === opts.operator)
  const ring = r.keyrings.find((k) => k.address === opts.operator)
  if (file) key = { kind: 'keysfile', path: file.path }
  else if (ring && ring.backend === 'test')
    key = { kind: 'keyring', path: ring.dir.replace(/\/keyring-[a-z]+\/?$/, '') }
  else if (ring)
    notes.push(
      `The operator key is in a keyring protected by a passphrase (${ring.dir}), so it will be pasted into the app instead.`
    )
  else
    notes.push('The operator key was not found on the server, so it will be pasted into the app.')

  // ---- their RelayMiner: what runs it, what to stop ----
  const theirContainers = r.containers.filter((c) => !isAppContainer(c.name))
  const relayers = theirContainers.filter((c) =>
    ['relayer', 'relayminer', 'legacy-relayminer'].includes(c.role)
  )
  const miners = theirContainers.filter((c) => c.role === 'miner')
  const units = r.units.filter((u) => /relayminer|pocket-relay-miner/.test(u.exec))
  const loose = r.processes.filter(
    (p) => !units.some((u) => p.args.includes(u.exec.split(' ')[0] ?? '\0'))
  )
  const stop: ImportTarget[] = [
    ...relayers.map((c) => ({
      kind: 'container' as const,
      name: c.name,
      role: c.role as ImportTarget['role']
    })),
    ...units
      .filter((u) => !/ miner\b/.test(u.exec))
      .map((u) => ({
        kind: 'unit' as const,
        name: u.name,
        role: (/pocket-relay-miner/.test(u.exec)
          ? 'relayer'
          : 'legacy-relayminer') as ImportTarget['role']
      })),
    ...miners.map((c) => ({ kind: 'container' as const, name: c.name, role: 'miner' as const })),
    ...units
      .filter((u) => / miner\b/.test(u.exec))
      .map((u) => ({ kind: 'unit' as const, name: u.name, role: 'miner' as const }))
  ]
  if (!stop.length && !loose.length)
    blockers.push('No RelayMiner of theirs was found running on this server.')
  if (loose.length)
    blockers.push(
      `A RelayMiner runs here outside Docker and systemd (process ${loose.map((p) => p.pid).join(', ')}), which the app cannot stop safely. It needs to be stopped by whoever started it before the import.`
    )
  if (
    relayers.some((c) => c.role === 'legacy-relayminer') ||
    units.some((u) => !/pocket-relay-miner/.test(u.exec))
  )
    notes.push(
      'It runs the legacy pocketd relayminer, which cannot claim through the public endpoints; the import replaces it with the HA RelayMiner.'
    )

  // ---- their backends: the container behind each one ----
  const relayerNets = new Set(
    r.networks
      .filter((n) => relayers.some((c) => c.name === n.container))
      .flatMap((n) => n.nets.map((x) => x.network))
  )
  const seen = new Set<string>()
  const backends: ImportBackend[] = []
  for (const s of r.services) {
    if (seen.has(s.id)) continue
    seen.add(s.id)
    const hp = hostPort(s.backend)
    let container: string | null = null
    let problem: string | null = null
    if (!hp) problem = `Its backend address (${s.backend || 'none'}) could not be read.`
    else if (LOCAL_HOSTS.has(hp.host))
      problem = `Its backend runs on the server itself (${s.backend}), not in a container, so the app's RelayMiner cannot reach it. Put the backend in Docker first; the app's Deploy does that from its service folder.`
    else {
      const byName = r.containers.find((c) => c.name === hp.host && !isAppContainer(c.name))
      // Every container that answers to the host on a network their relayer is on. Several
      // (a shared alias such as "backend") would be a guess, so that is reported instead.
      const byAlias = r.networks
        .filter((n) =>
          n.nets.some(
            (x) =>
              (relayerNets.size === 0 || relayerNets.has(x.network)) && x.aliases.includes(hp.host)
          )
        )
        .map((n) => n.container)
        .filter((c) => !isAppContainer(c))
      if (byName) container = byName.name
      else if (byAlias.length === 1) container = byAlias[0]
      else if (byAlias.length > 1)
        problem = `Several containers answer to ${hp.host} (${byAlias.join(', ')}), so the app cannot tell which one is its backend.`
      else problem = `No running container answers to ${hp.host}, the backend in its config.`
    }
    if (problem) blockers.push(`${s.id}: ${problem}`)
    backends.push({
      service: s.id,
      theirs: s.backend,
      container,
      url: container && hp ? `http://${container}:${hp.port}` : null,
      problem
    })
  }
  if (!backends.length) blockers.push('Their RelayMiner config lists no services.')

  // ---- the web ports: their proxy, and whether it may be stopped ----
  const staked = hostPort(opts.stakedUrl)?.host ?? ''
  const proxies = theirContainers.filter(
    (c) =>
      ['caddy', 'nginx', 'traefik', 'haproxy'].includes(c.role) &&
      /(^|,|:)(80|443)\//.test(c.ports.replace(/->[^,]*/g, ''))
  )
  const appCaddy = r.containers.some((c) => c.name === 'pocket-caddy')
  for (const p of proxies) {
    const kind = p.role
    const others = [
      ...new Set(
        r.sites
          .filter((s) => s.proxy === kind && s.host.replace(/:\d+$/, '') !== staked)
          .map((s) => s.host)
      )
    ]
    if (others.length)
      blockers.push(
        `Their ${kind} (${p.name}) also serves ${others.join(', ')}. The app would need ports 80 and 443 for its own Caddy, so the import leaves it alone and cannot go ahead until those sites move or ${kind} serves only ${staked}.`
      )
    else stop.push({ kind: 'container', name: p.name, role: 'proxy' })
  }
  const hostHolders = r.listens.filter(
    (l) => (l.port === 80 || l.port === 443) && l.process !== 'docker-proxy' && l.process !== ''
  )
  for (const h of hostHolders) {
    const kind = /caddy/.test(h.process) ? 'caddy' : /nginx/.test(h.process) ? 'nginx' : h.process
    const others = [
      ...new Set(
        r.sites
          .filter((s) => s.proxy === kind && s.host.replace(/:\d+$/, '') !== staked)
          .map((s) => s.host)
      )
    ]
    if (kind !== 'caddy' && kind !== 'nginx')
      blockers.push(
        `Port ${h.port} is held by ${h.process}, which the app does not know how to hand over.`
      )
    else if (others.length)
      blockers.push(
        `The server's ${kind} also serves ${others.join(', ')}, so the import cannot take ports 80 and 443 from it.`
      )
    else if (!stop.some((t) => t.name === `${kind}.service`))
      stop.push({ kind: 'unit', name: `${kind}.service`, role: 'proxy' })
  }
  if (appCaddy && !proxies.length && !hostHolders.length)
    notes.push(
      "The app's Caddy already answers on this server; it takes the supplier's hostname too."
    )

  return { key, backends, stop, blockers, notes }
}

// ---- the switch-over ----

/**
 * Their things to stop, in two steps. First whatever stops new relays while their miner keeps
 * running, so it can claim and prove what it has already served; then, once those claims are
 * proved, the rest. A RelayMiner that relays and mines in one process cannot be split that
 * way, so when there is one its proxy goes first instead; without a proxy to stop, it stops
 * at once and the claims it still holds are lost (said in `note`).
 */
export function stopPhases(plan: Pick<ImportPlan, 'stop'>): {
  first: ImportTarget[]
  after: ImportTarget[]
  note: string | null
} {
  const combined = plan.stop.filter(
    (t) => t.role === 'relayminer' || t.role === 'legacy-relayminer'
  )
  const relayers = plan.stop.filter((t) => t.role === 'relayer')
  const miners = plan.stop.filter((t) => t.role === 'miner')
  const proxies = plan.stop.filter((t) => t.role === 'proxy')
  if (!combined.length) return { first: relayers, after: [...miners, ...proxies], note: null }
  if (proxies.length)
    return { first: [...proxies, ...relayers], after: [...combined, ...miners], note: null }
  return {
    first: [...combined, ...relayers],
    after: miners,
    note: 'Their RelayMiner relays and claims in one process and nothing stands in front of it that the app could stop instead, so it stops at once; claims for the relays it served in the last few sessions will not be made.'
  }
}

/** The shared parameters that place a session's claim and proof windows (read live). */
export interface ProofWindows {
  blocksPerSession: number
  anchor: number
  claimOpen: number
  claimClose: number
  proofOpen: number
  proofClose: number
}

export function proofWindowsOf(shared: Record<string, unknown>): ProofWindows | null {
  const n = (k: string): number => Number(shared[k])
  const w: ProofWindows = {
    blocksPerSession: n('num_blocks_per_session'),
    anchor: Number(shared.session_grid_anchor_height ?? 1),
    claimOpen: n('claim_window_open_offset_blocks'),
    claimClose: n('claim_window_close_offset_blocks'),
    proofOpen: n('proof_window_open_offset_blocks'),
    proofClose: n('proof_window_close_offset_blocks')
  }
  return Object.values(w).every((v) => Number.isFinite(v) && v >= 0) && w.blocksPerSession > 0
    ? w
    : null
}

/** The last block of the session that holds `height`. */
export function sessionEndOf(w: ProofWindows, height: number): number {
  const k = Math.floor((height - w.anchor) / w.blocksPerSession)
  return w.anchor + (k + 1) * w.blocksPerSession - 1
}

/**
 * The height at which the proof window closes for the session ending at `sessionEnd`
 * (poktroll x/shared: the claim window opens the block after sessionEnd + its offset).
 * Past it, every claim for that session is either proved or settled.
 */
export function proofCloseAfter(w: ProofWindows, sessionEnd: number): number {
  return sessionEnd + w.claimOpen + 1 + w.claimClose + w.proofOpen + w.proofClose
}

/** What the import has done so far, kept in settings so it resumes after a restart. */
export interface ImportProgress {
  /**
   * staged: the app's stack is ready beside theirs and nothing of theirs is stopped;
   * draining: new relays are stopped and their miner is finishing its claims;
   * switching: their miner and proxy are being stopped and the app's stack started.
   */
  stage: 'staged' | 'draining' | 'switching'
  first: ImportTarget[]
  after: ImportTarget[]
  /** Names of what has been stopped so far, in order. */
  stopped: string[]
  /** The height after which their last claims are proved (set when draining starts). */
  drainUntil?: number
  started_at: string
}
