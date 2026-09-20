// The status, log, checklist, and plan primitives (docs/SCREENS.md 1.7), plus
// badges and the empty state. Pure presentation; state lives in the hooks below.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { CheckItem } from '@core/card-form'
import { stamp } from '@core/format'
import { NETWORK_INFO, type Network } from '@core/networks'
import { useStore } from '../store'

export function netLabel(net: Network): string {
  return net === 'main' ? 'MainNet' : 'Beta TestNet'
}
export { NETWORK_INFO }

export function Badge({
  cls,
  id,
  children
}: {
  cls: 'ok' | 'warn' | 'bad' | 'info' | 'blue' | 'muted'
  id?: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <span className={'badge ' + cls} id={id}>
      {children}
    </span>
  )
}

export function NetBadge({ id }: { id?: string } = {}): React.JSX.Element {
  const net = useStore((s) => s.net)
  return (
    <Badge cls={net === 'main' ? 'bad' : 'info'} id={id}>
      {netLabel(net)}
    </Badge>
  )
}

export interface Status {
  text: ReactNode
  cls: '' | 'ok' | 'err' | 'busy'
}
export const NO_STATUS: Status = { text: '', cls: '' }

export function StatusLine({ status, id }: { status: Status; id?: string }): React.JSX.Element {
  return (
    <div id={id} className={'status ' + status.cls}>
      {status.text}
    </div>
  )
}

export function useStatus(): [Status, (text: ReactNode, cls?: Status['cls']) => void] {
  const [st, setSt] = useState<Status>(NO_STATUS)
  const set = useCallback((text: ReactNode, cls: Status['cls'] = '') => setSt({ text, cls }), [])
  return [st, set]
}

export interface CheckNode {
  level: CheckItem['level']
  text: ReactNode
  sub?: ReactNode
}

export function Checks({
  items,
  id
}: {
  items: CheckNode[]
  id?: string
}): React.JSX.Element | null {
  if (!items.length) return null
  return (
    <ul className="checks" id={id}>
      {items.map((it, i) => (
        <li key={i} className={it.level}>
          {it.text}
          {it.sub ? <span className="sub">{it.sub}</span> : null}
        </li>
      ))}
    </ul>
  )
}

export function hasFailNodes(items: CheckNode[]): boolean {
  return items.some((i) => i.level === 'fail')
}

export interface LogLine {
  t: string
  cls: '' | 'ok' | 'err'
  node: ReactNode
}

export function useLog(): {
  lines: LogLine[]
  log: (node: ReactNode, cls?: LogLine['cls']) => void
  clear: () => void
} {
  const [lines, setLines] = useState<LogLine[]>([])
  const log = useCallback(
    (node: ReactNode, cls: LogLine['cls'] = '') =>
      setLines((l) => [...l, { t: stamp(), cls, node }]),
    []
  )
  const clear = useCallback(() => setLines([]), [])
  return { lines, log, clear }
}

export function LogBox({ lines, id }: { lines: LogLine[]; id?: string }): React.JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [lines])
  if (!lines.length) return null
  return (
    <div className="log" id={id} ref={ref}>
      {lines.map((l, i) => (
        <div key={i}>
          <span className="t">{l.t}</span>
          <span className={l.cls}>{l.node}</span>
        </div>
      ))}
    </div>
  )
}

/**
 * The preflight results, folded away once the action they cleared is under way.
 *
 * Preflight prints a checklist and the exact command the signer will run. That is the
 * point before the button is pressed and it is in the way afterwards: the run's own
 * narration starts below a screenful of something the user has already read and agreed
 * to, and on a slow transaction there is nothing visible to say anything is happening.
 * Once the action runs this becomes one green line, which opens again on a click.
 */
export function PreflightSection({
  collapsed,
  children,
  id
}: {
  collapsed: boolean
  children: ReactNode
  id?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  // A fresh run folds it away again, whatever the user last left it as.
  useEffect(() => {
    if (collapsed) setOpen(false)
  }, [collapsed])
  if (!collapsed)
    return (
      <>
        <h2>Preflight</h2>
        {children}
      </>
    )
  return (
    <>
      <h2 className="foldhd">
        <button
          type="button"
          className="fold ok"
          id={id}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="chev">{open ? '\u25bc' : '\u25b6'}</span> Preflight passed
        </button>
      </h2>
      {open ? children : null}
    </>
  )
}

export function PlanBlock({
  label,
  text
}: {
  label: string
  text: string | null
}): React.JSX.Element | null {
  if (text === null) return null
  return (
    <div className="plan">
      <div className="lbl">{label}</div>
      <pre>{text}</pre>
    </div>
  )
}

export function Empty({
  text,
  button
}: {
  text: ReactNode
  button?: ReactNode
}): React.JSX.Element {
  return (
    <div className="empty">
      <div className="orbit" />
      <p>{text}</p>
      {button}
    </div>
  )
}

export function Mono({
  children,
  title
}: {
  children: ReactNode
  title?: string
}): React.JSX.Element {
  return (
    <span className="mono" title={title}>
      {children}
    </span>
  )
}

/** Inline busy text, as the HTA's `<span class="status busy">`. */
export function Busy({ children }: { children: ReactNode }): React.JSX.Element {
  return <span className="status busy">{children}</span>
}

export function ErrText({ children }: { children: ReactNode }): React.JSX.Element {
  return <span className="hint-err">{children}</span>
}
export function WarnText({ children }: { children: ReactNode }): React.JSX.Element {
  return <span className="hint-warn">{children}</span>
}

/** The error surface every failed signer result gets: `error` plus `detail`. */
export function errText(
  r: { error?: string; detail?: string; raw_log?: string } | null | undefined
): string {
  if (!r) return ''
  return `${r.error ?? ''} ${r.detail || r.raw_log || ''}`.trim()
}
