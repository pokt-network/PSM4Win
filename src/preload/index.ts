// The only bridge. Exposes window.psm: one function per signer operation, a
// progress subscription, window controls, settings, and constrained file
// access. No require, no generic invoke: every channel name is fixed here.
import { contextBridge, ipcRenderer } from 'electron'
import {
  SIGNER_OPS,
  type SignerOp,
  type SignerRequests,
  type SignerResult,
  type ProgressEvent
} from '../core/contract'
import type { Settings } from '../main/state/settings'
import type { HtaDetection, ImportResult } from '../main/migration/importer'
import type { BridgeStatus } from '../main/bridge'
import type { BridgeConfirmRequest } from '../main/bridge/confirm'
import type { ClaudeCodeStatus } from '../main/bridge/claudeConfig'

export type RemoteClaudeStatus = ClaudeCodeStatus & { error: string | null }

type SignerApi = {
  [K in SignerOp]: (req: SignerRequests[K], runId?: string) => Promise<SignerResult<K>>
}

const signerApi = Object.fromEntries(
  SIGNER_OPS.map((op) => [
    op,
    (req: unknown, runId?: string) => ipcRenderer.invoke(`signer:${op}`, req ?? {}, runId)
  ])
) as SignerApi

export interface AppInfo {
  version: string
  compatVersion: string
  electron: string
  pocketdImage: string
  pocketdVersion: string
  pocketApImage: string
  mcpEndpoint: string
  dataDir: string
  packaged: boolean
}
export type ServiceFileName =
  'service.json' | 'card.json' | 'deploy/docker-compose.yaml' | 'deploy/answers.json'
export interface ServiceFolder {
  folder: string
  manifest: unknown
  hasCard: boolean
  hasDockerfile: boolean
  hasCompose: boolean
}

const api = {
  signer: signerApi,
  newRunId: (): Promise<string> => ipcRenderer.invoke('signer:new-run-id'),
  cancel: (runId: string): Promise<boolean> => ipcRenderer.invoke('signer:cancel', runId),
  onProgress: (cb: (ev: ProgressEvent) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, ev: ProgressEvent): void => cb(ev)
    ipcRenderer.on('psm:progress', listener)
    return () => ipcRenderer.removeListener('psm:progress', listener)
  },
  window: {
    minimize: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: (): Promise<boolean> => ipcRenderer.invoke('window:toggle-maximize'),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke('window:is-maximized'),
    onMaximizedChange: (cb: (maximized: boolean) => void): (() => void) => {
      const listener = (_e: Electron.IpcRendererEvent, max: boolean): void => cb(max)
      ipcRenderer.on('psm:window-maximized', listener)
      return () => ipcRenderer.removeListener('psm:window-maximized', listener)
    },
    close: (): Promise<void> => ipcRenderer.invoke('window:close')
  },
  app: {
    info: (): Promise<AppInfo> => ipcRenderer.invoke('app:info'),
    openExternal: (url: string): Promise<boolean> => ipcRenderer.invoke('app:open-external', url),
    openPath: (p: string): Promise<boolean> => ipcRenderer.invoke('app:open-path', p),
    probeUrl: (url: string): Promise<number> => ipcRenderer.invoke('net:probe-url', url)
  },
  settings: {
    get: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
    set: (patch: Partial<Settings>): Promise<Settings> => ipcRenderer.invoke('settings:set', patch),
    pickDir: (initial?: string): Promise<string | null> =>
      ipcRenderer.invoke('files:pick-dir', initial),
    pickFile: (opts?: { initial?: string; json?: boolean }): Promise<string | null> =>
      ipcRenderer.invoke('files:pick-file', opts ?? {})
  },
  files: {
    readServiceFolders: (): Promise<{ root: string | null; folders: ServiceFolder[] }> =>
      ipcRenderer.invoke('files:read-service-folders'),
    readServiceFile: (id: string, name: string): Promise<string | null> =>
      ipcRenderer.invoke('files:read-service-file', { id, name }),
    writeServiceFile: (id: string, name: ServiceFileName, text: string): Promise<boolean> =>
      ipcRenderer.invoke('files:write-service-file', { id, name }, text),
    fileExists: (p: string): Promise<boolean> => ipcRenderer.invoke('files:exists', p),
    dirExists: (p: string): Promise<boolean> => ipcRenderer.invoke('files:is-dir', p),
    readRelayTests: (): Promise<string> => ipcRenderer.invoke('files:read-relay-tests'),
    appendRelayTest: (line: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('files:append-relay-test', line),
    clearRelayTests: (): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('files:clear-relay-tests')
  },
  claudeCode: {
    remoteStatus: (): Promise<RemoteClaudeStatus> => ipcRenderer.invoke('claude:remote-status'),
    addRemote: (): Promise<RemoteClaudeStatus> => ipcRenderer.invoke('claude:remote-add'),
    removeRemote: (): Promise<RemoteClaudeStatus> => ipcRenderer.invoke('claude:remote-remove')
  },
  bridge: {
    status: (): Promise<BridgeStatus> => ipcRenderer.invoke('bridge:status'),
    setEnabled: (enabled: boolean, port?: number): Promise<BridgeStatus> =>
      ipcRenderer.invoke('bridge:set-enabled', enabled, port),
    rotateToken: (): Promise<BridgeStatus> => ipcRenderer.invoke('bridge:rotate-token'),
    addToClaudeCode: (): Promise<BridgeStatus & { error: string | null }> =>
      ipcRenderer.invoke('bridge:claude-add'),
    removeFromClaudeCode: (): Promise<BridgeStatus & { error: string | null }> =>
      ipcRenderer.invoke('bridge:claude-remove'),
    reply: (id: string, approved: boolean): Promise<boolean> =>
      ipcRenderer.invoke('bridge:confirm-reply', id, approved),
    onConfirm: (cb: (req: BridgeConfirmRequest) => void): (() => void) => {
      const l = (_e: Electron.IpcRendererEvent, req: BridgeConfirmRequest): void => cb(req)
      ipcRenderer.on('psm:bridge-confirm', l)
      return () => ipcRenderer.removeListener('psm:bridge-confirm', l)
    },
    onConfirmExpired: (cb: (id: string) => void): (() => void) => {
      const l = (_e: Electron.IpcRendererEvent, id: string): void => cb(id)
      ipcRenderer.on('psm:bridge-confirm-expired', l)
      return () => ipcRenderer.removeListener('psm:bridge-confirm-expired', l)
    },
    onStatus: (cb: (st: BridgeStatus) => void): (() => void) => {
      const l = (_e: Electron.IpcRendererEvent, st: BridgeStatus): void => cb(st)
      ipcRenderer.on('psm:bridge-status', l)
      return () => ipcRenderer.removeListener('psm:bridge-status', l)
    },
    onActivity: (cb: (ev: { tool: string; ok: boolean }) => void): (() => void) => {
      const l = (_e: Electron.IpcRendererEvent, ev: { tool: string; ok: boolean }): void => cb(ev)
      ipcRenderer.on('psm:bridge-activity', l)
      return () => ipcRenderer.removeListener('psm:bridge-activity', l)
    }
  },
  migration: {
    detect: (): Promise<HtaDetection> => ipcRenderer.invoke('migration:detect'),
    import: (opts: { servicesRoot?: string }): Promise<ImportResult> =>
      ipcRenderer.invoke('migration:import', opts)
  }
}

export type {
  Settings,
  HtaDetection,
  ImportResult,
  BridgeStatus,
  BridgeConfirmRequest,
  ClaudeCodeStatus
}
export type PsmApi = typeof api

contextBridge.exposeInMainWorld('psm', api)
