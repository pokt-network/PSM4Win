// The app: shell around one screen at a time (docs/SCREENS.md sections 1 and 6).
import { useEffect } from 'react'
import { useStore } from './store'
import { TitleBar, TopBar, OwnerWalletCard, Nav, Footer } from './components/Shell'
import { ModalHost } from './lib/modal'
import { dockerCycle, loadSettings, loadServiceFolders, tab } from './lib/actions'
import { showWelcome } from './lib/welcome'
import { offerHtaImport } from './screens/ownerDialogs'
import { DashboardScreen } from './screens/Dashboard'
import { ServicesScreen } from './screens/Services'
import { CreateScreen } from './screens/Create'
import { RegisterScreen } from './screens/Register'
import { StakeScreen } from './screens/Stake'
import { SupplyScreen } from './screens/Supply'
import { DeployScreen } from './screens/Deploy'
import { TestScreen } from './screens/Test'
import { WalletsScreen } from './screens/Wallets'
import { SettingsScreen } from './screens/Settings'

export default function App(): React.JSX.Element {
  const { net, theme, screen, epoch } = useStore()

  useEffect(() => {
    document.body.className =
      (net === 'main' ? 'net-main' : 'net-beta') + (theme === 'dark' ? ' theme-dark' : '')
  }, [net, theme])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const info = await window.psm.app.info()
      const settings = await loadSettings()
      if (cancelled) return
      useStore.setState({
        appInfo: info,
        net: settings.network === 'main' ? 'main' : 'beta',
        theme: settings.theme === 'dark' ? 'dark' : 'light',
        reg: { ...useStore.getState().reg, folder: settings.lastService ?? '' }
      })
      await loadServiceFolders()
      tab('dashboard')
      void dockerCycle(true)
      if (!settings.importedFrom) {
        const det = await window.psm.migration.detect()
        if (det.found && !det.alreadyImported) {
          offerHtaImport(det)
          return
        }
      }
      if (!settings.welcomeSeen) showWelcome()
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div id="app">
      <TitleBar />
      <TopBar />
      <div id="layout">
        <div id="side">
          <OwnerWalletCard />
          <Nav />
        </div>
        <div id="content">
          <div className="tabpane" id={'tab-' + screen} key={epoch}>
            {screen === 'dashboard' && <DashboardScreen />}
            {screen === 'services' && <ServicesScreen />}
            {screen === 'create' && <CreateScreen />}
            {screen === 'register' && <RegisterScreen />}
            {screen === 'stake' && <StakeScreen />}
            {screen === 'supply' && <SupplyScreen />}
            {screen === 'deploy' && <DeployScreen />}
            {screen === 'test' && <TestScreen />}
            {screen === 'wallets' && <WalletsScreen />}
            {screen === 'settings' && <SettingsScreen />}
          </div>
        </div>
      </div>
      <Footer />
      <ModalHost />
    </div>
  )
}
