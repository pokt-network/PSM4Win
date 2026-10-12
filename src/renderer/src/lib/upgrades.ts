// Wording for the upgrade check's results (src/main/upgrades.ts): the network's next poktroll
// upgrade, as information. The app's stacks use the public endpoints, so they need nothing at
// the upgrade height; when the app itself needs a new release, the updater offers it.
import type { NetworkUpgrade } from '@core/upgrades'
import { fmtDuration, fmtInt } from '@core/format'
import { netLabel } from '../components/ui'

/** One sentence about the next upgrade, or about the app lagging the network; null when there is nothing to say. */
export function networkUpgradeText(
  u: NetworkUpgrade | null | undefined,
  now = Date.now()
): string | null {
  if (!u || u.error || !u.running) return null
  const label = netLabel(u.network)
  if (u.next) {
    const what = `Network upgrade ${u.next.name} on ${label}`
    if (u.next.height === null)
      return `${what} is announced; its height is not set yet. Your stacks use the public endpoints and need nothing for it.`
    const when = u.eta
      ? `, about ${new Date(u.eta).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} (in ${fmtDuration(Math.max(0, (Date.parse(u.eta) - now) / 1000))})`
      : ''
    const proposed = u.next.source === 'chain' ? ' It is approved on chain.' : ''
    return `${what} at height ${fmtInt(u.next.height)}${when}.${proposed} Your stacks use the public endpoints and need nothing for it; if this app needs an update for it, the app offers one.`
  }
  if (u.appBehind)
    return `${label} runs poktroll ${u.running}, newer than this app was released for. Your stacks keep serving; update the app when a new version is offered.`
  return null
}
