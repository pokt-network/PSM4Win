// Read-only client for the Pocket Shannon Cosmos LCD. Mirrors the Skill's
// scripts/common.py. Nothing here signs or broadcasts.

export type Network = "beta" | "main";
export const NETWORK_ENUM = ["beta", "main"] as const;

export interface NetworkInfo {
  chainId: string;
  lcd: string;
  explorer: string;
  faucet: string | null;
}

export const NETWORKS: Record<Network, NetworkInfo> = {
  beta: {
    chainId: "pocket-lego-testnet",
    lcd: "https://sauron-api.beta.infra.pocket.network",
    explorer: "https://explorer.pocket.network/beta",
    faucet: "https://faucet.beta.pocket.network/",
  },
  main: {
    chainId: "pocket",
    lcd: "https://sauron-api.infra.pocket.network",
    explorer: "https://explorer.pocket.network",
    faucet: null,
  },
};

export class LcdError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "LcdError";
  }
}

// Per-isolate cache with short TTLs: keeps the LCD polite under bursts while
// every answer stays "fetched moments ago". Nothing is cached across deploys.
const cache = new Map<string, { expires: number; value: Promise<unknown> }>();
export const TTL = { params: 30_000, catalog: 60_000, state: 5_000 } as const;

export async function getJson<T>(url: string, ttlMs = 0): Promise<T> {
  const now = Date.now();
  const hit = cache.get(url);
  if (hit && hit.expires > now) return hit.value as Promise<T>;
  const p = (async () => {
    const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      throw new LcdError(`HTTP ${res.status} for ${url}: ${body}`, res.status);
    }
    return (await res.json()) as T;
  })();
  if (ttlMs > 0) {
    cache.set(url, { expires: now + ttlMs, value: p });
    p.catch(() => cache.delete(url));
  }
  return p;
}

export function lcd(net: Network, path: string): string {
  return NETWORKS[net].lcd + path;
}

function isNotFound(e: unknown): boolean {
  return e instanceof LcdError && (e.status === 404 || /not found/i.test(e.message));
}

// ---- module params ----

export async function params(net: Network, module: string): Promise<Record<string, any>> {
  const d = await getJson<{ params?: Record<string, any> }>(lcd(net, `/pokt-network/poktroll/${module}/params`), TTL.params);
  return d.params ?? {};
}

// ---- services ----

export interface ChainService {
  id: string;
  name: string;
  compute_units_per_relay: string;
  owner_address: string;
  metadata?: { card?: string };
}

export async function allServices(net: Network): Promise<ChainService[]> {
  const d = await getJson<{ service?: ChainService[] }>(lcd(net, "/pokt-network/poktroll/service/service?pagination.limit=2000"), TTL.catalog);
  return d.service ?? [];
}

export async function service(net: Network, id: string): Promise<ChainService | null> {
  try {
    const d = await getJson<{ service: ChainService }>(lcd(net, `/pokt-network/poktroll/service/service/${encodeURIComponent(id)}`), TTL.state);
    return d.service ?? null;
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The card is stored as raw bytes and returned base64-encoded. Not gzipped. */
export function cardBytes(svc: ChainService): Uint8Array | null {
  const b64 = svc.metadata?.card;
  return b64 ? b64ToBytes(b64) : null;
}

export function decodeCard(svc: ChainService): unknown | null {
  const bytes = cardBytes(svc);
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

// ---- suppliers ----

export interface ChainSupplier {
  owner_address: string;
  operator_address: string;
  stake: { denom: string; amount: string };
  services: { service_id: string; endpoints: { url: string; rpc_type: string }[]; rev_share?: { address: string; rev_share_percentage: string }[] }[];
  service_config_history?: { service?: { service_id: string }; activation_height?: string; deactivation_height?: string }[];
  unstake_session_end_height?: string;
}

export async function supplier(net: Network, operator: string): Promise<ChainSupplier | null> {
  try {
    const d = await getJson<{ supplier: ChainSupplier }>(lcd(net, `/pokt-network/poktroll/supplier/supplier/${operator}`), TTL.state);
    return d.supplier ?? null;
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

export async function suppliersForService(net: Network, serviceId: string): Promise<ChainSupplier[]> {
  const d = await getJson<{ supplier?: ChainSupplier[] }>(
    lcd(net, `/pokt-network/poktroll/supplier/supplier?service_id=${encodeURIComponent(serviceId)}&pagination.limit=500`), TTL.state);
  return d.supplier ?? [];
}

// ---- chain state ----

export async function latestHeight(net: Network): Promise<number> {
  const d = await getJson<{ block: { header: { height: string; time: string } } }>(lcd(net, "/cosmos/base/tendermint/v1beta1/blocks/latest"), TTL.state);
  return Number(d.block.header.height);
}

export async function session(net: Network, app: string, serviceId: string, height: number): Promise<any> {
  const d = await getJson<{ session: any }>(
    lcd(net, `/pokt-network/poktroll/session/get_session?application_address=${app}&service_id=${encodeURIComponent(serviceId)}&block_height=${height}`), 0);
  return d.session ?? {};
}

export async function claims(net: Network, operator: string): Promise<any[]> {
  const d = await getJson<{ claims?: any[] }>(lcd(net, `/pokt-network/poktroll/proof/claim?supplier_operator_address=${operator}&pagination.limit=50`), TTL.state);
  return d.claims ?? [];
}

export async function proofs(net: Network, operator: string): Promise<any[]> {
  const d = await getJson<{ proofs?: any[] }>(lcd(net, `/pokt-network/poktroll/proof/proof?supplier_operator_address=${operator}&pagination.limit=50`), TTL.state);
  return d.proofs ?? [];
}

export async function balanceUpokt(net: Network, address: string): Promise<number> {
  const d = await getJson<{ balances?: { denom: string; amount: string }[] }>(lcd(net, `/cosmos/bank/v1beta1/balances/${address}`), TTL.state);
  const c = (d.balances ?? []).find((b) => b.denom === "upokt");
  return c ? Number(c.amount) : 0;
}

export async function application(net: Network, address: string): Promise<any | null> {
  try {
    const d = await getJson<{ application: any }>(lcd(net, `/pokt-network/poktroll/application/application/${address}`), TTL.state);
    return d.application ?? null;
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

export function upoktToPokt(amount: string | number | undefined): number {
  return Number(amount ?? 0) / 1_000_000;
}

export const LIVE_NOTE = "Fetched live from the network just now. These are governance parameters and chain state; they change. Quote them with the network and time, and re-fetch before relying on them.";
