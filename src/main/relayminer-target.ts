// The RelayMiner supplier-ship writes into stack.env. The upgrade check (./upgrades) sets it
// once it has seen upstream's latest release with its image; until then it is the pinned one.
// Kept apart from ./upgrades so the signer does not load Electron's notification code.
import { relayminerTarget } from '@core/upgrades'
import { RELAYMINER_VERSION } from '@core/versions'

let target = RELAYMINER_VERSION

export function getRelayminerTarget(): string {
  return target
}

export function setRelayminerLatest(latest: string | null): string {
  target = relayminerTarget(latest)
  return target
}
