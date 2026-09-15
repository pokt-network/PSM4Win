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
    readServiceFile: (id: string, name: ServiceFileName): Promise<string | null> =>
      ipcRenderer.invoke('files:read-service-file', { id, name }),
    writeServiceFile: (id: string, name: ServiceFileName, text: string): Promise<boolean> =>
      ipcRenderer.invoke('files:write-service-file', { id, name }, text),
    fileExists: (p: string): Promise<boolean> => ipcRenderer.invoke('files:exists', p),
    readRelayTests: (): Promise<string> => ipcRenderer.invoke('files:read-relay-tests'),
    appendRelayTest: (line: string): Promise<boolean> =>
      ipcRenderer.invoke('files:append-relay-test', line),
    clearRelayTests: (): Promise<boolean> => ipcRenderer.invoke('files:clear-relay-tests')
  },
  migration: {
    detect: (): Promise<HtaDetection> => ipcRenderer.invoke('migration:detect'),
    import: (opts: { servicesRoot?: string }): Promise<ImportResult> =>
      ipcRenderer.invoke('migration:import', opts)
  }
}

export type { Settings, HtaDetection, ImportResult }
export type PsmApi = typeof api

contextBridge.exposeInMainWorld('psm', api)
