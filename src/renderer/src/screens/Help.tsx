// Help (docs/SCREENS.md 3.14; Electron only). A guide written for a first-time
// service owner: how a service works, what to have ready, the screens in the order
// they are used, how Claude Code helps through the local bridge, and where to go
// next. No commands, no typed-in chain values: the numbers come from the network.
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
        A Pocket service is an ordinary web API that lives in two places at once. Half of it runs on
        a server you control. The other half is a set of records on the Pocket Network chain. The
        whole job of this app is to set up both halves and connect them.
      </p>
      <h3>Off chain: the part that answers</h3>
      <p>
        Your <b>service app</b> is a program that answers HTTP requests. It runs inside a container
        on a server. Next to it runs the <b>RelayMiner</b>, a program from Pocket that receives
        requests from the network, checks that the sender is allowed to use your service, passes
        each request to your app, returns the answer, and keeps a record of the work done. The
        RelayMiner is installed for you by this app; you never configure it by hand.
      </p>
      <h3>On chain: the part that says who is who</h3>
      <p>Three records on the chain describe a service:</p>
      <ul className="checks">
        <li className="info">
          <b>The service record.</b> Its permanent ID, a display name, the price of one request, and
          a short description called the <b>service card</b> that tells other programs what the
          service does. Whoever creates this record is the <b>owner</b> and pays a one-time
          registration fee.
        </li>
        <li className="info">
          <b>An application stake.</b> A wallet that has locked some POKT for exactly one service.
          That stake is what pays for requests, a little at a time. Anyone who wants to call a
          service needs one, including you when you test your own.
        </li>
        <li className="info">
          <b>A supplier stake.</b> A wallet on the server, called the <b>operator</b>, that has
          locked POKT to promise it will serve the service at a public address. This is what lets
          the network send requests to your server, and what the network pays.
        </li>
      </ul>
      <h3>How the two halves connect</h3>
      <p>
        When a request arrives, the RelayMiner looks up the current <b>session</b> on the chain, a
        window of a fixed number of blocks during which a given application is paired with a given
        set of suppliers. If the sender's application and your supplier are in the same session, the
        request goes through to your app. At the end of the session the RelayMiner tells the chain
        how much work it did, proves it, and the payment moves from the application's stake to your
        supplier. Because sessions are fixed windows, a new stake or a changed price never takes
        effect immediately; it starts at the next session boundary. The Dashboard shows when that
        is.
      </p>
      <h3>Two roles, often one person</h3>
      <p>
        The <b>owner</b> registers the service and holds its record. The <b>supplier</b> runs a
        server that serves it. For a bespoke service these are usually the same person, and this app
        is built for that case: it walks you through both. They are still separate roles. If you
        publish your service app's code in a public repository, other people can run the same
        container behind their own RelayMiner, stake as suppliers for your service ID, and share the
        work. Your service record stays yours; you never have to hand anything over for that to
        happen.
      </p>
      <h3>The one rule your app must follow</h3>
      <div className="warnbox">
        Every answer your service app returns must be a JSON object, including error answers. The
        gateways that route traffic on Pocket judge an answer by its first character: if it is not a{' '}
        <span className="mono">{'{'}</span> or a <span className="mono">[</span>, the request counts
        as failed and your supplier is marked down. If your app produces a web page, an image, or
        plain text, wrap it inside a field of a JSON object.
      </div>
    </>
  )
}

function BeforeYouStart(): React.JSX.Element {
  const { net, params } = useStore()
  const label = netLabel(net)
  const v = (n: number | undefined): React.ReactNode =>
    n === undefined ? <span className="hint">not read yet</span> : `${fmtPokt(n)} POKT`
  return (
    <>
      <p className="welcome-lead">
        Four things, and a fifth that makes the other four easier. Have them ready and the steps in
        the next chapter go through in one sitting.
      </p>
      <h3>1. Docker Desktop on this PC</h3>
      <p>
        The Pocket tools this app uses run in containers, so Docker Desktop must be installed and
        running. The app downloads the tools once. The top bar tells you when Docker is not running
        and offers to start it.
      </p>
      <h3>2. The owner wallet, with enough POKT</h3>
      <p>
        Import the wallet that will own your service using the <b>Owner wallet</b> card on the left.
        It pays for everything below, so it needs POKT on the network you are working on. These are
        the current minimums on {label}, read from the network just now:
      </p>
      <table className="kv" style={{ maxWidth: 520 }}>
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
        Stakes are locked, not spent: you get them back after an unbonding period if you unstake. On
        top of the minimums, keep a margin for gas on each transaction, a few POKT to send to the
        operator on your server for its own gas, and a little more so a stake sits comfortably above
        the minimum. The app tells you the exact amount at each step and refuses to start a
        transaction the wallet cannot cover.
      </p>
      <div className="warnbox">
        Do the whole cycle on <b>Beta TestNet</b> first. Test POKT is free from the faucet listed
        under Resources, and nothing you do there costs real money. Switch to MainNet only when the
        Test screen shows your service answering on Beta.
      </div>
      <h3>3. Your service app</h3>
      <p>
        An HTTP API in a folder on this PC, with a <span className="mono">Dockerfile</span> in a{' '}
        <span className="mono">backend</span> subfolder so the app can build it on the server. It
        must:
      </p>
      <ul className="checks">
        <li className="info">answer every request with a JSON object, errors included;</li>
        <li className="info">
          answer <span className="mono">GET /</span> and <span className="mono">HEAD /</span> with a
          success status, so the RelayMiner can check it is alive;
        </li>
        <li className="info">
          offer a small "who are you" path, such as a version endpoint that names the service, and a
          health path; the service card points at them and the Test screen uses them;
        </li>
        <li className="info">
          need no secrets from the caller, because callers cannot send headers through the network.
        </li>
      </ul>
      <p>
        If you have not written it yet, this is the first thing to ask Claude Code for; see the
        chapter on working with Claude Code.
      </p>
      <h3>4. A server</h3>
      <p>
        A Linux server with Docker installed, that you can reach over SSH with a key file kept on
        this PC. It needs a hostname that points at it and ports 80 and 443 open, because the app
        sets up a web server there that obtains its own certificate. One server holds one supplier
        stack per network, so the same server can serve Beta TestNet and MainNet side by side. The
        app installs everything else.
      </p>
      <h3>5. Claude Code</h3>
      <p>
        Not required, but it turns the two hardest parts, writing the service app and preparing the
        server, into a conversation. Chapter 4 explains how to connect it to this app.
      </p>
    </>
  )
}

function TheSteps(): React.JSX.Element {
  return (
    <>
      <p className="welcome-lead">
        Follow the screens in this order. Each one checks what the previous one did, so you cannot
        easily skip ahead by accident. Start on Beta TestNet.
      </p>
      <ol className="welcome-steps help-steps">
        <li>
          <b>Import the owner wallet.</b> On the left, under Owner wallet, paste the private key of
          the wallet that will own the service. It goes into an encrypted keyring on this PC and is
          never shown again unless you ask.
        </li>
        <li>
          <b>Create the service.</b> <Go screen="create">Services, Create service</Go>. Give it a
          permanent ID, a name, and a price, and fill in what it does and how it answers. The screen
          writes the service card and a folder for the service; the card is what other programs read
          to discover your service, so describe it honestly.
        </li>
        <li>
          <b>Register it.</b> <Go screen="register">Services, Register service</Go>. Pick the
          folder, check the card, and press Preflight: the screen confirms the ID is free, the card
          is valid, and the wallet can pay, then shows you the exact transaction. Register puts the
          record on the chain.
        </li>
        <li>
          <b>Create and fund an application wallet.</b> <Go screen="wallets">Wallets</Go>. Press New
          app wallet for your service and write down its recovery phrase when it is shown; it
          appears once. Then Fund it from the owner wallet with the amount the dialog suggests.
        </li>
        <li>
          <b>Stake the application.</b> <Go screen="stake">Services, Stake application</Go>. This
          locks the application wallet's POKT for your service so that you, and later your users
          through a gateway, can call it. The same screen can delegate the application to a gateway,
          which lets client programs use your service without holding a stake of their own.
        </li>
        <li>
          <b>Add your server.</b> <Go screen="settings">Settings, Servers</Go>. Enter the host,
          user, and key file and press Test connection. The result tells you whether Docker is
          there.
        </li>
        <li>
          <b>Provision the supplier.</b> Still under Settings, in Provision a supplier: choose the
          server and the network, keep the suggested directory, and enter the hostname. Start
          provisioning installs the RelayMiner stack on the server, creates the operator wallet
          there (its key never leaves the server), sends it a little POKT for gas, and starts it. If
          anything interrupts the run, the button changes to Continue provisioning and picks up
          where it stopped.
        </li>
        <li>
          <b>Deploy the service.</b> <Go screen="deploy">Services, Deploy service</Go>. The app
          copies your service folder to the server, builds the container, and connects it to the
          RelayMiner. Four steps, each reported as it finishes.
        </li>
        <li>
          <b>Stake the supplier.</b> <Go screen="supply">Suppliers</Go>, then Manage on your server.
          Tick the service, keep the suggested amount, press Preflight, and then Stake supplier. The
          operator on the server signs this one. The stake takes effect at the next session
          boundary; the screen tells you when.
        </li>
        <li>
          <b>Test it.</b> <Go screen="test">Services, Test service</Go>. This sends real requests
          through the Pocket network, not straight to your server, using your application wallet.
          Each probe from the service card is graded the way a gateway would grade it. When every
          probe passes, your service is live.
        </li>
        <li>
          <b>Watch the Dashboard.</b> It shows each service's stage, the stakes and their margin
          above the minimum, the next session boundary, and alerts when something needs attention.
        </li>
      </ol>
      <h3>Then MainNet</h3>
      <p>
        Switch the network in the top bar and repeat steps 2 to 9. The registration fee and stakes
        are real POKT there, so every spend asks you to type the service ID, the wallet name, or a
        confirmation word before it runs. Your server can hold the MainNet stack next to the Beta
        one; Provision it for MainNet with its own hostname and the app keeps the two apart.
      </p>
    </>
  )
}

function WithClaude(): React.JSX.Element {
  const bridge = useStore((s) => s.bridge)
  return (
    <>
      <p className="welcome-lead">
        Claude Code can work the app for you. Turn on the <b>local action bridge</b> under{' '}
        <Go screen="settings">Settings, Claude Integration</Go>, copy the command it shows into
        Claude Code, and Claude can read what the app knows, preview any transaction, and run the
        steps in the previous chapter on your behalf.
      </p>
      <p>
        Bridge status right now:{' '}
        {bridge?.running ? (
          <Badge cls="ok">on, port {bridge.port}</Badge>
        ) : (
          <Badge cls="muted">off</Badge>
        )}
      </p>
      <h3>What stays in your hands</h3>
      <ul className="checks">
        <li className="info">
          Every spend or signature Claude asks for opens a confirmation in this window and waits for
          you. On MainNet you type the same word you would type yourself. Decline, and nothing is
          signed.
        </li>
        <li className="info">
          Claude never sees a private key or a recovery phrase. Importing, exporting, and creating
          wallets are not available over the bridge at all; those stay in this window.
        </li>
        <li className="info">
          Claude names your servers by the names you gave them in Settings; it never handles your
          SSH key.
        </li>
      </ul>
      <h3>Good things to ask for</h3>
      <ul className="checks">
        <li className="info">
          <b>"Build my service app."</b> Describe what it should do. Claude also has Pocket's
          service-builder guidance, so it knows the JSON rule, the health and version paths, and how
          to write the service card. Ask it to put the result in a folder under your services
          directory with a Dockerfile.
        </li>
        <li className="info">
          <b>"Get my server ready."</b> Installing Docker, creating an SSH key on this PC and adding
          it to the server, pointing a hostname at the server, and opening ports 80 and 443 are all
          outside this app. Claude can do or explain each one. Once the server answers to Test
          connection in Settings, this app takes over: it installs the RelayMiner and everything
          around it during Provision.
        </li>
        <li className="info">
          <b>"Walk me through registering and staking on Beta."</b> Claude can run the dry runs,
          read the preflight results, explain a red item, and start each transaction for you to
          approve.
        </li>
        <li className="info">
          <b>"Why did this probe fail?"</b> Give it the Test screen's log. The usual answer is an
          answer that was not a JSON object.
        </li>
      </ul>
    </>
  )
}

function Resources(): React.JSX.Element {
  const net = useStore((s) => s.net)
  const info = NETWORK_INFO[net]
  return (
    <>
      <p className="welcome-lead">
        Where to look things up, and the last step once your service is live on MainNet.
      </p>
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
            <td>The RelayMiner the app installs</td>
            <td>
              <Link href={LINKS.relayMiner}>{LINKS.relayMiner}</Link>
            </td>
          </tr>
          <tr>
            <td>The relay client the Test screen uses</td>
            <td>
              <Link href={LINKS.pocketAp}>{LINKS.pocketAp}</Link>
            </td>
          </tr>
        </tbody>
      </table>
      <h3>Get listed</h3>
      <p>
        When your service is registered, supplied, and passing its tests on MainNet, ask the Pocket
        Network Foundation to add it to the agentic portal, where agents and their builders find
        services to call. Send a short note with your service ID and what it does to:
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
    blurb:
      'The part on your server, the part on the chain, and how a request travels between them.',
    body: HowItWorks
  },
  {
    id: 'before',
    title: 'Before you start',
    blurb: 'Docker, a funded owner wallet, your service app, and a server.',
    body: BeforeYouStart
  },
  {
    id: 'steps',
    title: 'The steps, in order',
    blurb: 'Create, register, stake, provision, deploy, stake the supplier, test.',
    body: TheSteps
  },
  {
    id: 'claude',
    title: 'Working with Claude Code',
    blurb: 'Let Claude build the service app, prepare the server, and drive the app for you.',
    body: WithClaude
  },
  {
    id: 'resources',
    title: 'Resources',
    blurb:
      'The explorer, the faucet, the repositories, and how to get listed on the agentic portal.',
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
          A guide for putting your first service on Pocket Network with this app. Five short
          chapters; read them in order the first time.
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
