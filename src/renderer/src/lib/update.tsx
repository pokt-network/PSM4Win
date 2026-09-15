// Renderer side of the updater: the status feed into the store and the dialog opened
// from the header link or the Settings "Check for updates" button.
import { useEffect } from 'react'
import { useStore } from '../store'
import { openModal, closeModal, setModalBody, useModal } from './modal'
import { openUrl } from './actions'
import { Busy } from '../components/ui'
import type { UpdateStatus } from '@core/update'

function installLabel(u: UpdateStatus): string {
  switch (u.installKind) {
    case 'scoop':
      return 'Update with Scoop'
    case 'installer':
      return 'Download and install'
    case 'portable':
      return 'Download'
    default:
      return 'Install'
  }
}

function installNote(u: UpdateStatus): string {
  switch (u.installKind) {
    case 'scoop':
      return 'This copy was installed with Scoop. A console window runs the update and the app closes so the files can be replaced; start it again afterwards.'
    case 'installer':
      return 'The new installer is downloaded, checked against the published checksum, and started; the app closes while it runs.'
    case 'portable':
      return 'The new portable zip is downloaded to your Downloads folder and checked against the published checksum. Close the app and replace its folder with the contents of the zip.'
    default:
      return 'This is a development build; updates are not installed here.'
  }
}

function body(u: UpdateStatus): React.JSX.Element {
  return (
    <>
      <table className="kv">
        <tbody>
          <tr>
            <td>This app</td>
            <td>{u.current}</td>
          </tr>
          <tr>
            <td>Latest release</td>
            <td>{u.latest ?? '?'}</td>
          </tr>
        </tbody>
      </table>
      {u.notes ? <pre className="update-notes">{u.notes}</pre> : null}
      <p className="hint">{installNote(u)}</p>
      {u.state === 'downloading' ? (
        <p>
          <Busy>Downloading{u.progress !== null ? ` ${Math.round(u.progress * 100)}%` : ''}</Busy>
        </p>
      ) : u.state === 'installing' ? (
        <p>
          <Busy>Starting the update</Busy>
        </p>
      ) : u.state === 'error' && u.error ? (
        <div className="dangerbox">{u.error}</div>
      ) : u.savedTo ? (
        <div className="warnbox">
          Saved to <span className="mono">{u.savedTo}</span>.
        </div>
      ) : null}
    </>
  )
}

let dialogOpen = false

function render(u: UpdateStatus): void {
  const busy = u.state === 'downloading' || u.state === 'installing'
  setModalBody(body(u), [
    { label: 'Later', onClick: closeModal, disabled: busy },
    { label: 'Release notes', onClick: () => u.url && openUrl(u.url), disabled: !u.url },
    {
      label: installLabel(u),
      cls: 'primary',
      disabled: busy || u.installKind === 'dev',
      onClick: () => void window.psm.update.install()
    }
  ])
}

export function showUpdateDialog(): void {
  const u = useStore.getState().update
  if (!u || !u.available) return
  dialogOpen = true
  openModal(`Version ${u.latest} is available`, null, [])
  render(u)
}

/** Mounted once in App: keeps the store current and the open dialog in step. */
export function UpdateHost(): null {
  useEffect(() => {
    const off = window.psm.update.onStatus((u) => {
      useStore.setState({ update: u })
      if (dialogOpen) render(u)
    })
    void window.psm.update.status().then((u) => useStore.setState({ update: u }))
    // Later, Escape, or another dialog replacing this one ends the dialog's updates.
    const unsub = useModal.subscribe((s, prev) => {
      if (!s.open && prev.open) dialogOpen = false
    })
    return () => {
      off()
      unsub()
    }
  }, [])
  return null
}
