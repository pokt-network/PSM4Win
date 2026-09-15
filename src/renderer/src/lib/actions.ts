// Shared behaviours (docs/SCREENS.md section 4): Docker cycle, wallet status,
// balances, live params, catalog, history, folders, network switching, tab
// navigation, manifests, and the chain readers the tables use.
import {
  useStore,
  S,
  type Screen,
  type LocalService,
  type Manifest,
  type AppWallet
} from '../store'
import type { Network } from '@core/networks'
import { OWNER_KEY_NAME } from '@core/versions'
import {
  loadLiveParams,
  loadCatalog,
  appUnbonding,
  appServiceIds,
  supplyStatusMap,
  type SupplyState
} from '@core/chain'
import {
  balanceUpokt,
  application,
  waitForTx,
  type ChainApplication,
  type ChainSupplier,
  type ChainService,
  supplierLookup
} from '@core/lcd'
import { lcdTxUrl } from '@core/chain'
import type { Settings } from '../../../preload/index'
import { alertDialog, confirmDialog } from './modal'
import { isDemo } from './demo'

export const PARENT = OWNER_KEY_NAME
export const psm = (): Window['psm'] => window.psm

export function foot(msg: string): void {
  useStore.setState({ foot: msg })
}

export async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    foot('Copied to clipboard')
  } catch {
    await alertDialog('Could not access the clipboard.')
  }
}

export function openUrl(u: string): void {
  void psm().app.openExternal(u)
}

export function txUrl(net: Network, hash: string): string {
  return lcdTxUrl(net, hash)
}

// ---- settings ----

export async function loadSettings(): Promise<Settings> {
  if (isDemo()) return S().settings as Settings
  const s = await psm().settings.get()
  useStore.setState({ settings: s })
  return s
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const s = await psm().settings.set(patch)
  useStore.setState({ settings: s })
  return s
}

// ---- docker ----

let dockerRetry: ReturnType<typeof setTimeout> | null = null

export function dockerReady(): boolean {
  const d = S().docker
  return !!(d && d.ok && d.image)
}

/** dockerCycle(first): checks Docker, updates the top bar, keeps re-checking while down. */
export async function dockerCycle(first: boolean): Promise<boolean> {
  foot('Checking Docker Desktop')
  const r0 = await psm().signer['docker-check']({})
  const r = 'running' in r0 ? r0 : { ok: false, running: false, error: r0.error, detail: r0.detail }
  useStore.setState({ docker: r, dockerNote: null })
  if (!r.ok) {
    foot('Docker Desktop is not running. Nothing can be signed until it is.')
    void walletStatus()
    if (!dockerRetry) {
      const retry = async (): Promise<void> => {
        const c = await psm().signer['docker-check']({})
        if (c.ok) {
          dockerRetry = null
          void dockerCycle(true)
        } else dockerRetry = setTimeout(retry, 10_000)
      }
      dockerRetry = setTimeout(retry, 10_000)
    }
    return false
  }
  if (dockerRetry) {
    clearTimeout(dockerRetry)
    dockerRetry = null
  }
  if (!r.image) {
    foot('Download the pocketd image once; it is about 100 MB.')
    void walletStatus()
    return false
  }
  foot('Ready')
  void walletStatus()
  if (first) {
    void refreshNetwork()
    void loadHistory()
  }
  return true
}

export function recheckDocker(): void {
  void dockerCycle(true)
}

export async function startDocker(): Promise<void> {
  useStore.setState({ dockerNote: 'Starting Docker Desktop, this can take a minute' })
  const r = await psm().signer['docker-start']({})
  if (!r.ok) {
    useStore.setState({
      dockerNote: null,
      docker: { ok: false, running: false, error: r.error, detail: r.detail }
    })
    return
  }
  let tries = 0
  const again = async (): Promise<void> => {
    tries++
    const c = await psm().signer['docker-check']({})
    if (c.ok || tries > 24) void dockerCycle(true)
    else setTimeout(again, 5000)
  }
  setTimeout(again, 5000)
}

export async function pullImage(): Promise<void> {
  useStore.setState({ dockerNote: 'Downloading pocketd image' })
  const r = await psm().signer['image-pull']({})
  if (!r.ok) {
    useStore.setState({ dockerNote: `Download failed: ${r.error} ${r.detail ?? ''}` })
    return
  }
  void dockerCycle(true)
}

// ---- wallet ----

export async function walletStatus(): Promise<void> {
  const r = await psm().signer['wallet-status']({})
  if (!r.ok) {
    // The HTA sets imported = !!r.imported unconditionally, so a failed read shows #walletNone.
    useStore.setState({ imported: false, address: '', verified: false, partial: false })
    return
  }
  useStore.setState({
    imported: !!r.imported,
    address: r.address ?? '',
    verified: !!r.verified,
    partial: !!r.partial
  })
  if (r.imported) void refreshBalance()
  await loadWallets()
}

export async function refreshBalance(): Promise<number | null> {
  const { address, net } = S()
  if (!address) return null
  try {
    const bal = await balanceUpokt(net, address)
    useStore.setState({ balance: bal })
    return bal
  } catch {
    useStore.setState({ balance: null })
    return null
  }
}

export async function loadWallets(): Promise<AppWallet[]> {
  if (isDemo()) return S().wallets
  const r = await psm().signer['wallet-list']({})
  const wallets = r.ok ? r.wallets : []
  useStore.setState({ wallets, walletsVerified: !!(r.ok && r.verified) })
  return wallets
}

export interface WalletRef {
  name: string
  address: string
  parent: boolean
  service_id: string
  present?: boolean | null
}

export function walletByName(name: string | undefined): WalletRef | null {
  const s = S()
  if (!name || name === PARENT)
    return s.imported ? { name: PARENT, address: s.address, parent: true, service_id: '' } : null
  const w = s.wallets.find((x) => x.name === name)
  return w ? { ...w, parent: false } : null
}

export function walletForService(id: string): AppWallet | null {
  return S().wallets.find((w) => w.service_id === id) ?? null
}

export async function walletReady(what: string): Promise<boolean> {
  if (!S().imported) {
    await alertDialog(`Import the owner wallet first; ${what} needs its keyring.`)
    return false
  }
  if (!dockerReady()) {
    await alertDialog('Docker Desktop must be running with the pocketd image downloaded.')
    return false
  }
  return true
}

// ---- network ----

export async function refreshNetwork(): Promise<void> {
  const net = S().net
  const [params, catalog] = await Promise.all([loadLiveParams(net), loadCatalog(net)])
  if (S().net !== net) return
  useStore.setState({ params, catalog })
}

export async function loadHistory(): Promise<void> {
  if (isDemo()) return
  const r = await psm().signer.history({})
  useStore.setState({ history: r.ok ? r.entries : [] })
}

export async function loadServiceFolders(): Promise<LocalService[]> {
  if (isDemo()) return S().local
  const r = await psm().files.readServiceFolders()
  const local: LocalService[] = r.folders.map((f) => {
    const m = (f.manifest && typeof f.manifest === 'object' ? f.manifest : {}) as Manifest
    return {
      folder: f.folder,
      id: m.service_id || f.folder,
      name: m.name || '',
      cupr: m.compute_units_per_relay || null,
      hasCard: f.hasCard,
      hasDockerfile: f.hasDockerfile,
      hasCompose: f.hasCompose,
      manifest: m
    }
  })
  useStore.setState({ servicesRoot: r.root, local })
  return local
}

export async function setNetwork(n: Network): Promise<void> {
  const s = S()
  if (s.busy) {
    await alertDialog('Wait for the current transaction to finish before switching networks.')
    return
  }
  if (n === 'main' && s.net !== 'main') {
    if (
      !(await confirmDialog(
        'Switch to MainNet? Transactions there spend real POKT.',
        'Switch to MainNet'
      ))
    )
      return
  }
  // The HTA's setNetwork runs the full clear/refresh/re-enter even for the current network.
  useStore.setState({
    net: n,
    epoch: s.epoch + 1,
    params: {},
    catalog: null,
    supOpen: null,
    deployed: null,
    balance: undefined
  })
  tab(S().screen)
  if (n !== s.net) void saveSettings({ network: n })
  void refreshNetwork()
  void refreshBalance()
}

export function toggleTheme(): void {
  const t = S().theme === 'dark' ? 'light' : 'dark'
  useStore.setState({ theme: t })
  void saveSettings({ theme: t })
}

export interface NavSection {
  id: string
  label: string
  screens: readonly (readonly [Screen, string])[]
}

export const NAV: readonly NavSection[] = [
  { id: 'dashboard', label: 'Dashboard', screens: [['dashboard', 'Dashboard']] },
  {
    id: 'services',
    label: 'Services',
    screens: [
      ['services', 'My services'],
      ['create', 'Create service'],
      ['register', 'Register service'],
      ['stake', 'Stake application'],
      ['deploy', 'Deploy service'],
      ['test', 'Test service']
    ]
  },
  { id: 'suppliers', label: 'Suppliers', screens: [['supply', 'Supply service']] },
  { id: 'wallets', label: 'Wallets', screens: [['wallets', 'Wallets']] },
  {
    id: 'settings',
    label: 'Settings',
    screens: [
      ['settings', 'Settings'],
      ['help', 'Help']
    ]
  }
]

export function sectionOf(screen: Screen): NavSection {
  for (const s of NAV) for (const [id] of s.screens) if (id === screen) return s
  return NAV[0]
}

export function tab(name: Screen): void {
  const sec = sectionOf(name)
  useStore.setState((s) => ({
    screen: name,
    navOpen: sec.screens.length > 1 ? { ...s.navOpen, [sec.id]: true } : s.navOpen,
    // tab("supply") always resets to the suppliers list; openSupplier sets supOpen afterwards.
    supOpen: name === 'supply' ? null : s.supOpen
  }))
  const c = document.getElementById('content')
  if (c) c.scrollTop = 0
}

export function navToggle(id: string): void {
  useStore.setState((s) => {
    const isOpen = s.navOpen[id] === undefined ? sectionOf(s.screen).id === id : s.navOpen[id]
    return { navOpen: { ...s.navOpen, [id]: !isOpen } }
  })
}

// ---- services: catalog and local folders ----

export function ownedServices(): ChainService[] {
  const { catalog, address } = S()
  if (!catalog || !address) return []
  return catalog.filter((c) => c.owner_address === address)
}

export function catalogEntry(id: string): ChainService | null {
  return (S().catalog ?? []).find((c) => c.id === id) ?? null
}

export function localServices(): LocalService[] {
  return S().local
}

export function folderForId(id: string): string {
  return S().local.find((l) => l.id === id)?.folder ?? ''
}

export function localById(id: string): LocalService | null {
  return S().local.find((l) => l.id === id) ?? null
}

export async function readManifestFor(id: string): Promise<Manifest | null> {
  const l = localById(id)
  if (!l) return null
  const t = await psm().files.readServiceFile(l.folder, 'service.json')
  if (t === null) return {}
  try {
    return JSON.parse(t) as Manifest
  } catch {
    return null
  }
}

export async function readCardFor(id: string): Promise<unknown | null> {
  const l = localById(id)
  if (!l) return null
  // app.js testProbes: join(root, folder, m.card || "card.json")
  const t = await psm().files.readServiceFile(l.folder, l.manifest?.card || 'card.json')
  if (t === null) return null
  try {
    return JSON.parse(t)
  } catch {
    return null
  }
}

export async function writeManifest(folder: string, m: Manifest): Promise<void> {
  // No trailing newline: the HTA's saveManifest and recordManifest write JSON.stringify(m, null, 2)
  // as is; only createService adds "\n" (Create writes its own file).
  await psm().files.writeServiceFile(folder, 'service.json', JSON.stringify(m, null, 2))
  await loadServiceFolders()
}

export async function recordManifestFor(
  folder: string,
  field: keyof import('../store').NetManifest,
  value: string
): Promise<void> {
  if (!folder) return
  let m: Manifest = {}
  const t = await psm().files.readServiceFile(folder, 'service.json')
  if (t) {
    try {
      m = JSON.parse(t) as Manifest
    } catch {
      m = {}
    }
  }
  const net = S().net
  m.networks = m.networks || {}
  m.networks[net] = { ...(m.networks[net] || {}), [field]: value }
  await writeManifest(folder, m)
}

export function netManifest(l: LocalService | null | undefined): import('../store').NetManifest {
  return (l?.manifest?.networks?.[S().net] as import('../store').NetManifest | undefined) ?? {}
}

// ---- chain readers ----

export async function balanceOf(addr: string): Promise<number | null> {
  try {
    return await balanceUpokt(S().net, addr)
  } catch {
    return null
  }
}

export async function appRecordOf(addr: string | undefined): Promise<ChainApplication | null> {
  if (!addr) return null
  try {
    return await application(S().net, addr)
  } catch {
    return null
  }
}

export interface SupplierLookup {
  status: number
  rec: ChainSupplier | null
}

export async function supplierRecord(op: string | undefined): Promise<SupplierLookup> {
  if (!/^pokt1[0-9a-z]{38}$/.test(op ?? '')) return { status: 0, rec: null }
  return supplierLookup(S().net, op!)
}

export interface AppStakeHolder {
  name: string
  address: string
  stake: number
  unbonding: number
}

/** Application stakes held by any wallet this app manages, keyed by service id. */
export async function appStakesByService(): Promise<Record<string, AppStakeHolder[]>> {
  const s = S()
  const holders: { name: string; address: string }[] = []
  if (s.address) holders.push({ name: PARENT, address: s.address })
  for (const w of s.wallets) holders.push(w)
  const recs = await Promise.all(holders.map((h) => appRecordOf(h.address)))
  const stakes: Record<string, AppStakeHolder[]> = {}
  holders.forEach((h, i) => {
    const rec = recs[i]
    if (!rec) return
    for (const sid of appServiceIds(rec))
      (stakes[sid] = stakes[sid] || []).push({
        name: h.name,
        address: h.address,
        stake: Number(rec.stake.amount),
        unbonding: appUnbonding(rec)
      })
  })
  return stakes
}

// ---- servers and stacks ----

export interface ServerEntry {
  name: string
  host: string
  port: number
  user: string
  keyPath: string
  deployRoot: string
  suppliers: Partial<Record<Network, StackEntry>>
}
export interface StackEntry {
  dir: string
  project: string
  url: string
  operator: string
  provisioned_at?: string
}

export function servers(): ServerEntry[] {
  return (S().settings?.servers ?? []) as ServerEntry[]
}
export function serverByName(name: string | undefined): ServerEntry | null {
  return servers().find((s) => s.name === name) ?? null
}
export function stackOf(s: ServerEntry | null | undefined, net?: Network): StackEntry | null {
  return (s?.suppliers?.[net ?? S().net] as StackEntry | undefined) ?? null
}
export type StackState = 'none' | 'pending' | 'ready'
export function stackState(st: StackEntry | null | undefined): StackState {
  if (!st || !(st.operator || st.dir)) return 'none'
  return st.provisioned_at ? 'ready' : 'pending'
}
export function stackDirDefault(net: Network): string {
  return '/opt/pocket/supplier-' + net
}
export function stackProjectDefault(net: Network): string {
  return 'pocket-supplier-' + net
}
export function stackPorts(net: Network): {
  health: number
  relayer_metrics: number
  miner_metrics: number
} {
  return net === 'main'
    ? { health: 8082, relayer_metrics: 9091, miner_metrics: 9093 }
    : { health: 8081, relayer_metrics: 9090, miner_metrics: 9092 }
}
export function hostOfUrl(u: string | undefined): string {
  const m = /^https?:\/\/([^/:]+)/.exec(String(u ?? ''))
  return m ? m[1] : ''
}
export const CADDY_DIR = '/opt/pocket/caddy'

export async function saveServers(list: ServerEntry[]): Promise<void> {
  await saveSettings({ servers: list as Settings['servers'] })
}
export async function setStack(
  name: string,
  net: Network,
  patch: Partial<StackEntry>
): Promise<void> {
  const list = servers().map((s) => {
    if (s.name !== name) return s
    const st = {
      dir: '',
      project: '',
      url: '',
      operator: '',
      ...(s.suppliers?.[net] ?? {}),
      ...patch
    }
    return { ...s, suppliers: { ...(s.suppliers ?? {}), [net]: st } }
  })
  await saveServers(list)
}

export interface SshConnOf {
  host: string
  port: number
  user: string
  key_path: string
  path: string
}
export function connOf(s: ServerEntry, net?: Network): SshConnOf {
  const st = stackOf(s, net) ?? ({} as Partial<StackEntry>)
  return { host: s.host, port: s.port, user: s.user, key_path: s.keyPath, path: st.dir ?? '' }
}

export interface SupplierRow {
  server: ServerEntry
  stack: StackEntry | null
  state: StackState
  rec: ChainSupplier | null
  status: number
  gas: number | null
  answers: boolean
}

/** One row per server, read live from the chain, concurrently. */
export async function supplierRows(): Promise<SupplierRow[]> {
  const net = S().net
  return Promise.all(
    servers().map(async (s): Promise<SupplierRow> => {
      const st = stackOf(s, net)
      const ss = stackState(st)
      if (ss !== 'ready') {
        return {
          server: s,
          stack: st,
          state: ss,
          rec: null,
          status: 0,
          gas: st?.operator ? await balanceOf(st.operator) : null,
          answers: false
        }
      }
      const [sr, gas, reach] = await Promise.all([
        supplierRecord(st!.operator),
        balanceOf(st!.operator),
        st!.url
          ? isDemo()
            ? Promise.resolve(200)
            : psm().app.probeUrl(st!.url)
          : Promise.resolve(0)
      ])
      return {
        server: s,
        stack: st,
        state: 'ready',
        rec: sr.rec,
        status: sr.status,
        gas,
        answers: !!reach
      }
    })
  )
}

export async function supplyMap(rows?: SupplierRow[]): Promise<Record<string, SupplyState>> {
  const rs = rows ?? (await supplierRows())
  return supplyStatusMap(
    S().params,
    rs.filter((r) => r.state === 'ready').map((r) => ({ server: r.server.name, rec: r.rec }))
  )
}

// ---- transactions ----

export function pollTx(hash: string): Promise<{ ok: boolean; height?: number; error?: string }> {
  return waitForTx(S().net, hash)
}

export function setBusy(b: boolean): void {
  useStore.setState({ busy: b })
}

// Development only: this module holds live state, so a hot update must reload the page and
// re-run the startup sequence instead of swapping the module under the running screens.
if (import.meta.hot) import.meta.hot.accept(() => window.location.reload())
