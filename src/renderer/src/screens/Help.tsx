// Help (docs/SCREENS.md 3.14; Electron only). A short guide for a first-time
// service owner: how a service works, what to have ready, the steps in order, how
// Claude Code helps through the local bridge, and where to go next. No commands,
// no typed-in chain values: the numbers come from the network.
import { useState } from 'react'
import { useStore } from '../store'
import { fmtPokt } from '@core/format'
import { NETWORK_INFO } from '@core/networks'
import { Badge, netLabel } from '../components/ui'
import { copy, openUrl, refreshNetwork, tab } from '../lib/actions'

const FOUNDATION_EMAIL = 'directors@pokt.foundation'
const LINKS = {
  docs: 'https://docs.pocket.network',
  app: 'https://github.com/pokt-network/PSM4Win',
  poktroll: 'https://github.com/pokt-network/poktroll',
  relayMiner: 'https://github.com/pokt-network/pocket-relay-miner',
  pocketAp: 'https://github.com/pokt-network/pocket-ap'
} as const

function Link({ href, children }: { href: string; children: React.ReactNode }): React.JSX.Element {
  return <a onClick={() => openUrl(href)}>{children}</a>
}

function Go({
  screen,
  children
}: {
  screen: Parameters<typeof tab>[0]
  children: React.ReactNode
}): React.JSX.Element {
  return <a onClick={() => tab(screen)}>{children}</a>
}

// ---- chapters ----

function HowItWorks(): React.JSX.Element {
  return (
    <>
      <p className="welcome-lead">
        A Pocket service lives in two places: your server, and the chain. This app sets up both and
        connects them.
      </p>
      <h3>On your server</h3>
      <p>
        Your <b>service app</b> answers HTTP requests from inside a container. Beside it runs the{' '}
        <b>RelayMiner</b>, which takes requests from the network, hands them to your app, and
        records the work. The app installs the RelayMiner for you.
      </p>
      <h3>On the chain</h3>
      <ul className="checks">
        <li className="info">
          <b>The service record:</b> its ID, name, price per request, and a short card describing
          it. Creating it makes you the <b>owner</b>.
        </li>
        <li className="info">
          <b>An application stake:</b> a wallet that locked POKT to call the service. Requests are
          paid from it.
        </li>
        <li className="info">
          <b>A supplier stake:</b> the wallet on your server, the <b>operator</b>, that locked POKT
          to serve the service. It is what gets paid.
        </li>
      </ul>
      <h3>How they connect</h3>
      <p>
        The chain groups time into <b>sessions</b>. In each one, applications are paired with
        suppliers; a request only reaches your app when both are in the same session. At the end of
        a session the RelayMiner proves the work and payment moves from the application's stake to
        your supplier. Anything you stake or change starts at the next session, not instantly.
      </p>
      <h3>Owner and supplier</h3>
      <p>
        The owner registers the service; the supplier serves it. For your own service you are
        usually both, and this app walks you through both. If you publish your service app's code,
        others can run it behind their own RelayMiner and stake as suppliers for your service too.
      </p>
      <div className="warnbox">
        <b>The one rule:</b> every answer your app returns must be a JSON object, errors included.
        Gateways judge an answer by its first character. A page, an image, or plain text goes inside
        a field of a JSON object.
      </div>
    </>
  )
}

function BeforeYouStart(): React.JSX.Element {
  const { net, params } = useStore()
  const v = (n: number | undefined): React.ReactNode =>
    n === undefined ? <span className="hint">not read yet</span> : `${fmtPokt(n)} POKT`
  return (
    <>
      <p className="welcome-lead">
        Four things. Have them ready and the steps take about twenty minutes.
      </p>
      <h3>1. Docker Desktop, running on this PC</h3>
      <p>The Pocket tools run in containers. The top bar tells you when Docker is not running.</p>
      <h3>2. The owner wallet, with POKT</h3>
      <p>
        Import it from the <b>Owner wallet</b> card on the left. It pays for everything. The current
        minimums on {netLabel(net)}, read from the network just now:
      </p>
      <table className="kv" style={{ maxWidth: 480 }}>
        <tbody>
          <tr>
            <td>Registration fee, once per service</td>
            <td>{v(params.addServiceFee)}</td>
          </tr>
          <tr>
            <td>Application stake, minimum</td>
            <td>{v(params.appMinStake)}</td>
          </tr>
          <tr>
            <td>Supplier stake, minimum</td>
            <td>{v(params.supMinStake)}</td>
          </tr>
        </tbody>
      </table>
      <div className="btnrow">
        <button className="btn small" onClick={() => refreshNetwork()}>
          Read again
        </button>
      </div>
      <p>
        Stakes are locked, not spent. Add a margin for gas; the app tells you the exact amount at
        each step. Do everything on <b>Beta TestNet</b> first, where POKT is free from the faucet.
      </p>
      <h3>3. Your service app</h3>
      <p>
        An HTTP API in a folder on this PC with a <span className="mono">Dockerfile</span> under{' '}
        <span className="mono">backend</span>. It answers every request with a JSON object, answers{' '}
        <span className="mono">GET /</span> with success, and has a version path and a health path.
        No app yet? Ask Claude Code; see chapter 4.
      </p>
      <h3>4. A server</h3>
      <p>
        Linux with Docker, reachable over SSH with a key on this PC, a hostname pointing at it, and
        ports 80 and 443 open. The app installs the rest.
      </p>
    </>
  )
}

function TheSteps(): React.JSX.Element {
  return (
    <>
      <p className="welcome-lead">
        With the service app and server ready, this takes about twenty minutes. Do it on Beta
        TestNet first, then again on MainNet.
      </p>
      <ol className="welcome-steps help-steps">
        <li>
          <b>Import the owner wallet</b> from the card on the left.
        </li>
        <li>
          <b>Create and register the service.</b> <Go screen="create">Create service</Go> writes the
          card and folder; <Go screen="register">Register service</Go> checks it, shows the
          transaction, and puts it on the chain.
        </li>
        <li>
          <b>Stake an application.</b> On <Go screen="wallets">Wallets</Go>, make a wallet for the
          service and fund it. Then <Go screen="stake">Stake application</Go>.
        </li>
        <li>
          <b>Add and provision your server.</b> In <Go screen="settings">Settings</Go>, add the
          server and test the connection, then Start provisioning. This installs the RelayMiner,
          creates the operator wallet on the server, and starts it.
        </li>
        <li>
          <b>Deploy.</b> <Go screen="deploy">Deploy service</Go> builds your app on the server and
          connects it to the RelayMiner.
        </li>
        <li>
          <b>Stake the supplier.</b> <Go screen="supply">Suppliers</Go>, Manage, tick the service,
          Preflight, Stake. It goes live at the next session.
        </li>
        <li>
          <b>Test.</b> <Go screen="test">Test service</Go> sends real requests through the network.
          All probes green means your service is live.
        </li>
      </ol>
      <p>
        On MainNet every spend asks you to type a confirmation first. The Dashboard shows each
        service's stage and anything that needs attention.
      </p>
    </>
  )
}

function WithClaude(): React.JSX.Element {
  const bridge = useStore((s) => s.bridge)
  return (
    <>
      <p className="welcome-lead">
        Claude Code can build your service app, prepare your server, and work this app for you.
      </p>
      <p>
        Turn on the <b>local action bridge</b> under{' '}
        <Go screen="settings">Settings, Claude Integration</Go> and paste the command it shows into
        Claude Code. Status now:{' '}
        {bridge?.running ? (
          <Badge cls="ok">on, port {bridge.port}</Badge>
        ) : (
          <Badge cls="muted">off</Badge>
        )}
      </p>
      <h3>Ask it to</h3>
      <ul className="checks">
        <li className="info">
          <b>Build the service app.</b> Claude knows the JSON rule and the card format.
        </li>
        <li className="info">
          <b>Prepare the server:</b> Docker, an SSH key, the hostname, ports 80 and 443. After that
          this app does the rest.
        </li>
        <li className="info">
          <b>Run the steps</b> and explain any red preflight item or failed probe.
        </li>
      </ul>
      <h3>What stays with you</h3>
      <p>
        Every spend opens a confirmation here and waits for you; on MainNet you type the word.
        Claude never sees a key or a recovery phrase, and never handles your SSH key.
      </p>
    </>
  )
}

function Resources(): React.JSX.Element {
  const net = useStore((s) => s.net)
  const info = NETWORK_INFO[net]
  return (
    <>
      <table className="kv" style={{ maxWidth: 640 }}>
        <tbody>
          <tr>
            <td>Explorer ({netLabel(net)})</td>
            <td>
              <Link href={info.explorer}>{info.explorer}</Link>
            </td>
          </tr>
          {info.faucet ? (
            <tr>
              <td>Beta TestNet faucet</td>
              <td>
                <Link href={info.faucet}>{info.faucet}</Link>
              </td>
            </tr>
          ) : null}
          <tr>
            <td>Pocket documentation</td>
            <td>
              <Link href={LINKS.docs}>{LINKS.docs}</Link>
            </td>
          </tr>
          <tr>
            <td>This app</td>
            <td>
              <Link href={LINKS.app}>{LINKS.app}</Link>
            </td>
          </tr>
          <tr>
            <td>The protocol</td>
            <td>
              <Link href={LINKS.poktroll}>{LINKS.poktroll}</Link>
            </td>
          </tr>
          <tr>
            <td>The RelayMiner</td>
            <td>
              <Link href={LINKS.relayMiner}>{LINKS.relayMiner}</Link>
            </td>
          </tr>
          <tr>
            <td>The relay client used by Test</td>
            <td>
              <Link href={LINKS.pocketAp}>{LINKS.pocketAp}</Link>
            </td>
          </tr>
        </tbody>
      </table>
      <h3>Get listed</h3>
      <p>
        Live on MainNet? Email the Pocket Network Foundation your service ID and a line about what
        it does, and ask for it to be added to the agentic portal.
      </p>
      <div className="filerow" style={{ maxWidth: 480 }}>
        <input type="text" readOnly value={FOUNDATION_EMAIL} className="mono" />
        <button className="btn small" onClick={() => copy(FOUNDATION_EMAIL)}>
          Copy address
        </button>
      </div>
    </>
  )
}

interface Chapter {
  id: string
  title: string
  blurb: string
  body: () => React.JSX.Element
}

const CHAPTERS: Chapter[] = [
  {
    id: 'how',
    title: 'How a service works',
    blurb: 'Your server, the chain, and how a request travels between them.',
    body: HowItWorks
  },
  {
    id: 'before',
    title: 'Before you start',
    blurb: 'Docker, a funded owner wallet, your service app, a server.',
    body: BeforeYouStart
  },
  {
    id: 'steps',
    title: 'The steps',
    blurb: 'Seven steps, about twenty minutes.',
    body: TheSteps
  },
  {
    id: 'claude',
    title: 'Working with Claude Code',
    blurb: 'Let Claude build the app, prepare the server, and drive this app.',
    body: WithClaude
  },
  {
    id: 'resources',
    title: 'Resources',
    blurb: 'Explorer, faucet, repositories, and getting listed.',
    body: Resources
  }
]

export function HelpScreen(): React.JSX.Element {
  const [open, setOpen] = useState<number | null>(null)
  if (open === null) {
    return (
      <div className="panel help">
        <h2>Help</h2>
        <p className="hint" style={{ margin: '0 0 8px 0' }}>
          Your first service on Pocket Network, in five short chapters.
        </p>
        <table className="services">
          <thead>
            <tr>
              <th style={{ width: 40 }}></th>
              <th>Chapter</th>
              <th>What it covers</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {CHAPTERS.map((c, i) => (
              <tr key={c.id} style={{ cursor: 'pointer' }} onClick={() => setOpen(i)}>
                <td className="hint">{i + 1}</td>
                <td>
                  <b>{c.title}</b>
                </td>
                <td className="hint">{c.blurb}</td>
                <td>
                  <button className="btn small" onClick={() => setOpen(i)}>
                    Read
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }
  const c = CHAPTERS[open]
  const Body = c.body
  return (
    <div className="panel help">
      <div className="btnrow" style={{ marginTop: 0 }}>
        <button className="btn small" onClick={() => setOpen(null)}>
          Back to chapters
        </button>
      </div>
      <h2>
        <span className="hint">
          {open + 1} of {CHAPTERS.length}.
        </span>{' '}
        {c.title}
      </h2>
      <div className="help-body">
        <Body />
      </div>
      <div className="btnrow">
        {open > 0 ? (
          <button className="btn small" onClick={() => setOpen(open - 1)}>
            Previous: {CHAPTERS[open - 1].title}
          </button>
        ) : null}
        {open < CHAPTERS.length - 1 ? (
          <button className="btn small primary" onClick={() => setOpen(open + 1)}>
            Next: {CHAPTERS[open + 1].title}
          </button>
        ) : (
          <button className="btn small" onClick={() => setOpen(null)}>
            Back to chapters
          </button>
        )}
      </div>
    </div>
  )
}
