// Screenshot mode (`electron . --screenshot=<png>`, docs/PACKAGING.md section 6). The window
// opens with example data instead of running the startup sequence: no keyring, no settings
// file, no history. Account-side reads on the LCD (balances, the application and supplier
// records, the catalog) are answered from the examples below; everything governance-side
// (parameters, blocks, gateways) still comes from the live network, as rule 1 requires.
import { useStore } from '../store'
import { setLcdStub, type ChainApplication, type ChainService, type ChainSupplier } from '@core/lcd'
import { loadLiveParams } from '@core/chain'
import { POKT } from '@core/format'
import { tab } from './actions'

export function isDemo(): boolean {
  try {
    return new URLSearchParams(window.location.search).has('demo')
  } catch {
    return false
  }
}

// The documentation placeholder addresses used throughout fixtures/ (they belong to nobody).
const OWNER = 'pokt1qyqszqgpqyqszqgpqyqszqgpqyqszqgp04723y'
const APP = 'pokt1qszqgpqyqszqgpqyqszqgpqyqszqgpqyl37th0'
const OPERATOR = 'pokt1qgpqyqszqgpqyqszqgpqyqszqgpqyqsz73c06j'
const URL_BETA = 'https://services-beta.example.org'
const HASH = (n: number): string => n.toString(16).toUpperCase().padStart(64, '0')

const catalog: ChainService[] = [
  {
    id: 'example-charts',
    name: 'Example Charts',
    compute_units_per_relay: '10000',
    owner_address: OWNER
  },
  {
    id: 'example-builder-test',
    name: 'Service Builder Test',
    compute_units_per_relay: '1000',
    owner_address: OWNER
  }
]

const application: ChainApplication = {
  address: APP,
  stake: { denom: 'upokt', amount: String(1_500 * POKT) },
  service_configs: [{ service_id: 'example-charts' }]
}

const supplier: ChainSupplier = {
  owner_address: OWNER,
  operator_address: OPERATOR,
  stake: { denom: 'upokt', amount: String(60_000 * POKT) },
  services: catalog.map((c) => ({
    service_id: c.id,
    endpoints: [{ url: URL_BETA, rpc_type: 'REST' }]
  })),
  service_config_history: []
}

const balances: Record<string, number> = {
  [OWNER]: 12_345.678 * POKT,
  [APP]: 1_480.5 * POKT,
  [OPERATOR]: 42.25 * POKT
}

function stub(url: string): unknown | undefined {
  const m = (re: RegExp): RegExpExecArray | null => re.exec(url)
  let x: RegExpExecArray | null
  if ((x = m(/\/bank\/v1beta1\/balances\/(pokt1[0-9a-z]+)/)))
    return { balances: [{ denom: 'upokt', amount: String(Math.round(balances[x[1]] ?? 0)) }] }
  if ((x = m(/\/application\/application\/(pokt1[0-9a-z]+)/)))
    return x[1] === APP ? { application } : { code: 5, message: 'not found' }
  if ((x = m(/\/supplier\/supplier\/(pokt1[0-9a-z]+)/)))
    return x[1] === OPERATOR ? { supplier } : { code: 5, message: 'not found' }
  if ((x = m(/\/session\/get_session\?.*service_id=([^&]+)/))) {
    // The heights are left at zero: the example session has no place on the live grid,
    // and the screen then says who is serving without naming a block that is not real.
    const serves = catalog.some((c) => c.id === decodeURIComponent(x![1]))
    return {
      session: {
        header: {},
        suppliers: serves ? [{ operator_address: OPERATOR }] : []
      }
    }
  }
  if (/\/service\/service\?/.test(url)) return { service: catalog }
  if ((x = m(/\/service\/service\/([A-Za-z0-9_-]+)$/))) {
    const s = catalog.find((c) => c.id === x![1])
    return s ? { service: s } : { code: 5, message: 'not found' }
  }
  return undefined
}

/** Fills the store with the example state and points account-side LCD reads at it. */
export async function installDemo(): Promise<void> {
  setLcdStub(stub)
  const now = new Date()
  const iso = (minutesAgo: number): string =>
    new Date(now.getTime() - minutesAgo * 60_000).toISOString()
  useStore.setState({
    net: 'beta',
    theme: 'dark',
    settings: {
      schemaVersion: 1,
      network: 'beta',
      theme: 'dark',
      servicesRoot: 'C:\\Users\\you\\Documents\\services',
      supplierServer: 'example-host',
      welcomeSeen: true,
      servers: [
        {
          name: 'example-host',
          host: '203.0.113.10',
          port: 22,
          user: 'ubuntu',
          keyPath: 'C:\\Users\\you\\.ssh\\id_supplier',
          deployRoot: '/opt/pocket/services',
          suppliers: {
            beta: {
              dir: '/opt/pocket/supplier-beta',
              project: 'pocket-supplier-beta',
              url: URL_BETA,
              operator: OPERATOR,
              provisioned_at: iso(3 * 24 * 60)
            }
          }
        }
      ]
    },
    servicesRoot: 'C:\\Users\\you\\Documents\\services',
    docker: {
      ok: true,
      running: true,
      docker: '27.5.1',
      image: true,
      pocketap: true,
      pocketd: '0.1.35'
    },
    dockerNote: null,
    imported: true,
    address: OWNER,
    verified: true,
    partial: false,
    balance: balances[OWNER],
    wallets: [
      {
        name: 'app-example-charts',
        address: APP,
        service_id: 'example-charts',
        created_at: iso(2 * 24 * 60),
        source: 'create',
        present: true
      }
    ],
    walletsVerified: true,
    catalog,
    local: [
      {
        folder: 'example-charts',
        id: 'example-charts',
        name: 'Example Charts',
        cupr: 10000,
        hasCard: true,
        hasDockerfile: true,
        hasCompose: true,
        manifest: {
          service_id: 'example-charts',
          name: 'Example Charts',
          compute_units_per_relay: 10000
        }
      },
      {
        folder: 'example-builder-test',
        id: 'example-builder-test',
        name: 'Service Builder Test',
        cupr: 1000,
        hasCard: true,
        hasDockerfile: true,
        hasCompose: false,
        manifest: {
          service_id: 'example-builder-test',
          name: 'Service Builder Test',
          compute_units_per_relay: 1000
        }
      }
    ],
    history: [
      {
        time: iso(2 * 24 * 60 + 40),
        op: 'add-service',
        network: 'beta',
        service_id: 'example-charts',
        txhash: HASH(1),
        code: 0
      },
      {
        time: iso(2 * 24 * 60 + 20),
        op: 'stake-app',
        network: 'beta',
        service_id: 'example-charts',
        txhash: HASH(2),
        code: 0,
        address: APP
      },
      {
        time: iso(24 * 60 + 30),
        op: 'stake-supplier',
        network: 'beta',
        service_id: 'example-charts,example-builder-test',
        txhash: HASH(3),
        code: 0,
        extra: `operator=${OPERATOR} via ubuntu@203.0.113.10`
      },
      {
        time: iso(24 * 60),
        op: 'relay-test',
        network: 'beta',
        service_id: 'example-charts',
        code: 0,
        extra: 'wallet=app-example-charts GET /v1/version code=0 http=200 ms=412'
      }
    ],
    foot: 'Ready'
  })
  try {
    useStore.setState({ params: await loadLiveParams('beta') })
  } catch {
    // the chain panel shows "?" for anything the network did not answer
  }
  tab('dashboard')
}
