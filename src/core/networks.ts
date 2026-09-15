// Per-network endpoints. Hostnames and URL formats only; every chain value is
// fetched live (see lcd.ts). Hosts are overridable from settings.
import { CHAIN_IDS } from './versions'

export type Network = 'beta' | 'main'
export const NETWORKS = ['beta', 'main'] as const

export interface NetworkInfo {
  chainId: string
  lcd: string
  rpc: string
  grpc: string
  explorer: string
  faucet: string | null
  /** Used only when the measured block time is unavailable. */
  blockTimeFallbackSeconds: number
  /** Defaults the UI proposes for a supplier stack on this network. */
  stack: {
    dir: string
    project: string
    healthPort: number
    relayerMetricsPort: number
    minerMetricsPort: number
  }
}

export const NETWORK_INFO: Record<Network, NetworkInfo> = {
  beta: {
    chainId: CHAIN_IDS.beta,
    lcd: 'https://sauron-api.beta.infra.pocket.network',
    rpc: 'https://sauron-rpc.beta.infra.pocket.network',
    grpc: 'sauron-grpc.beta.infra.pocket.network:443',
    explorer: 'https://explorer.pocket.network/beta',
    faucet: 'https://faucet.beta.pocket.network/',
    blockTimeFallbackSeconds: 30,
    stack: {
      dir: '/opt/pocket/supplier-beta',
      project: 'pocket-supplier-beta',
      healthPort: 8081,
      relayerMetricsPort: 9090,
      minerMetricsPort: 9092
    }
  },
  main: {
    chainId: CHAIN_IDS.main,
    lcd: 'https://sauron-api.infra.pocket.network',
    rpc: 'https://sauron-rpc.infra.pocket.network',
    grpc: 'sauron-grpc.infra.pocket.network:443',
    explorer: 'https://explorer.pocket.network',
    faucet: null,
    blockTimeFallbackSeconds: 60,
    stack: {
      dir: '/opt/pocket/supplier-main',
      project: 'pocket-supplier-main',
      healthPort: 8082,
      relayerMetricsPort: 9091,
      minerMetricsPort: 9093
    }
  }
}

/** The shared Caddy directory on a supplier host. */
export const CADDY_DIR = '/opt/pocket/caddy'

export function isNetwork(v: unknown): v is Network {
  return v === 'beta' || v === 'main'
}

export function explorerTx(net: Network, txhash: string): string {
  return `${NETWORK_INFO[net].explorer}/tx/${txhash}`
}

export function explorerAccount(net: Network, address: string): string {
  return `${NETWORK_INFO[net].explorer}/account/${address}`
}

export function explorerService(net: Network, id: string): string {
  return `${NETWORK_INFO[net].explorer}/services/${id}`
}
