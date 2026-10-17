// The network's indexer (pocketdex GraphQL): the one client every indexer query of the app goes
// through. No Electron, no DOM.
import { NETWORK_INFO, type Network } from './networks'

/** One indexer read; throws on HTTP and GraphQL errors so a gap is never shown as zero. */
export async function gql<T>(
  net: Network,
  query: string,
  variables: Record<string, unknown> = {},
  timeoutMs = 30_000
): Promise<T> {
  const res = await fetch(NETWORK_INFO[net].indexer, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(timeoutMs)
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} from the indexer`)
  const j = (await res.json()) as { data?: T; errors?: { message: string }[] }
  if (j.errors?.length) throw new Error(`the indexer answered: ${j.errors[0].message}`)
  if (!j.data) throw new Error('the indexer answered nothing')
  return j.data
}
