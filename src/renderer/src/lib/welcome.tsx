// The welcome dialog (docs/SCREENS.md 1.6), text verbatim from app.js showWelcome().
import mark from '../assets/pocket-mark-40.png'
import { openModal, closeModal } from './modal'
import { saveSettings, openUrl } from './actions'
import { DOCKER_DESKTOP_URL } from '@core/versions'

export function showWelcome(): void {
  openModal(
    <>
      <img src={mark} alt="" />
      Welcome to Pocket Service Manager
    </>,
    <>
      <p className="welcome-lead">
        Pocket Service Manager takes an HTTP API from a folder on this PC to a live service on
        Pocket Network. It writes the service card, registers the service on chain, turns a server
        of yours into a supplier that serves it, stakes the supplier and an application wallet, and
        tests real relays through the protocol. Every step is a button; you never type a{' '}
        <span className="mono">pocketd</span> command.
      </p>
      <div className="welcome-cols">
        <div>
          <h4>Have these ready</h4>
          <ul className="checks">
            <li className="info">
              <b>
                <a onClick={() => openUrl(DOCKER_DESKTOP_URL)}>Docker Desktop</a>
              </b>
              , installed and running.
              <span className="sub">
                The Pocket tools run in containers here; the app downloads them once.
              </span>
            </li>
            <li className="info">
              <b>A funded owner wallet.</b>
              <span className="sub">
                The hex private key of a Pocket account holding POKT on the network you will use. It
                owns your services and pays the registration fee, the stakes, and the operator gas.
                Beta TestNet POKT comes from the faucet; MainNet spends real POKT.
              </span>
            </li>
            <li className="info">
              <b>A Linux server</b> you can reach over SSH.
              <span className="sub">
                Docker Compose installed, a public hostname whose DNS already points at it, ports 80
                and 443 open, and an OpenSSH key on this PC for the login user. One server hosts one
                supplier for any number of services.
              </span>
            </li>
            <li className="info">
              <b>Your service backend</b> in a folder with a Dockerfile.
              <span className="sub">
                Any HTTP API: it must answer <span className="mono">GET /</span> with 2xx and return
                a JSON object on every response. Anything else, HTML included, rides inside a JSON
                field.
              </span>
            </li>
            <li className="info">
              <b>Optional: Claude</b> with the pocket-service-builder Skill.
              <span className="sub">
                It can write the backend, the card, and the probes with you.
              </span>
            </li>
          </ul>
        </div>
        <div>
          <h4>The steps, in order</h4>
          <ol className="welcome-steps">
            <li>
              Pick the network and import the owner wallet.
              <span className="sub">
                Beta TestNet first; MainNet asks you to confirm every transaction.
              </span>
            </li>
            <li>
              Create the service.
              <span className="sub">The form writes the card and validates it.</span>
            </li>
            <li>Register it on chain.</li>
            <li>
              Add your server in Settings and provision it.
              <span className="sub">
                Installs the RelayMiner and creates the operator key on the server.
              </span>
            </li>
            <li>Deploy the backend to that server.</li>
            <li>
              Stake the supplier and stake an application wallet.
              <span className="sub">Both take effect at the next session boundary.</span>
            </li>
            <li>
              Test it.
              <span className="sub">
                Real relays through the protocol, graded against the card.
              </span>
            </li>
          </ol>
        </div>
      </div>
      <p className="hint welcome-note">
        Fees and minimum stakes are read live from the network; the owner wallet card shows them.
        This message is available any time from Settings.
      </p>
    </>,
    [
      {
        label: 'Close',
        cls: 'primary',
        onClick: () => {
          closeModal()
          void saveSettings({ welcomeSeen: true })
        }
      }
    ],
    'welcome'
  )
}
