import type { PsmApi } from './index'

declare global {
  interface Window {
    psm: PsmApi
  }
}

export {}
