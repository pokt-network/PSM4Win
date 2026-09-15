// Number and text formatting, ported from app.js so every screen prints the same way.
import { UPOKT_PER_POKT } from './versions'

export const POKT = UPOKT_PER_POKT

export function fmtPokt(upokt: number | string | undefined | null): string {
  const n = Number(upokt) / POKT
  if (Number.isNaN(n)) return '?'
  const s = n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')
  const parts = s.split('.')
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return parts.join('.')
}

export function fmtInt(n: number | string | undefined | null): string {
  return String(n ?? '').replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

export function fmtDuration(seconds: number): string {
  if (seconds < 90) return Math.round(seconds) + ' s'
  if (seconds < 5400) return Math.round(seconds / 60) + ' min'
  if (seconds < 172800) return (seconds / 3600).toFixed(1).replace(/\.0$/, '') + ' h'
  return (seconds / 86400).toFixed(1).replace(/\.0$/, '') + ' days'
}

export function shortAddr(a: string | undefined | null): string {
  const s = String(a ?? '')
  return s.length > 16 ? s.substring(0, 10) + '…' + s.substring(s.length - 5) : s
}

export function pad(n: number): string {
  return (n < 10 ? '0' : '') + n
}

export function stamp(): string {
  const d = new Date()
  return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
}

export function todayIsoDate(): string {
  const d = new Date()
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}

export function poktInput(v: string | number): number {
  const n = parseFloat(String(v))
  return n > 0 ? Math.round(n * POKT) : 0
}
