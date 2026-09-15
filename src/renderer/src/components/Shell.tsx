// Title bar, top bar, sidebar (owner wallet card and accordion nav), footer.
import { useEffect, useState } from 'react'
import mark from '../assets/pocket-mark-40.png'
import { useStore } from '../store'
import { fmtPokt } from '@core/format'
import { fmtPoktOrQ } from '@core/chain'
import { Badge, netLabel, Busy } from './ui'
import {
  setNetwork,
  toggleTheme,
  startDocker,
  recheckDocker,
  pullImage,
  refreshNetwork,
  refreshBalance,
  copy,
  NAV,
  navToggle,
  sectionOf,
  tab
} from '../lib/actions'
import { importDialog, revokeDialog } from '../screens/ownerDialogs'

const ICON_SUN = (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="12" cy="12" r="5" />
    <line x1="12" y1="1" x2="12" y2="3" />
    <line x1="12" y1="21" x2="12" y2="23" />
    <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
    <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
    <line x1="1" y1="12" x2="3" y2="12" />
    <line x1="21" y1="12" x2="23" y2="12" />
    <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
    <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
  </svg>
)
const ICON_MOON = (
  <svg
    width="18"
    height="18"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  </svg>
)

export function TitleBar(): React.JSX.Element {
  const [max, setMax] = useState(false)
  useEffect(() => {
    void window.psm.window.isMaximized().then(setMax)
  }, [])
  const toggle = async (): Promise<void> => setMax(await window.psm.window.toggleMaximize())
  return (
    <div id="titlebar" onDoubleClick={toggle}>
      <img src={mark} alt="" className="mark" />
      <span className="apptitle">Pocket Service Manager</span>
      <div className="wincontrols">
        <button type="button" title="Minimise" onClick={() => window.psm.window.minimize()}>
          <svg width="12" height="12" viewBox="0 0 12 12">
            <line x1="1" y1="6" x2="11" y2="6" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </button>
        <button type="button" title="Maximise or restore" onClick={toggle}>
          {max ? (
            <svg width="12" height="12" viewBox="0 0 12 12">
              <rect
                x="3.5"
                y="1.5"
                width="7"
                height="7"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              />
              <rect
                x="1.5"
                y="3.5"
                width="7"
                height="7"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 12 12">
              <rect
                x="1.5"
                y="1.5"
                width="9"
                height="9"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              />
            </svg>
          )}
        </button>
        <button
          type="button"
          className="close"
          title="Close"
          onClick={() => window.psm.window.close()}
        >
          <svg width="12" height="12" viewBox="0 0 12 12">
            <line x1="2" y1="2" x2="10" y2="10" stroke="currentColor" strokeWidth="1.5" />
            <line x1="10" y1="2" x2="2" y2="10" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </button>
      </div>
    </div>
  )
}

export function TopBar(): React.JSX.Element {
  const { net, theme, docker, dockerNote } = useStore()
  const main = net === 'main'
  let dockerCls = ''
  let dockerText: React.ReactNode = 'Docker: checking'
  if (dockerNote)
    dockerText = dockerNote.startsWith('Download failed') ? dockerNote : <Busy>{dockerNote}</Busy>
  else if (docker) {
    if (!docker.ok) {
      dockerCls = 'bad'
      dockerText = (
        <>
          Docker: {docker.error} <button onClick={() => startDocker()}>Start Docker Desktop</button>
          <button onClick={recheckDocker}>Re-check</button>
        </>
      )
    } else if (!docker.image) {
      dockerText = (
        <>
          Docker {docker.docker}, pocketd not downloaded{' '}
          <button onClick={() => pullImage()}>Download pocketd</button>
          <button onClick={recheckDocker}>Re-check</button>
        </>
      )
    } else {
      dockerCls = 'ok'
      dockerText = `Docker ${docker.docker}, pocketd ${docker.pocketd}`
    }
  }
  return (
    <>
      <div id="topbar">
        <div className="netswitch">
          <button
            id="netBeta"
            className={'net' + (main ? '' : ' on')}
            onClick={() => setNetwork('beta')}
          >
            Beta TestNet
          </button>
          <button
            id="netMain"
            className={'net' + (main ? ' on main' : '')}
            onClick={() => setNetwork('main')}
          >
            MainNet
          </button>
        </div>
        <button
          id="themeBtn"
          onClick={toggleTheme}
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {theme === 'dark' ? ICON_SUN : ICON_MOON}
        </button>
        <div id="dockerState" className={dockerCls}>
          <span className="dot" />
          <span id="dockerText">{dockerText}</span>
        </div>
      </div>
      <div id="mainnetBanner">
        MAINNET. Transactions here spend real POKT. Every action asks you to confirm.
      </div>
    </>
  )
}

export function OwnerWalletCard(): React.JSX.Element {
  const { imported, address, verified, partial, balance, params, net } = useStore()
  return (
    <div className="panel" id="walletPanel">
      <h2>Owner wallet</h2>
      {!imported ? (
        <div id="walletNone">
          <p className="hint" style={{ margin: '0 0 8px 0' }}>
            Import the private key of the wallet that will own your services and fund the rest. It
            is stored encrypted and never shown again unless you revoke it.
          </p>
          <div className="btnrow">
            <button className="btn primary" onClick={() => importDialog()}>
              Import private key
            </button>
          </div>
        </div>
      ) : (
        <div id="walletSome">
          <div
            className="addr"
            id="walletAddr"
            title="Click to copy"
            onClick={() => copy(address)}
            style={{ cursor: 'pointer' }}
          >
            {address} {!verified ? <Badge cls="muted">not verified, Docker is down</Badge> : null}
          </div>
          <div className="big">
            <span id="walletBal">
              {balance === null || balance === undefined ? '?' : fmtPokt(balance)}
            </span>
            <small>POKT</small>
          </div>
          <div className="hint" id="walletBalNote">
            balance on {netLabel(net)}
            {balance === null ? ' (could not read the network)' : ''}
          </div>
          <table className="kv" style={{ marginTop: 10 }}>
            <tbody>
              <tr>
                <td>Registration fee</td>
                <td id="pFee">{fmtPoktOrQ(params.addServiceFee)}</td>
              </tr>
              <tr>
                <td>Application min stake</td>
                <td id="pAppMin">{fmtPoktOrQ(params.appMinStake)}</td>
              </tr>
              <tr>
                <td>Supplier min stake</td>
                <td id="pSupMin">{fmtPoktOrQ(params.supMinStake)}</td>
              </tr>
            </tbody>
          </table>
          <div className="btnrow">
            <button
              className="btn small"
              onClick={() => {
                void refreshNetwork()
                void refreshBalance()
              }}
            >
              Refresh
            </button>
            <button className="btn small danger" onClick={() => revokeDialog()}>
              Revoke key
            </button>
          </div>
        </div>
      )}
      {!imported && partial ? (
        <div id="walletPartial" className="warnbox">
          Leftover wallet files were found but the key cannot be opened. Import the key again; the
          leftovers are replaced.
        </div>
      ) : null}
    </div>
  )
}

export function Nav(): React.JSX.Element {
  const { screen, navOpen } = useStore()
  const cur = sectionOf(screen)
  return (
    <div id="nav">
      {NAV.map((s) => {
        const single = s.screens.length === 1
        const active = cur.id === s.id
        const open = single ? false : navOpen[s.id] === undefined ? active : navOpen[s.id]
        return (
          <div key={s.id} className={'sec' + (open ? ' open' : '')}>
            <a
              className={'hd' + (active ? ' on' : '')}
              onClick={() => (single ? tab(s.screens[0][0]) : navToggle(s.id))}
            >
              {s.label}
              {single ? null : <span className="chev">&#9654;</span>}
            </a>
            {single ? null : (
              <div className="items">
                {s.screens.map(([id, label]) => (
                  <a
                    key={id}
                    className={'item' + (id === screen ? ' on' : '')}
                    onClick={() => tab(id)}
                  >
                    {label}
                  </a>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

export function Footer(): React.JSX.Element {
  const foot = useStore((s) => s.foot)
  return (
    <div id="footer">
      <span id="footText">{foot}</span>
    </div>
  )
}
