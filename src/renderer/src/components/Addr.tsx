// A chain address in a table or card: shortened, the full value on hover, and a Copy
// button beside it, so any address the app shows can be pasted elsewhere.
import { shortAddr } from '@core/format'
import { copy } from '../lib/actions'

export function Addr({
  value,
  label
}: {
  value: string
  /** Shown before the address, for example a network name. */
  label?: string
}): React.JSX.Element {
  return (
    <span className="addrcopy">
      {label ? <span className="hint">{label} </span> : null}
      <span className="mono" title={value}>
        {shortAddr(value)}
      </span>
      <button
        type="button"
        className="btn small copy"
        title={`Copy ${value}`}
        onClick={(e) => {
          // Rows that open something on click must not open it here.
          e.stopPropagation()
          void copy(value)
        }}
      >
        Copy
      </button>
    </span>
  )
}
