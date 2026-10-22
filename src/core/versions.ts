// Pinned versions. Update docs/ARCHITECTURE.md section 7 in the same commit.

/** The pocketd image the app runs in Docker. The HTA used `:latest`; this pins the tag verified on 2026-09-14. */
/** The Electron runtime the app ships (package.json pins it exactly; docs/ARCHITECTURE.md). */
export const ELECTRON_VERSION = '44.9.3'

export const POCKETD_IMAGE = 'ghcr.io/pokt-network/pocketd:0.1.35'
export const POCKETD_VERSION = '0.1.35'

/**
 * The supplier stack Provision ships. Relayer and miner run one exact RelayMiner tag
 * (upstream: mixed versions are unsupported, never a moving tag); v0.1.0 refuses Redis
 * below 8.10 and any eviction policy but noeviction. Verified together on 2026-09-28.
 * v0.1.2 (2026-10-12): v0.1.1 keeps a WebSocket connection to one service; v0.1.2 stops claims
 * and proofs being lost behind load-balanced nodes (Sauron) and replaces a block subscription
 * that goes silent (upstream #45, which stopped a MainNet miner from claiming for 8 days).
 * Both: replace relayer and miner images, no config changes.
 * Since 0.1.28 this is the floor, not the version: Update stack installs upstream's latest
 * release when it is newer (src/core/upgrades.ts), so a new RelayMiner needs no app release.
 */
export const RELAYMINER_VERSION = 'v0.1.2'
export const RELAYMINER_REPO_IMAGE = 'ghcr.io/pokt-network/pocket-relay-miner'
export const RELAYMINER_IMAGE = `${RELAYMINER_REPO_IMAGE}:${RELAYMINER_VERSION}`
export const REDIS_IMAGE = 'redis:8.10.1-alpine'
/**
 * The stack's layout: raised when what Provision ships changes so that a running stack
 * must be provisioned again to get it. 1: up to 0.1.11 (the moving `rc` tag, Redis 8.4);
 * 2: 0.1.12 (pinned images, noeviction, memory limits sized on the server);
 * 3: 0.1.13 (relays validated before they reach the backend: default_validation_mode eager);
 * 4: 0.1.24 (supplier.sh reads, saves, checks, and applies service settings);
 * 5: 0.1.27 (RelayMiner v0.1.2; supplier.sh health and restart-miner for Performance).
 */
export const STACK_LAYOUT = 5

/** The relay client used by the Test screen. */
export const POCKET_AP_IMAGE = 'ghcr.io/pokt-network/pocket-ap:v0.1.2'
export const POCKET_AP_VERSION = 'v0.1.2'

/** Protocol sources this app's behaviour was verified against. */
export const POKTROLL_REF = 'main @ fea9e14'
export const SAGE_REF = '703d8d9'

/** Chain identities. These name a network; they are not governance parameters. */
export const CHAIN_IDS = { beta: 'pocket-lego-testnet', main: 'pocket' } as const

/** The remote MCP server assistants connect to (Settings, Claude Integration). */
export const MCP_ENDPOINT = 'https://mcp.pocketmcp.network/mcp'

/** Docker Desktop's download page (Help and the welcome dialog link to it, so users do not go searching). */
export const DOCKER_DESKTOP_URL = 'https://www.docker.com/products/docker-desktop/'

/** The local action bridge's default loopback port (Settings can change it). */
export const BRIDGE_DEFAULT_PORT = 41777

/** Compat version strings (reference/mcp/src/compat.json). */
export const HTA_COMPAT_VERSION = 'hta-2026-09-14'
export const APP_VERSION_PREFIX = 'electron-'

/** The Docker named volume holding the keyring. Shared with the HTA during the transition. */
export const KEYRING_VOLUME = 'pocket-service-manager-keyring'

/** The owner wallet's key name in the keyring. */
export const OWNER_KEY_NAME = 'service-manager'

/** Where the volume is mounted inside the container (pocketd's home). */
export const HOME_IN_BOX = '/home/pocket/.pocket'

/** The HTA's state folder name under %LOCALAPPDATA%. */
export const HTA_STATE_DIR_NAME = 'PocketServiceManager'

/** The Electron app's data folder name under %APPDATA%. */
export const APP_DATA_DIR_NAME = 'Pocket Service Manager'

/** Docker Desktop's launcher on Windows (docker-start). */
export const DOCKER_DESKTOP_EXE = 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe'

/** Gas flags appended to every local transaction and written literally into remote commands. */
export const GAS_ARGS = [
  '--gas',
  'auto',
  '--gas-prices',
  '1upokt',
  '--gas-adjustment',
  '1.5'
] as const

/** upokt per POKT. */
export const UPOKT_PER_POKT = 1_000_000
