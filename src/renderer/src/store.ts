// Global store (docs/SCREENS.md section 6): network, theme, owner wallet,
// wallets, settings, Docker, live params, catalog, busy, screen, history, plus
// the per-screen form state that app.js kept in the DOM (so it survives tab
// switches and cross-screen prefills the same way).
import { create } from 'zustand'
import type { Network } from '@core/networks'
import type { DockerCheckResult, HistoryEntry, WalletListResult } from '@core/contract'
import type { ChainService } from '@core/lcd'
import type { LiveParams } from '@core/chain'
import type { CreateForm, CreateAuto } from '@core/card-form'
import { EMPTY_CREATE_FORM } from '@core/card-form'
import type { BridgeStatus, Settings, AppInfo } from '../../preload/index'

export type Screen =
  | 'help'
  | 'dashboard'
  | 'services'
  | 'create'
  | 'register'
  | 'stake'
  | 'deploy'
  | 'test'
  | 'supply'
  | 'wallets'
  | 'settings'
export const SCREENS: Screen[] = [
  'dashboard',
  'services',
  'create',
  'register',
  'stake',
  'deploy',
  'test',
  'supply',
  'wallets',
  'settings'
]

export interface NetManifest {
  register_tx?: string
  last_update_tx?: string
  app_stake_tx?: string
  app_wallet?: string
  app_address?: string
  supplier_stake_tx?: string
  supplier_operator?: string
  supplier_url?: string
  deploy_host?: string
  deploy_path?: string
  deployed_at?: string
}
export interface Manifest {
  service_id?: string
  name?: string
  compute_units_per_relay?: number
  card?: string
  application_stake_pokt?: number
  networks?: Partial<Record<Network, NetManifest>>
}
export interface LocalService {
  folder: string
  id: string
  name: string
  cupr: number | null
  hasCard: boolean
  hasDockerfile: boolean
  hasCompose: boolean
  manifest: Manifest
}

export type AppWallet = WalletListResult['wallets'][number]

export interface RegisterForm {
  folder: string
  id: string
  name: string
  cupr: string
  card: string
}
export interface StakeForm {
  id: string
  from: string
  amount: string
  fund: string
  /** Set by a wallet-row Stake/Restake: the Stake screen keeps this `from` once instead of
   *  re-deriving it from the service (the HTA re-applies the wallet after tab("stake")). */
  fromPinned?: boolean
}
export interface SupplyRow {
  id: string
  name: string
  url: string
  rpc: string
  checked: boolean
  staked: boolean
}

export interface State {
  net: Network
  theme: 'light' | 'dark'
  screen: Screen
  navOpen: Record<string, boolean>
  epoch: number
  settings: Settings | null
  appInfo: AppInfo | null
  servicesRoot: string | null
  docker: DockerCheckResult | null
  dockerNote: string | null
  imported: boolean
  address: string
  verified: boolean
  partial: boolean
  balance: number | null | undefined
  wallets: AppWallet[]
  walletsVerified: boolean
  params: LiveParams
  catalog: ChainService[] | null
  local: LocalService[]
  history: HistoryEntry[]
  busy: boolean
  foot: string
  // per-screen state that persists across tabs
  reg: RegisterForm
  cr: CreateForm
  crAuto: CreateAuto
  crFolder: string
  stk: StakeForm
  dep: { id: string; server: string }
  tst: { id: string; wallet: string }
  supOpen: { server: string; preselect?: string } | null
  prov: { server: string; net: Network; dir: string; host: string; fund: string }
  deployed: { id: string; server: string } | null
  bridge: BridgeStatus | null
  set: (patch: Partial<State> | ((s: State) => Partial<State>)) => void
}

export const useStore = create<State>((set) => ({
  net: 'beta',
  theme: 'light',
  screen: 'dashboard',
  navOpen: {},
  epoch: 0,
  settings: null,
  appInfo: null,
  servicesRoot: null,
  docker: null,
  dockerNote: null,
  imported: false,
  address: '',
  verified: false,
  partial: false,
  balance: undefined,
  wallets: [],
  walletsVerified: false,
  params: {},
  catalog: null,
  local: [],
  history: [],
  busy: false,
  foot: 'Starting',
  reg: { folder: '', id: '', name: '', cupr: '100', card: '' },
  cr: { ...EMPTY_CREATE_FORM },
  crAuto: { apis: true, hint: true, impl: true, idMatch: true },
  crFolder: '',
  stk: { id: '', from: 'service-manager', amount: '', fund: '' },
  dep: { id: '', server: '' },
  tst: { id: '', wallet: '' },
  supOpen: null,
  prov: { server: '', net: 'beta', dir: '', host: '', fund: '10' },
  deployed: null,
  bridge: null,
  set: (patch) => set(patch as never)
}))

export const S = (): State => useStore.getState()

// Development only: this module holds live state, so a hot update must reload the page and
// re-run the startup sequence instead of swapping the module under the running screens.
if (import.meta.hot) import.meta.hot.accept(() => window.location.reload())
