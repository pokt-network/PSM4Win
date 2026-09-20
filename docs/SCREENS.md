# Pocket Service Manager: screen-by-screen specification for the Electron port

Source of truth: `tools/service-manager/PocketServiceManager.hta` (markup), `tools/service-manager/app.js` (logic, ES5), `tools/service-manager/app.css` (theme), `tools/service-manager/README.md` (naming). Everything below is quoted from those files; nothing was run. Where the README's name for a screen differs from the menu label, both are given.

Conventions used in this document:

- `#id` is an element id, `.cls` a CSS class, exactly as in the HTA/CSS.
- `run("op", {...})` is a call into `signer.ps1` through `runner.cmd` (the only path that signs, touches the keyring, opens SSH, or runs Docker). The Electron port replaces the file-polling transport but must keep the operation names and payloads, since `signer.ps1` (or its successor) is the contract.
- `lcd("/path")` is an HTTPS GET against the current network's Sauron LCD base (section 5). `httpGet(url)` is a raw GET (used for reachability checks and for the LCD).
- "POKT" values in the UI are formatted from `upokt` by `fmtPokt` (divide by 1,000,000, trim trailing zeros, thousands separators). `POKT = 1000000`.
- `PARENT = "service-manager"` is the owner wallet's key name in the keyring.

---

## 1. Shell

### 1.1 Window

The HTA draws its own window. `init()` calls `window.resizeTo(1320, 900)` and centres it on `screen.availWidth/availHeight`, then `goFrameless()` (runs `winshell.ps1 -Op frameless` to strip the native frame with Win32). Minimum size enforced by the resize grip: 1000 x 680. `body` has a 1px border `#0f1316` so the frameless window has an edge. Electron replaces all of this with `frame: false` plus `-webkit-app-region: drag` on the title bar; the behaviours to keep are listed below.

| Element | Class / id | Behaviour |
|---|---|---|
| Title bar | `#titlebar` | `onmousedown` → `dragStart` (moves the window; ignored when maximised), `ondblclick` → `toggleMaximize`. Height 40px, background `#0f1316`. |
| Logo | `#titlebar img.mark` | `assets/pocket-mark-40.png`, 20x20. |
| Title | `span.apptitle` | "Pocket Service Manager". |
| Window controls | `.wincontrols` > three `button`s | Minimise (`PSM.minimize()` → `winshell("minimize")`), Maximise/restore (`toggleMaximize()`; on maximise it stores `win.restore = {x,y,w,h}` and runs `winshell("maximize")`, which fills the work area of the monitor the window is on; on restore it uses `win.restore` or the default `{x:60,y:40,w:1320,h:900}`), Close (`.close`, `window.close()`). Each has `onmousedown="PSM.stopDrag(event)"` so a click does not start a drag. Inline 12x12 SVG glyphs. Hover: bg `#26303a`; close hover bg `#ff5a5f`. |
| Resize grip | `#grip` | Bottom-right 18x18, `onmousedown` → `resizeStart`; hidden (`class="hidden"`) while maximised. |
| Footer | `#footer` > `#footText` | Single-line status strip, 26px, set by `foot(msg)`. Initial text "Starting"; becomes "Checking Docker Desktop", then "Ready" / "Docker Desktop is not running. Nothing can be signed until it is." / "Download the pocketd image once; it is about 100 MB.". Also used as the toast channel ("Copied to clipboard", "Loaded <folder>", "Wallet imported: <addr>", "Saved <path>", "Editing '<id>'. Change what you need, run preflight, and the registration becomes an update (gas only).", etc.). |

### 1.2 Top bar

`#topbar` (54px, background `#171c1f`, `border-bottom: 3px solid #025af2`; under `body.net-main` the border becomes `#ff5a5f`).

| Element | id / class | Behaviour |
|---|---|---|
| Network switch | `.netswitch` > `#netBeta.net` "Beta TestNet", `#netMain.net` "MainNet" | `onclick="PSM.setNetwork('beta'|'main')"`. The active one gets `.on`; MainNet active gets `.on.main` (coral). `applyNetworkUi()` sets `#netBeta.className = "net" + (main ? "" : " on")` and `#netMain.className = "net" + (main ? " on main" : "")`. See 4.1 for what switching does. |
| Theme toggle | `#themeBtn` | `onclick="PSM.toggleTheme()"`. `applyTheme()` sets innerHTML to `ICON_SUN` when dark (title "Switch to light mode") or `ICON_MOON` when light (title "Switch to dark mode"); both are inline 18x18 stroke SVGs (`ICON_SUN`: circle r=5 plus eight rays; `ICON_MOON`: path `M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z`). Persists `settings.theme`. |
| Docker state | `#dockerState` (class `""`, `ok`, or `bad`) > `span.dot` + `#dockerText` | Written by `dockerCycle()`. Texts: initial "Docker: checking". Not running: class `bad`, text `Docker: <r.error>` followed by two inline buttons `Start Docker Desktop` (`PSM.startDocker()`) and `Re-check` (`PSM.recheckDocker()`). Running but no image: class `""`, text `Docker <r.docker>, pocketd not downloaded` with buttons `Download pocketd` (`PSM.pullImage()`) and `Re-check`. Ready: class `ok`, text `Docker <r.docker>, pocketd <r.pocketd>`. While starting: `<span class="status busy">Starting Docker Desktop, this can take a minute</span>`; while pulling: `<span class="status busy">Downloading pocketd image</span>`; pull failure: `Download failed: <error> <detail>`. |
| MainNet banner | `#mainnetBanner` | Text "MAINNET. Transactions here spend real POKT. Every action asks you to confirm." `display:none` unless `body.net-main`. When shown, `#layout` top moves from 97px to 130px. |

Docker state machine (`dockerCycle(first, cb)`): calls `run("docker-check")`; result `{ok, error, docker, image, pocketd, pocketap, detail}`. `dockerReady()` is `docker.ok && docker.image`. While Docker is down a self-rescheduling retry runs `docker-check` every 10 s until it succeeds, then calls `dockerCycle(true)`. `startDocker()` runs `run("docker-start")` and then polls `docker-check` every 5 s up to 24 tries. `pullImage()` runs `run("image-pull")` with a 900 s timeout. On the first successful cycle (`first === true`) it calls `refreshNetwork()` and `loadHistory()`. Every cycle calls `walletStatus()`.

### 1.3 Left column

`#layout` is `position:absolute; top:97px; bottom:26px; padding:16px; display:flex`. `#side` is 330px wide (`min-width:330px`, `margin-right:16px`, `overflow-y:auto`), `#content` is `flex:1 1 auto; overflow-y:auto`.

#### Owner wallet card (`.panel#walletPanel`, heading "Owner wallet")

Three mutually exclusive bodies toggled by `walletStatus()` from `run("wallet-status")` → `{imported, address, verified, partial}`:

- `#walletNone` (shown when `!imported`): `p.hint` "Import the private key of the wallet that will own your services and fund the rest. It is stored encrypted and never shown again unless you revoke it." and `button.btn.primary` "Import private key" → `PSM.importDialog()` (section 3.13).
- `#walletSome` (shown when `imported`):
  - `.addr#walletAddr` full `pokt1...` address, `title="Click to copy"`, `onclick="PSM.copy(PSM.state.address)"`. If `!r.verified` a `span.badge.muted` "not verified, Docker is down" is appended.
  - `.big` > `#walletBal` (formatted POKT or `?`) + `<small>POKT</small>`.
  - `.hint#walletBalNote`: "balance on <network label>" plus " (could not read the network)" when the LCD read failed (`state.balance === null`).
  - `table.kv` with three rows: "Registration fee" `#pFee`, "Application min stake" `#pAppMin`, "Supplier min stake" `#pSupMin`. Filled by `refreshNetwork()` as `fmtPokt(x) + " POKT"` or `?`.
  - `.btnrow`: `button.btn.small` "Refresh" (`PSM.refreshNetwork();PSM.refreshBalance()`) and `button.btn.small.danger` "Revoke key" (`PSM.revokeDialog()`, section 3.12).
- `#walletPartial.warnbox` (shown when `!imported && partial`): "Leftover wallet files were found but the key cannot be opened. Import the key again; the leftovers are replaced."

After `wallet-status`, `walletStatus()` also calls `populateStakeSelect()` and `loadWallets(false, cb)`; the callback repaints `renderServices()`, and whichever of `renderDashboard()` / `renderWallets()` / `onTestServiceChange()` matches `state.screen`.

#### Accordion menu (`#nav`)

Rendered entirely by `renderNav()` from:

```js
var NAV = [
  { id: "dashboard", label: "Dashboard", screens: [["dashboard", "Dashboard"]] },
  { id: "services",  label: "Services",  screens: [["services","My services"],["create","Create service"],["register","Register service"],["stake","Stake application"],["deploy","Deploy service"],["test","Test service"]] },
  { id: "suppliers", label: "Suppliers", screens: [["supply","Supply service"]] },
  { id: "wallets",   label: "Wallets",   screens: [["wallets","Wallets"]] },
  { id: "settings",  label: "Settings",  screens: [["settings","Settings"]] }
];
```

Markup per section: `div.sec[.open]` > `a.hd[.on]` (label; multi-screen sections append `span.chev` "&#9654;", rotated 90° when open) > `div.items` > `a.item[.on]` per screen. A single-screen section's header is a direct link (`PSM.tab('<screen>')`); multi-screen headers call `PSM.navToggle('<sectionId>')`. `.hd.on` marks the section that contains the current screen; `.item.on` marks the current screen. `navOpen[sectionId]` remembers manual open/closed state; `tab()` forces the containing section open. Note there is no "Activity" menu entry: the README's "Activity" is the "Recent activity" panel on the Dashboard.

### 1.4 Main content area

`#content` holds one `div.tabpane#tab-<name>` per screen; `tab(name)` sets `.on` on exactly one, resets `#content.scrollTop = 0`, stores `state.screen`, and runs the screen's opener (see 4.2 for the exact per-screen calls). Valid names: `dashboard, services, create, register, stake, deploy, test, supply, wallets, settings`; anything else falls back to `dashboard`.

Layout primitives inside panes: `.panel` (white card, 14px 16px padding, 14px bottom margin), `.row` (flex, children `flex:1 1 0`, 14px gap; used for side-by-side fields), `.filerow` (flex; text input grows, trailing control fixed), `.btnrow` (12px top margin, buttons 8px apart), `label` (block, 500 weight), `.hint` (12.5px muted), `.mono`, `.big` (24px accent number), `.badge.<ok|warn|bad|info|blue|muted>`, `.kv` table, `table.services` / `table.hist`, `.empty` (centred empty state with `.orbit` graphic), `.warnbox`, `.dangerbox`, `.keybox`.

### 1.5 Modal

`#modalWrap.hidden` (full-window scrim `rgba(23,28,31,.6)`, z-index 50) > `#modal` (560px, top 18%, `border-top: 4px solid #025af2`; `.wide` = 720px; `.welcome` = 860px at top 4%) > `h3#modalTitle`, `#modalBody`, `#modalButtons`. `modal(title, bodyHtml, buttons, wide)` builds the buttons as `button.btn <cls>` with optional ids; `wide === true` → `wide`, a string → that class. `closeModal()` hides the wrap and empties the body. Only one modal at a time; a second `modal()` call replaces the content (used for two-step flows such as export → show key).

### 1.6 Welcome dialog

`showWelcome()`: shown when `settings.welcomeSeen` is falsy after init (unless in selftest mode), and from Settings → "Show Welcome Message". Modal class `welcome`; title is the logo `img` plus "Welcome to Pocket Service Manager". Body: `p.welcome-lead` (one paragraph: takes an HTTP API from a folder to a live service; every step is a button), then `.welcome-cols` with two columns: "Have these ready" (`h4` + `ul.checks` of five `li.info` items with `b` titles and `span.sub`: Docker Desktop; a funded owner wallet; a Linux server reachable over SSH; the service backend in a folder with a Dockerfile; optional Claude with the Skill) and "The steps, in order" (`h4` + `ol.welcome-steps`, seven numbered steps: pick network and import owner wallet; create the service; register it; add and provision the server; deploy the backend; stake supplier and application; test). Closing paragraph `p.hint.welcome-note` about live fees. One button "Close" (`primary`) → `closeModal(); saveSettings({welcomeSeen:true})`.

### 1.7 Status, log, checklist, plan conventions

- `status(id, msg, cls)` sets `#id.innerHTML = msg` and `className = "status " + cls` where `cls` is `""`, `ok`, `err`, or `busy`. `.status.busy` draws the spinner ring via `:before` (`psm-spin` keyframes, 0.8 s). Inline `<span class="status busy">` is also used inside hints and the Docker text.
- `logTo(id, msg, cls)` appends `<div><span class="t">HH:MM:SS</span><span class="<cls>">msg</span></div>` to `#id`, sets its class to `log` (unhiding it), and scrolls to the bottom. `cls` is `""`, `ok`, or `err`.
- `checks(id, items)` replaces `#id` (a `ul.checks`) with `<li class="<level>">text<span class="sub">sub</span></li>` per item; level is `ok`, `warn`, `fail`, or `info` (coloured dot). `hasFail(items)` gates progression.
- `.plan` blocks (`#regPlan`, `#stkPlan`, `#supPlan`, `#crPreview`) are dark boxes with a `.lbl` caption and a `pre` holding the exact signer command (and config YAML) or the card JSON.
- `clearResults()` wipes `<prefix>Checks`, `<prefix>Log`, `<prefix>Status` for prefixes `reg, stk, dep, tst, sup, prov, dlg` and hides `#btnDeployStake`/`#btnDeployTest`. Called on network switch.
- Native `alert()` is used for gate failures (no wallet, Docker not ready, clipboard) and native `confirm()` for every Beta TestNet transaction and destructive local action; the port should replace both with in-app dialogs while keeping the wording.
- Inline colour spans used in hints: `<span style="color:#b71c1c">` for validation errors and `<span style="color:#8a5a00">` for warnings.

### 1.8 Confirmation-by-typing (MainNet and destructive actions)

Every MainNet broadcast opens a modal with a `.dangerbox` explaining the real-POKT consequence, a prompt "Type **X** to confirm.", `input#mainConfirm` (`autocomplete="off"`), buttons "Cancel" and an action button `.btn.danger.solid`. The action button does nothing unless `trim($("mainConfirm").value)` equals the required token:

| Action | Token typed | Modal title |
|---|---|---|
| Register / update service | the service ID | "Confirm MainNet registration" |
| Stake application | the service ID | "Confirm MainNet stake" |
| Stake supplier | the server name | "Confirm MainNet supplier stake" |
| Fund app wallet, fund operator, provisioning top-up | `SEND` | "Confirm MainNet transfer" |
| Unstake supplier | `UNSTAKE` | "Confirm MainNet unstake" |
| Delegate / undelegate gateway | none (plain modal, `primary` button "Delegate on MainNet" / "Undelegate on MainNet") | "Confirm MainNet delegate/undelegate" |

On Beta TestNet the same actions use `confirm("... on Beta TestNet?")`, except supplier unstake which always uses a modal (button "Unstake on Beta TestNet").

Network-independent typed confirmations: Export app wallet key → `EXPORT` (`#exConfirm`); Remove app wallet → the wallet name (`#rmConfirm`); Revoke owner key → `REVOKE` (`#revConfirm`). The mnemonic dialog gates "Done" behind checkbox `#nwSaved`.

Switching to MainNet itself asks `confirm("Switch to MainNet? Transactions there spend real POKT.")`.

---

## 2. Theme

`app.css` has no CSS variables (IE11). The port should lift the values below into custom properties on `:root` with a `[data-theme="dark"]` override and a `[data-net="main"]` accent override, and keep the class names so the existing selectors continue to apply.

### 2.1 Brand palette and proposed variables

| Role | Light | Dark | Proposed variable |
|---|---|---|---|
| Brand blue (primary, links, focus, active nav, `.big`, spinner) | `#025af2` | `#025af2` (buttons); accent text becomes mint | `--brand-blue` |
| Primary hover | `#0148c2` | `#2f76f5` | `--brand-blue-hover` |
| Mint (ok badge/dot, Docker ok, dark-mode accent) | `#48e5c2` | `#48e5c2` | `--brand-mint` |
| Gold (warn) | `#ffc547` | `#ffc547` | `--brand-gold` |
| Coral (bad, danger, MainNet) | `#ff5a5f` | `#ff5a5f` | `--brand-coral` |
| Lavender (info) | `#b8b8ff` | `#b8b8ff` | `--brand-lavender` |
| Ink (text, dark surfaces) | `#171c1f` | (background) | `--ink` |
| Off-white | `#f6f6f6` | (text) | `--offwhite` |
| Danger text | `#c62b30` | `#ff8a8e` | `--danger-text` |
| Success text | `#0f8a6b` | `#48e5c2` | `--ok-text` |
| Busy text | `#025af2` | `#6fa0ff` | `--busy-text` |
| Link (dark) | `#025af2` | `#6fa0ff` | `--link` |
| Error hint (inline JS) | `#b71c1c` | (unchanged) | `--hint-error` |
| Warning hint (inline JS) | `#8a5a00` | (unchanged) | `--hint-warn` |

### 2.2 Surfaces and text

| Role | Light | Dark | Proposed variable |
|---|---|---|---|
| Page background | `#f6f6f6` | `#171c1f` | `--bg` |
| Body text | `#171c1f` | `#f6f6f6` | `--fg` |
| Muted text (`.hint`, `.kv td:first-child`, `th`, `.empty`, `.stat .l`) | `#5b6570` | `#9aa5ad` | `--fg-muted` |
| Nav item text | `#3c464f` | `#cfd6dc` | `--fg-nav` |
| Panel / nav / tile background | `#fff` | `#1e2529` | `--surface` |
| Panel / nav / tile border | `#e3e6ea` | `#2c353b` | `--border` |
| Row divider (`.kv td`, `.checks li`, table cells, `.stat`) | `#eef0f2` | `#2c353b` | `--border-soft` |
| Hover surface (nav, table `tr.link`) | `#f3f5f8` | `#26303a` | `--surface-hover` |
| Nav items background | `#fafbfc` | `#171c1f` | `--surface-nav-items` |
| Active nav background | `#eaf1ff` | `#14302b` | `--nav-active-bg` |
| Active nav text/border | `#025af2` | `#48e5c2` | `--nav-active` |
| Active nav (MainNet) text | `#c62b30` | `#ff8a8e` | `--nav-active-main` |
| Active nav (MainNet) bg | `#fff0f0` | `#2c1f21` | `--nav-active-main-bg` |
| Input background | `#fff` | `#12171a` | `--input-bg` |
| Input border | `#d3d8dd` | `#2c353b` | `--input-border` |
| Input focus border | `#025af2` | `#025af2` | `--input-focus` |
| Placeholder | `#98a2ab` | `#5f6b74` | `--placeholder` |
| Select chevron stroke (data-URI SVG) | `#025af2` | `#48e5c2` | `--select-chevron` |
| Title bar bg / text | `#0f1316` / `#f6f6f6` | same | `--titlebar-bg`, `--titlebar-fg` |
| Window control glyph / hover bg | `#cfd6dc` / `#26303a` | same | `--wincontrol-fg`, `--wincontrol-hover` |
| Top bar bg | `#171c1f` | same | `--topbar-bg` |
| Top bar accent border | `#025af2` (main `#ff5a5f`) | same | `--topbar-accent` |
| Net switch border | `rgba(255,255,255,.3)` | same | `--netswitch-border` |
| Docker dot idle / ok / bad | `#9aa5ad` / `#48e5c2` / `#ff5a5f` | same | `--dot-idle`, `--dot-ok`, `--dot-bad` |
| Docker inline button | bg `#f6f6f6`, text `#171c1f` | same | `--topbar-btn-bg` |
| Footer bg / text | `#e9ecef` / `#3c464f` | `#12171a` / `#9aa5ad` | `--footer-bg`, `--footer-fg` |
| Grip stroke | `#8b95a0` | same | `--grip` |
| Chevron / log timestamp | `#8b95a0` | same | `--fg-faint` |

### 2.3 Components

| Component | Light | Dark | Proposed variable |
|---|---|---|---|
| `.btn` bg / border / text | `#fff` / `#c6cdd3` / `#171c1f` | `#1e2529` / `#3a454d` / `#f6f6f6` | `--btn-bg`, `--btn-border`, `--btn-fg` |
| `.btn:hover` bg / border | `#eef2f7` / `#025af2` | `#26303a` / `#025af2` | `--btn-hover-bg` |
| `.btn.primary` | bg/border `#025af2`, text `#fff` | same, hover `#2f76f5` | uses `--brand-blue` |
| `.btn.danger` | bg `#fff`, border `#ff5a5f`, text `#c62b30`, hover bg `#fff0f0` | bg `#1e2529`, text `#ff8a8e`, hover `#2c1f21` | `--danger-text`, `--danger-bg-hover` |
| `.btn.danger.solid` | bg `#ff5a5f`, text `#171c1f` | same | |
| `.btn.small` | padding 4px 10px, 12.5px | | |
| `button[disabled]` | opacity .5 | | |
| `.badge.ok` | `#48e5c2` on `#0b3f34` text | same | `--badge-ok-bg`, `--badge-ok-fg` |
| `.badge.warn` | `#ffc547` / `#4a3300` | same | `--badge-warn-*` |
| `.badge.bad` | `#ff5a5f` / `#3a0d0f` | same | `--badge-bad-*` |
| `.badge.info` | `#b8b8ff` / `#23237a` | same | `--badge-info-*` |
| `.badge.blue` | `#025af2` / `#fff` | same | `--badge-blue-*` |
| `.badge.muted` | `#e3e6ea` / `#5b6570` | `#2c353b` / `#9aa5ad` | `--badge-muted-*` |
| `.checks li:before` default / ok / warn / fail / info | `#c6cdd3` / `#48e5c2` / `#ffc547` / `#ff5a5f` / `#b8b8ff` | default `#3a454d`, rest same | `--check-idle` |
| `.plan` bg / text / label / left border | `#171c1f` / `#dfe5ea` / `#8fa0ad` / `#025af2` | bg `#0f1316` | `--plan-bg`, `--plan-fg`, `--plan-label` |
| `.log` bg / border / row divider | `#f6f6f6` / `#e3e6ea` / dotted `#e3e6ea` | `#12171a` / `#2c353b` | `--log-bg` |
| `.log .t` timestamp | `#8b95a0` | same | `--fg-faint` |
| `.log .err` / `.status.err` | `#c62b30` | `#ff8a8e` | `--danger-text` |
| `.log .ok` / `.status.ok` | `#0f8a6b` | `#48e5c2` | `--ok-text` |
| `.status.busy` ring | border `#c6cdd3`, top `#025af2` | `#3a454d` / `#6fa0ff` | `--spinner-track`, `--spinner-head` |
| `.empty .orbit` | border `#b8b8ff`, dot `#025af2` | same | |
| `.stat .n`, `.tile .n`, `.big` | `#025af2` | `#48e5c2` | `--accent-number` |
| `.tile:hover` border | `#025af2` | `#48e5c2` | |
| `#modal` bg / top border / shadow | `#fff` / `#025af2` / `rgba(0,0,0,.35)` | `#1e2529` | `--modal-bg` |
| `#modalWrap` scrim | `rgba(23,28,31,.6)` | same | `--scrim` |
| `.welcome-steps li:before` | bg `#025af2`, text `#fff` | same | |
| `.keybox` | dashed border `#ff5a5f`, bg `#fff5f5` | bg `#2c1f21` | `--keybox-bg` |
| `.warnbox` | bg `#fff3d6`, border `#ffc547` | bg `#2e2710` | `--warnbox-bg` |
| `.dangerbox` | bg `#fff0f0`, border `#ff5a5f` | bg `#2c1f21` | `--dangerbox-bg` |
| Scrollbars (legacy IE props) | face `#d3d8dd`, track `#f6f6f6`, arrow `#5b6570` | face `#2c353b`, track `#171c1f`, arrow `#9aa5ad` | use `::-webkit-scrollbar` with `--scroll-thumb`, `--scroll-track` |

### 2.4 Typography and spacing

| Item | Value |
|---|---|
| Font family | `"Rubik", "Segoe UI", Tahoma, Arial, sans-serif`; `@font-face` Rubik 400/500/600 from `assets/fonts/Rubik-Regular.ttf`, `Rubik-Medium.ttf`, `Rubik-SemiBold.ttf` |
| Mono | `Consolas, "Courier New", monospace` (`code, pre, .mono, .addr, .keybox`) |
| Body | 14px / 1.45 |
| `h2` | 15px, 600, margin 0 0 10px, letter-spacing .2px |
| `h3` (modal title) | 17px, 600; welcome 19px |
| `.apptitle` | 13.5px, 500, letter-spacing .3px |
| `.hint`, `.checks li .sub`, `.stat .l/.s`, `.tile .l/.s`, `.badge`, `.plan`, `.log`, `.btn.small` | 12.5px |
| `.kv`, `table.hist`, `table.services`, `.keybox`, `#dockerState` | 13px |
| `.addr` | 12.5px mono |
| `.big`, `.stat .n` | 24px, 500; `.tile .n` 26px; `small` inside 13px 400 |
| `th` | 12px, 500, uppercase, letter-spacing .5px |
| `.plan .lbl` | 11px uppercase, letter-spacing .6px |
| Footer | 12px, line-height 26px |
| Title bar / top bar heights | 40px / 54px (+3px border) |
| `#layout` | top 97px (130px on MainNet), bottom 26px, padding 16px |
| `#side` | 330px, margin-right 16px |
| `.panel` | padding 14px 16px, margin-bottom 14px, radius 8px |
| `.row > div + div`, `.tile + .tile`, dashboard `.panel + .panel` | margin-left 14px |
| `.btn` | padding 7px 14px, radius 6px, 500 weight |
| Inputs | padding 6px 8px, radius 4px, `width:100%`; `select` padding-right 30px with the chevron at `right 10px center`; `textarea` min-height 60px, vertical resize |
| `label` | block, 500, margin 12px 0 4px (first child 0) |
| `.badge` | padding 4px 12px, radius 6px |
| `.checks li` | padding 6px 8px 6px 30px; dot 14px at left 8px |
| `.log` | max-height 260px, padding 10px 12px, radius 8px |
| `.plan` | padding 10px 12px, radius 8px, left border 3px |
| `.empty` | padding 36px 16px; `.orbit` 64px circle with a 14px dot |
| `#modal` | padding 20px 22px, radius 10px; `#modalButtons` right-aligned, 18px top margin, buttons 8px apart |
| `.wincontrols button` | 46x40 |
| `#themeBtn` | 38x38, radius 9px, 14px left margin |
| `.netswitch button` | padding 7px 16px, opacity .7 (1 when `.on`) |
| Grip | 18x18 |

State classes to keep: `body.net-beta` / `body.net-main`, `body.theme-dark`, `.hidden` (`display:none !important`), `.on` (nav, tabpane, net buttons), `.open` (nav section), `.busy/.ok/.err` (status), `.ok/.warn/.fail/.info` (checks), `#dockerState.ok/.bad`, `#modal.wide/.welcome`, `tr.link`, `td.actions`, `.svcid`.

---

## 3. Screens

### 3.1 Dashboard

**Purpose.** Overview counters, chain timing, per-service health of application stakes, per-server supplier health, and the transaction history. README name: "Dashboard" (its "Activity" section is the "Recent activity" panel here).

**Panel.** `#tab-dashboard.tabpane` (opens with `.on` by default in the markup; `init()` calls `tab("dashboard")`).

**Layout.** A `.row` with two panels (Overview, Chain), then three full-width panels (Services, Suppliers, Recent activity).

**Overview panel.** `h2` "Overview" + `span.badge#dashNetBadge` (network label; class `badge info` on Beta, `badge bad` on MainNet). `#dashStats` is filled by `renderDashboard()` with three `.stat` rows (each clickable):

| Row | Number | Label | Sub-line | Click |
|---|---|---|---|---|
| 1 | `ownedServices().length` or `?` when no wallet | "Services owned on <net>" | | `PSM.tab('services')` |
| 2 | `staked` + `<small>of <withOp> server(s)</small>` | "Suppliers staked" | "<supStaked> POKT staked" when > 0 | `PSM.tab('supply')` |
| 3 | `state.wallets.length` | "App wallets" | "<appStaked> POKT in application stakes" when > 0 | `PSM.tab('wallets')` |

where `staked` counts servers whose supplier record exists, `withOp` counts servers whose stack state is `ready`, `supStaked` sums `rec.stake.amount`, and `appStaked` sums `appRecordOf(wallet.address).stake.amount` across `state.wallets`.

**Chain panel.** `table.kv`: "Block height" `#dHeight` (`fmtInt(p.height)`), "Block time" `#dBlockTime` (`p.blockTime.toFixed(1) + " s (measured over 1,000 blocks)"`), "Session" `#dSession` (`p.blocksPerSession + " blocks"` plus `(~<duration>)`), "Next session" `#dNext` (`"height " + ns.height + ", in " + ns.blocks + " block(s)" + (~duration)`). `nextSessionBoundary()` = `a + ceil((h - a + 1)/n) * n` with `a = session_grid_anchor_height`, `n = num_blocks_per_session`. Hint "New suppliers, stakes, and price changes take effect at the next session boundary." Below: bold hint "Services directory" and `#dashServicesDir` from `renderServicesDir()`: (a) settings has `servicesRoot` and it exists → `<span class="mono">path</span>` + "N service folder(s). Open folder or change it in Settings." (links `PSM.openServicesFolder()` and `PSM.tab('settings')`); (b) using the built-in default → path + "Not chosen in Settings, so the app is using its built-in default, the repository's services folder. Choose a folder in Settings to make it explicit."; (c) neither exists → "No directory set. Select it in Settings."

**Services panel.** `h2` "Services", hint about margin, `#dashServices` from `renderDashboardServices()`:
- No wallet: "Import the owner wallet to see its services."
- No owned services: "No services owned on <net> yet. Create one." (link → `tab('create')`).
- Otherwise an optional `.dangerbox` of alerts (joined by `<br>`) followed by `table.services` with columns Service, Supply, Application stake, Margin above minimum, Actions:
  - Service: `.svcid` id + `.hint` name.
  - Supply (`supplyStatusMap()[id]`): `badge ok` "active" + `.hint` server name; `badge warn` "pending" + "from block <activation_height>"; else `badge muted` "no supplier of yours".
  - Application stake (`appStakesByService()[id]`, one line per holder): `"<name>: <stake> POKT"` + `badge bad` "unbonding" when unbonding; `badge muted` "none" when empty.
  - Margin: per holder `badge <cls>` where `margin = stake - appMinStake`, `per = costPerRelayUpokt(cupr)`, `relays = floor(margin / per)`; `cls` is `bad` if unbonding or `margin <= 0`, `warn` if `margin < min * 0.05`, else `ok`; text "stops at block N" / "below minimum" / "<margin> POKT" plus `.hint` "about <relays> relays before the minimum". Empty: "Stake an application to call the service."
  - Actions: `button.btn.small[.primary when no stake]` "Restake" / "Stake application" → `PSM.svcStake(id)`.
  - Alerts: unbonding → "<b>name</b> (id) is unbonding; its stake stops at block N. Restake it now to cancel that and keep its delegations."; `margin <= 0` → "... is at or below the minimum stake and will be unstaked at the session end. Restake it with a margin."; `margin < 5%` → "... has only X POKT of margin left, about N relays. Top the stake up soon."

**Suppliers panel.** `h2` "Suppliers", hint "One per configured server. Click a row to manage that supplier.", `#dashSuppliers`: no servers → "No server is configured. Add one under Settings." (link). Otherwise `table.services` with columns Server, Status, Services, Operator gas, URL; each `tr.link` `onclick` → `PSM.openSupplier('<name>')` when the stack state is `ready`, else `PSM.tab('supply')`. Cells: Server = `.svcid` name + `.hint.mono` short operator (or "no <net> stack"); Status = `supplierStatusCell(x)` (see 3.6); Services = comma-joined `supplierServiceIds(rec)` or "none"; Operator gas = `?` / `badge warn` when `< 2 POKT` / plain POKT; URL = `badge ok` "answers" / `badge bad` "no answer" / "none".

**Recent activity panel.** `h2` "Recent activity", hint "Every transaction this machine broadcast, on either network, newest first.", `#histWrap > table.hist#histTable` filled by `loadHistory()` (section 3.11), `.btnrow` "Refresh" → `PSM.renderDashboard(true)`.

**Buttons and data flow.** `renderDashboard(refresh)`: if `refresh` → `refreshNetwork(); refreshBalance()`. Then badge, stats, `renderChain()`, `renderServicesDir()`, `renderDashboardServices()`, suppliers table, `loadHistory()`. Reads live: `appRecordOf` for every wallet (`/pokt-network/poktroll/application/application/{addr}`), `supplierRows()` (supplier record per provisioned server via `/pokt-network/poktroll/supplier/supplier/{operator}`, operator balance via `/cosmos/bank/v1beta1/balances/{operator}`, and `httpGet(stack.url)` reachability), `supplyStatusMap()`, `run("history")`.

**Edge states.** All in the text above; note the dashboard renders synchronously and blocks while each LCD call completes (the port should make these concurrent).

**MainNet-only.** Badge turns `bad` (coral). No other difference.

### 3.2 My services

**Purpose.** The owner wallet's services on the selected network merged with local service folders, with lifecycle status and per-row actions. README: "My services".

**Panel.** `#tab-services.tabpane` > `.panel` with `h2` "My services" + `span.badge#svcNetBadge`, `.hint#svcListHint`, `#svcList`, `.btnrow` with "Refresh" (`PSM.renderServices(true)`) and `.primary` "Create service" (`PSM.tab('create')`).

**Hint text.** No wallet: "Import the wallet to see which services it owns on the network. Folders on this machine are listed below."; otherwise "Services this wallet owns on <net>, plus service folders on this machine that are not registered there yet."

**Rows.** `renderServices()` builds rows from `ownedServices()` (catalog entries with `owner_address === state.address`) then appends `localServices()` entries not already present; a local entry whose id exists in the catalog under another owner gets `taken = <catalog entry>`. Each row: `{id, name, cupr, chain, taken, local, stake}`.

**Table.** `table.services`, columns Service, Name, Price, Status on <net>, App stake, Actions:
- Service: `.svcid` id.
- Price: `"<cupr> CU"` + `.hint` `"<u> uPOKT/relay"` where `u = costPerRelayUpokt(cupr) = cupr * compute_units_to_tokens_multiplier / compute_unit_cost_granularity` (blank when params not loaded).
- Status (lifecycle created → registered → pending → active):
  - not on chain: `badge bad` "ID taken by another owner" if `taken`, else `badge muted` "created" + `.hint` "not registered here";
  - supply active: `badge ok` "active" + `.hint` "served by <server>" + (when the local manifest has no `networks.<net>.deployed_at`) a `#8a5a00` hint "not deployed from this machine on <net>";
  - supply pending: `badge warn` "pending" + `.hint` "<server> serves it from <activationNote>";
  - else `badge info` "registered" + `.hint` "no supplier of yours serves it";
  - plus `badge warn` "no card" when the local folder has no card file.
- App stake: total POKT across holders, plus `badge warn` "unbonding" and `.hint` "stops at block N; restake to cancel"; or "none".
- Actions: on-chain rows get "Update" (`svcUpdate(id)`), "Stake"/"Restake" (`svcStake(id)`), "Deploy" (`svcDeploy(id)`, only when `<folder>/backend/Dockerfile` exists), "Supply" (`svcSupply(id)`), "Test" (`svcTest(id)`); local-only rows not taken get `.primary` "Register" (`svcRegister(folder)`); any row with a local folder gets "Edit card" (`svcEdit(folder)`).

**Empty state.** `.empty` with `.orbit`, "No services yet on <net> and no service folders on this machine.", `.btn.primary` "Create your first service" → `tab('create')`.

**Row action targets.**
- `svcUpdate(id)`: if a local folder matches, selects it in `#svcFolder` and calls `onServiceFolder()`; else clears the folder and fills `#svcId`, `#svcName`, `#svcCupr` from the catalog entry and blanks `#svcCard`; then `tab("register")` and a footer note about update = gas only.
- `svcRegister(folder)`: selects folder, `onServiceFolder()`, `tab("register")`.
- `svcStake(id)`: `populateStakeSelect()`, sets `#stkId`, `tab("stake")`, `onStakeServiceChange()`.
- `svcEdit(folder)`: sets `#crFolder`, `loadCreateFromFolder()`, `tab("create")`.
- `svcDeploy(id)`: `tab("deploy")`, sets `#depId`, `onDeployServiceChange()`.
- `svcTest(id)`: `tab("test")`, sets `#tstId`, `onTestServiceChange()`.
- `svcSupply(id)`: no servers → `tab("settings")` + footer "Add a server first; a supplier lives on a server."; else `openSupplier(settings.supplierServer || servers[0].name, id)`.

**Refresh.** `renderServices(true)` calls `refreshNetwork()` and `refreshBalance()` and returns; `refreshNetwork()` → `loadCatalog()` → `renderServices()` repaints.

**Live reads.** Catalog (`/pokt-network/poktroll/service/service?pagination.limit=2000`), `appStakesByService()` (application record per wallet), `supplyStatusMap()` (supplier record per provisioned server). Local: every `<servicesRoot>/<folder>/service.json` and the existence of `card.json` and `backend/Dockerfile`.

### 3.3 Create service

**Purpose.** A form that writes `services/<id>/card.json` (the on-chain card, following the Skill's `templates/card.json` and `card-authoring.md`) and `service.json`, validates the card with the Skill's `validate_card.py`, and hands the folder to Register. README: "Create service".

**Panel.** `#tab-create.tabpane` with five `.panel`s: "Service definition", "Interface", "Serving (what a supplier runs)", "Health checks (gateways run these every cycle)", and the action panel.

**Inputs.**

| id | Label | Type / default | Notes |
|---|---|---|---|
| `#crFolder` | Load an existing folder (optional) | `select`, first option "Start from scratch"; options = subfolder names of the services root (`loadServiceFolders()`) | `onchange` → `loadCreateFromFolder()` |
| `#crId` | Service ID | text, `maxlength=42`, placeholder "example-charts" | `onkeyup/onchange` → `onCreateIdChange()`; hint `#crIdHint` |
| `#crName` | Display name | text, `maxlength=169`, placeholder "Example Charts" | |
| `#crCupr` | Compute units per relay | number, min 1, max 1048576, value 100 | |
| `#crDesc` | Description | textarea rows 4, `maxlength=2048` | hint restates the JSON envelope rule |
| `#crRpc` | Protocol | select: `REST` (default, "REST (HTTP with JSON bodies)"), `JSON_RPC`, `WEBSOCKET`, `GRPC`, `COMET_BFT` | `onchange` → `onCreateIdChange()` |
| `#crHint` | Backend hint | text, `maxlength=256` | auto-filled; `onkeyup` → `markManual('hint')` |
| `#crEndpoints` | Endpoints a caller can rely on | text, `maxlength=512` | |
| `#crApis` | API contract names | text, placeholder "example-charts-api" | auto-filled; `markManual('apis')`; comma-separated |
| `#crAccess` | Access | select `public` (default) / `gated` | |
| `#crResults` | Results | select `deterministic` (default) / `variable` | |
| `#crSpecUrl` | API spec URL (optional) | text | |
| `#crSpecKind` | Spec kind | select `openapi` (default), `openrpc`, `markdown`, `docs` | |
| `#crDocs` | Public docs URL (optional) | text | |
| `#crBackend` | Backend description | textarea rows 3, `maxlength=1024` | |
| `#crImpl` | Implementations | text, placeholder "example-charts >= 1.0" | auto-filled; `markManual('impl')`; comma-separated |
| `#crDisk` | Minimum disk (GB) | number, min 0, value 1 | |
| `#crRam` | Minimum RAM (GB) | number, min 0, value 1 | |
| `#crOpDocs` | Operator docs URL (optional) | text | |
| `#crServingNotes` | Operator notes (optional) | text, `maxlength=2048` | |
| `#crIdPath` / `#crIdJson` / `#crIdMatch` | Identity probe path / JSON path / Must match | text; defaults `/v1/version`, `$.service`, (auto `^<id>$`) | `#crIdMatch` `markManual('idMatch')` |
| `#crRdPath` / `#crRdJson` / `#crRdMatch` | Readiness probe path / JSON path / Must match | text; defaults `/healthz`, `$.status`, `^ok$` | |
| `#crFnPath` / `#crFnMethod` / `#crFnJson` / `#crFnMatch` | Functional probe path (optional) / Method / JSON path / Must match | text; select `POST` (default) / `GET`; text; text | |
| `#crFnBody` | Functional probe request body (JSON, for POST) | textarea rows 3, class `mono` | |

**Auto-derivation (`onCreateIdChange`).** Validates the id with `/^[A-Za-z0-9_-]{1,42}$/`. `#crIdHint`: empty → default text; valid but not lowercase → `#8a5a00` "Allowed, but lowercase is the convention."; valid → "Folder will be services\<id>"; invalid → `#b71c1c` "Only letters, digits, hyphen, underscore; 1 to 42 characters.". When valid and the field is still automatic (`crAuto = {apis, hint, impl, idMatch}` all `true` until `markManual`): `#crApis = id + "-api"`, `#crHint = id + " HTTP server on :8080; mount at /"` for REST or `id + " " + rpc + " server on :8080"` otherwise, `#crImpl = id + " >= 1.0"`, `#crIdMatch = "^" + id + "$"`. Loading a folder sets all four flags to `false`.

**Validation (`validateCreate`).** Produces checklist items into `#crChecks`; any `fail` blocks:
- fail: id invalid; name not `/^[A-Za-z0-9 _-]{1,169}$/`; cupr not 1..1,048,576; description empty; description > 2048; hint > 256; endpoints > 512; no API name; API name not `/^[a-z0-9]+(-[a-z0-9]+)*$/` or > 128; spec/docs/opDocs URL not `^https?://\S+$`; backend > 1024; serving notes > 2048; disk/ram not >= 0; identity or readiness probe with a path but path not starting `/`, JSON path not starting `$`, or empty regex; functional probe with path but bad path/JSON path/regex, or POST body not valid JSON (sub = parser message).
- warn: no endpoints line; no spec URL; no backend description; identity/readiness probe with no path ("... is omitted").
- info: no functional probe.

**Card builder (`buildCard`).** Maps the form to the Skill's card shape:

```
schema: "pocket-service-card/v1"
description: desc
rpc_types: [{ type: rpc, intent: "expected", backend_hint?: hint, notes?: endpoints }]
apis: [..]
specs?: [{ kind: specKind, api: apis[0], url: specUrl }]        // only when specUrl given
access, results
serving: { backend?, implementations?, docs? (opDocs), min_disk_gb, min_ram_gb,
           healthcheck?: [identity(GET), readiness(GET), functional(method, body)],
           notes: servingNotes + " Gateway operators: configure as type passthrough with rpc_types [\"<rpc lowercase>\"]." }
docs?: docs
updated: YYYY-MM-DD (today)
```

Each probe is `{ rpc_type, request: { path, method, body? }, expect: { json_path, matches }, notes }` with fixed notes "Identity probe: pins the backend to this service so a wrong backend cannot be staked under this id.", "Readiness probe.", "Functional probe with a deterministic expected value.". The notes strings are load-bearing: `loadCreateFromFolder` and `testProbes` classify probes by searching them for "identity" / "readiness".

**Buttons.**
- "Preview card" → `previewCard()`: validate, render checks, on success write `JSON.stringify(card, null, 2)` into `#crPreviewJson` inside `#crPreview.plan` (label "card.json") and status "Card is N bytes (under/over the 4 KiB target...)" (`ok` if <= 4096, else `err`).
- `.primary` "Create folder and card" → `createService()`: validate; `ensureDir(servicesRoot)`; if `card.json` exists ask `confirm("services\\<id>\\card.json already exists. Overwrite it with this form?")` (decline → status "Left the existing card alone."); write `card.json` (+ trailing newline); merge into `service.json` (`service_id`, `name`, `compute_units_per_relay`, `card: "card.json"`, `networks: existing || {}`); push an `ok` check "Wrote <path> (N bytes) and service.json."; show preview; status busy "Validating the card with the Skill's validate_card.py"; `run("validate-card", { card_path, script: <skillScripts>/validate_card.py })` → result `{ok, skipped, reason, output}` appended as `info` (skipped) / `ok` / `fail` with `<pre>` output; then `loadServiceFolders()`, `#svcFolder = id`, `onServiceFolder()` (which also persists `lastService`), and status "Service folder created. The Register tab is ready with it selected." (ok) or "Folder created, but fix the card before registering." (err).

**Load from folder (`loadCreateFromFolder`).** Reads `card.json` and `service.json`; invalid card JSON → status err. Reverse-maps every field (id from `service_id || folder`, cupr default 100, `rpc_types[0].type/backend_hint/notes`, `apis` joined with ", ", `specs[0].url/kind`, `docs`, `serving.backend/implementations/min_disk_gb (default 1)/min_ram_gb (default 1)/docs`, `serving.notes` with the trailing "Gateway operators: configure as type passthrough..." sentence stripped by regex, and the healthcheck array classified: first probe whose notes contain "identity" → identity; first whose notes contain "readiness" or whose `expect.matches === "^ok$"` → readiness; first remaining → functional (body re-serialised with `JSON.stringify`). Then `onCreateIdChange()` and status "Loaded <folder>. Edit and press Create to rewrite its card."

**Electron deviations (by design).** Loading a card that lacks `access`, `results`, or `specs` resets those selects to the form defaults instead of keeping the previous form's values, and a manifest with `compute_units_per_relay: 0` keeps 0 rather than falling back to 100. "Edit card" from My services keeps the parse error visible when `card.json` is invalid instead of overwriting it with the "Loaded" status.

**Status area.** `.status#crStatus`, `ul.checks#crChecks`, `.plan.hidden#crPreview` > `.lbl` "card.json" + `pre#crPreviewJson`.

**Files.** Reads/writes `<servicesRoot>/<id>/card.json` and `service.json`; reads `<repo>/skills/pocket-service-builder/scripts/validate_card.py` through the signer.

**Network.** Not network-specific; no LCD reads.

### 3.4 Register service

**Purpose.** Register (or update) a service on chain with `pocketd tx service add-service`, after a preflight. README: "Register service".

**Panel.** `#tab-register.tabpane` > `.panel` "Register a service" and `.panel.hidden#regResults` "Preflight".

**Inputs.**

| id | Label | Type / default | Live behaviour |
|---|---|---|---|
| `#svcFolder` | Service folder | select, first option "Choose a folder in services/" | `onchange` → `onServiceFolder()`: saves `settings.lastService`, fills `#svcId` (manifest `service_id` or folder name if empty), `#svcName`, `#svcCupr`, `#svcCard` (manifest `card` path resolved under the folder, else `card.json` if it exists), `#stkAmount` from `application_stake_pokt`, `#stkId` from `service_id`; then `onIdChange(); onCuprChange()`; footer "Loaded <folder>" (+ " (no service.json yet; save one from the form)"). Restored on init from `settings.lastService`. |
| `#svcId` | Service ID | text, `maxlength=42` | `onkeyup` → `onIdChange()`: hint `#svcIdHint` as in Create ("Looks valid. Preflight checks the catalog." when valid lowercase). |
| `#svcName` | Display name | text, `maxlength=169` | |
| `#svcCupr` | Compute units per relay | number 1..1048576, value 100 | `onkeyup/onchange` → `onCuprChange()`: `#cuprHint` = `#b71c1c` "Must be a whole number from 1 to 1,048,576." / "Sets the price of one relay. Fetch the network to see the cost." / "One relay costs <u> uPOKT (<u/1e6> POKT) at today's multiplier on <net>." |
| `#svcCard` | Service card (JSON file) | text path, in a `.filerow` with `input[type=file]#svcCardBrowse` | `onCardBrowse(input)`: if the value contains "fakepath" or the file does not exist → footer "The browser control hid the full path. Type or paste the card path instead."; else copies the path. The port should use a native open-file dialog. |

**Buttons.**
- "Check card" → `validateCardOnly()`: shows `#regResults`, hides plan/log, runs `cardChecks(path, items)` (no path → warn "No service card given."; missing → fail; size > 262,144 → fail "Card is N bytes; the chain limit is 262,144."; invalid JSON → fail; not an object → fail; ok/warn "Card parses; N bytes." with warn when > 4096; warn when `card.service_id` differs from `#svcId`), then if no fail runs `run("validate-card", ...)` and appends the result.
- "Save to service.json" → `saveManifest()`: needs `#svcFolder` (else `alert`); merges `service_id`, `name`, `compute_units_per_relay`, `card` (made relative to the folder when inside it), `application_stake_pokt` (from `#stkAmount` when > 0), `networks`; footer "Saved <path>".
- `.primary` "Run preflight" → `preflightRegister()`.
- `.primary#btnRegister` (disabled until preflight passes; label `"Register on " + NET[net].label`) → `executeRegister()`.

**Preflight sequence (`preflightRegister(rechecked)`).**
1. Show `#regResults`, hide `#regPlan`/`#regLog`, clear `#regStatus`, `regPlanOk = false`, disable `#btnRegister`.
2. If Docker not ready and not yet rechecked: status busy "Checking Docker Desktop and the pocketd image", `dockerCycle(false, → preflightRegister(true))`.
3. Fail items: no wallet; Docker/image missing (text depends on which); id/name/cupr invalid. Stop on fail.
4. `refreshNetwork(); refreshBalance()`. Fail if `addServiceFee` undefined.
5. `lcd("/pokt-network/poktroll/service/service/" + encodeURIComponent(id))`: 200 and `owner_address === state.address` → warn "... already exists and this wallet owns it. This will be an UPDATE." (sets `update = true`); 200 other owner → fail "already taken by another owner"; 404 → ok "is free on <net>"; else fail "Could not check the catalog (HTTP N)".
6. Catalog near-collisions: any other entry whose id lowercased with `-`/`_` removed equals ours → warn; same lowercased name → warn.
7. `cardChecks()`.
8. Money: `fee = update ? 0 : addServiceFee`, margin 1 POKT; fail if balance unreadable or `< fee + 1 POKT`; else ok with sub "Fee read live from the <net> service module."; info "Price: N CU/relay = u uPOKT per relay at today's multiplier."
9. On any fail: render checks, status err "Fix the red items and run preflight again."
10. Status busy "Validating the card and building the plan"; if a card is given run `validate-card` first (fail stops with "Fix the card and run preflight again."); then `run("tx-add-service", { network, service_id, name, compute_units_per_relay, card_path, dry: true })` → `{ok, command}`; show `#regPlan` with `#regPlanCmd = r.command`; set `regPlanOk = true`, `regUpdate`, `regForm`; enable `#btnRegister`; status ok "Preflight passed. Review the plan, then press <button label>."

**Execute (`executeRegister`).** Refuses if the form changed since preflight (status err, button disabled). Confirmation: MainNet modal (type the service ID; dangerbox states the fee or "gas for the update") or Beta `confirm`. Then: `busy = true`, log "Signing and broadcasting add-service for '<id>' on <net>", status busy "Waiting for pocketd (simulating gas, signing, broadcasting)", `run("tx-add-service", {...no dry})` → `{ok, txhash, gas, error, detail, raw_log}`; log "Accepted into the mempool. Tx <link> (gas estimate N)"; status busy "Waiting for the transaction to be included in a block"; `pollTx(txhash)`; on success log ok "Included in block N.", read the service back (`/pokt-network/poktroll/service/service/{id}`); if owner matches log ok "Verified on chain: '<name>', N CU/relay, owner <addr>.", status ok "Service '<id>' is registered on <net>.", `recordManifest(update ? "last_update_tx" : "register_tx", txhash)`, set `#stkId = id`; else log err "The transaction succeeded but the service could not be read back yet..." and status ok "Registered, verification pending." Finally `refreshBalance(); loadCatalog(); loadHistory()`. Failure paths log the error and status "Registration failed. Nothing was charged unless a tx hash is shown above." / "The transaction did not succeed."

**Results area.** `#regChecks`, `#regPlan` (label "Exact command the signer will run (the passphrase never touches the command line)"), `#regStatus`, `#regLog`.

**Files.** `service.json` (`networks.<net>.register_tx` / `last_update_tx`), `settings.lastService`.

### 3.5 Stake application (with Gateway delegation)

**Purpose.** Stake a wallet as an application for one service, fund that wallet from the owner, and manage gateway delegations. README: "Stake application" and "Gateway delegation".

**Panel.** `#tab-stake.tabpane` > `.panel` "Application stake", `.panel.hidden#stkResults` "Preflight", `.panel#dlgPanel` "Gateway delegation".

**Inputs.**

| id | Label | Type / default | Live behaviour |
|---|---|---|---|
| `#stkAppBox` | (warnbox above the form) | `.warnbox.hidden` | Shown by `onStakeFromChange()` when the selected wallet's application record has `unstake_session_end_height > 0`: "<b>name is unbonding.</b> Its application stake of X POKT fell below the minimum of M POKT as relays settled, so the protocol unstaked it / is being returned; the session it stops at ends at block N (~eta). <b>Staking again cancels the unbonding</b> and keeps its delegations: ..." and bumps `#stkAmount` to `max(suggestedAppStake, currentStake + 10% of min)` when the field is not already higher. |
| `#stkId` | Service | select; empty text "No registered services for this wallet on <net>" | `populateStakeSelect()` lists `ownedServices()` as `"<id> (<name>)"`, keeps the current selection. `onchange` → `onStakeServiceChange()`: preselects `#stkFrom` to `walletForService(id)` (the app wallet whose `service_id` matches), fills `#stkAmount` with the suggested stake when empty, then `onStakeFromChange()`. |
| `#stkFrom` | Stake as | select; first option "Owner wallet (service-manager)" then each app wallet as `"<name> (for <service_id>)"` or `"(unassigned)"` | `onchange` → `onStakeFromChange()`: `#stkFromHint` = owner → "The owner wallet can hold only one application stake. Create an app wallet for <id> instead." (link → `newWalletDialog()`); wallet made for another service → `#8a5a00` "<name> was made for X; staking it here re-points it to Y."; else "Signs and holds the stake. Address <short>."; then the unbonding box and `refreshStakeFromBalance()`. |
| `#stkAmount` | Stake amount (POKT) | number, min 0, step 1, placeholder set to `suggestedAppStake()/1e6` | Hint `#stkHint` from `refreshNetwork()`: "Minimum on <net> right now: M POKT. Stake above it; suggested S POKT." where `suggestedAppStake() = ceil(min * 1.1 / 1e6) * 1e6` (live minimum plus 10%, rounded up to a whole POKT). |
| `#stkFromBal` | Staking wallet balance | `.big` | `refreshStakeFromBalance()`: balance of the staking wallet; `#stkFromBalHint` = "Could not read the balance." / "The owner wallet pays from its own balance." / "Enough for X POKT of stake plus gas." / "Needs about X POKT more to cover the stake plus gas." (and prefills `#stkFundAmount` with `ceil(need - bal)`), where `need = max(0, stake - currentStake) + 1 POKT`. |
| `#stkFundAmount` + button "Send from owner" | Fund it from the owner wallet | number in a `.filerow` | `fundStakeWallet()` → `fundWallet(name, upokt, "stkFundStatus", cb)`; owner selected → status err "Pick an application wallet under 'Stake as'; the owner wallet does not fund itself." On success clears the amount and refreshes the balance. Status in `#stkFundStatus`. |

**Buttons.** `.primary` "Run preflight" → `preflightStake()`; `.primary#btnStake` (disabled; label "Stake on <net>") → `executeStake()`.

**Preflight (`preflightStake`).** Docker recheck as in Register. Fail items: no wallet; no staking wallet; Docker; id invalid; amount not > 0. Then `refreshNetwork(); refreshBalance()`; `upokt = round(pokt * 1e6)`; warn if staking the owner wallet ("It can hold only one application stake...") else ok "Staking as app wallet '<name>' (<addr>)." (+ re-point note); fail if `appMinStake` unreadable, `upokt < min` ("below the minimum"), or `upokt < min * 1.01` ("has no margin above the minimum", sub "Stake at least S POKT."); else ok "... is X POKT above the live minimum ...". Service must exist (`/pokt-network/poktroll/service/service/{id}`: 200 ok, 404 fail "Register it first.", else fail). Application record (`/pokt-network/poktroll/application/application/{addr}`): 200 → `current = stake.amount`; if staked for another service → warn "re-points it"; else info "already has an application stake ... raises it"; fail if `upokt < current`; warn if unbonding ("Staking now cancels that and keeps its gateway delegations."); 404 → ok "no application stake yet"; else fail. Balance: fail if unreadable or `< max(0, upokt - current) + 1 POKT` ("Fund it from the owner wallet using the box above."). On pass: status busy "Building the plan", `run("tx-stake-app", { network, service_id, stake_upokt, from: walletName, dry: true })` → `{ok, command, config}`; `#stkPlanCmd = command + "\n\n# app_stake.yaml\n" + config`; `stkPlanOk`, `stkForm = {id, upokt, from, address}`; enable button; status ok.

**Execute (`executeStake`).** Form-changed guard (id, from, upokt). MainNet modal "Confirm MainNet stake" (type the service ID; dangerbox "This locks X POKT of real funds from <wallet> as an application stake for <id>. Unstaking takes an unbonding period.") or Beta `confirm`. Then log "Signing and broadcasting stake-application for '<id>' as '<wallet>' with X POKT on <net>", status busy, `run("tx-stake-app", {...})`, mempool log with tx link, `pollTx`, "Included in block N.", verify via `appRecordOf(address)` that the service id is present and `stake.amount >= upokt` (log ok/err "On chain: '<wallet>' staked X POKT for '<ids>'."), status ok "'<wallet>' is staked as an application for '<id>' on <net>." or err "Transaction succeeded but verification did not match; check the Activity tab."; on success `recordManifest("app_stake_tx", txhash)`, `("app_wallet", from)`, `("app_address", address)`; then `refreshBalance(); loadHistory(); loadWallets(false, → onStakeFromChange(); renderServices())`.

**Results.** `#stkChecks`, `#stkPlan` (label "Exact command the signer will run"), `#stkStatus`, `#stkLog`.

**Gateway delegation panel (`#dlgPanel`).** Rendered by `renderDelegation()` when the Stake tab opens.
- `#dlgFrom` (Application): options from `delegationHolders()` = owner wallet plus app wallets that have an application record, text `"<name> (staked for <ids>)"`; empty → "No staked application on this network", `#dlgList` "Stake an application above first.", `#btnDelegate` disabled. `onchange` → `onDelegateFromChange()`.
- `#dlgGateway` (Gateway): every gateway from `/pokt-network/poktroll/gateway/gateway?pagination.limit=1000` as `"<address>  (<stake> POKT staked)"`; empty → "No gateways registered on <net>". `#dlgGatewayHint` = "N gateway(s) registered on <net>, read just now. Pick the one that will route requests to your service."
- `onDelegateFromChange()`: `#dlgFromHint` = clickable `.addr` (copy) + "Application address, click to copy; a gateway operator asks for it. K of M allowed delegations used." (+ `#8a5a00` unbonding warning); `#dlgList` = hint "<name> is not delegated to any gateway. Only self-signing clients such as pocket-ap can use it until it is." or `table.services` (Gateway, Actions with `.btn.small.danger` "Undelegate" → `undelegateGateway(addr)`), plus "Pending undelegations, effective when the session ending at block N closes." from `pending_undelegations` keys.
- `.primary#btnDelegate` "Delegate" → `delegateGateway()` → `delegationTx("delegate")`. Guards (status in `#dlgStatus`): no holder; gateway not `/^pokt1[0-9a-z]{38}$/`; wallet/Docker not ready; already delegated; `list.length >= max_delegated_gateways`. Confirmation: MainNet modal (no typing) or Beta `confirm`. Then `run("tx-delegate-gateway" | "tx-undelegate-gateway", { network, from: walletName, gateway_address })`, `pollTx`, `loadHistory(); onDelegateFromChange()`, status ok "Delegated <name> to <short> in block N." / "Undelegated ... It takes effect when the current session ends."

**Live reads.** `application/params` (`min_stake`, `max_delegated_gateways`), application record per holder, service by id, gateway list, balances.

**Files.** `service.json` (`networks.<net>.app_stake_tx`, `app_wallet`, `app_address`; `application_stake_pokt` via Save to service.json on Register).

**Electron deviation (by design).** The HTA's `recordManifest` writes the stake record into whatever folder is selected on the Register screen, even when that is another service. The Electron app writes it into the folder whose `service.json` carries the staked service ID (`folderForId`), and writes nothing when no local folder has it.

### 3.6 Supply service: Suppliers list and Supplier editor (Manage)

**Purpose.** One supplier per configured server per network. The list shows live status; "Manage"/"Stake" opens the editor where the service list, stake amount, operator funding, and unstake live. README: "Suppliers" (menu label "Supply service").

**Panel.** `#tab-supply.tabpane` with two views toggled by class: `#supListView` and `#supEditView.hidden`. `tab("supply")` always resets to the list.

#### Suppliers list (`#supListView`)

`.panel` with `h2` "Suppliers" + `span.badge#supNetBadge`, explanatory hint, `#supList`, `.btnrow` "Refresh" (`renderSuppliers(true)` → `refreshNetwork()` first) and "Add a server" (`tab('settings')`).

`renderSuppliers()`: rows from `supplierRows()` (one per server in settings): stack state `none`/`pending` rows carry no record; `ready` rows read the supplier record, the operator balance, and `httpGet(stack.url)`.

Empty: `.empty` "No servers configured. A supplier lives on a server." + `.btn.primary` "Add a server".

Table `table.services` columns Server, "Status on <net>", Services, Operator gas, URL, Actions:
- Server: `.svcid` name + `.hint.mono` short operator.
- Status = `supplierStatusCell(x)`: `none` → `badge muted` "not provisioned on <net>"; `pending` → `badge warn` "provisioning pending"; record present and unbonding → `badge warn` "unstaking, X POKT" + `.hint` `unbondingNote(u)` ("stake returns to the owner wallet at block R, N blocks (~eta) from now" or ", any moment now"); record present → `badge ok` "staked, X POKT"; 404 → `badge muted` "not staked"; else `badge bad` "unreadable (HTTP N)".
- Services: joined ids or "none". Operator gas: `?` / `badge warn` when `< 2 POKT` / POKT. URL: "answers" / "no answer" / "none".
- Actions: `ready` → `.btn.small.primary` "Manage" (record exists) or "Stake" → `openSupplier(name)`; otherwise `.btn.small.primary` "Continue provisioning" (`pending`) or "Provision for <net>" → `provisionOn(name, net)`.

`unbondingOf(rec)`: `end = unstake_session_end_height`; `returns_at = end + supplier_unbonding_period_sessions * num_blocks_per_session`; `blocks_left = returns_at - height`; `eta = fmtDuration(blocks_left * blockTime)`.

#### Supplier editor (`#supEditView`)

`openSupplier(name, preselect)`: switches to the supply tab if needed, shows the edit view, sets `#supEditName` = name + `.hint.mono` `user@host`, `populateSupplyServers()` (only `ready` servers; remembers `settings.supplierServer`), sets the hidden `#supServer` and calls `onSupplyServerChange()` (persists `supplierServer`, fills `#supServerHint` "Signs on user@host with the <net> operator keyring in <dir>" or a red "a stack that is not provisioned (Settings)", copies `stack.operator` → `#supOperator` and `stack.url` → `#supUrl`, `refreshOperatorBalance()`), hides `#supResults`, `loadSupplierServices(preselect)`, sets `#supAmount = max(currentStake, supMinStake) / 1e6`, `refreshOperatorBalance()`, `renderUnstakePanel()`.

Panels and inputs:

| Panel | id | Content |
|---|---|---|
| "Supplier on <span#supEditName>" | | `.btn.small` "Back to suppliers" (float right) → `closeSupplier()` (returns to list and re-renders). Hidden `select#supServer`. `#supOperator` (text, `maxlength=43`, placeholder "pokt1...", hint `#supServerHint`). `#supUrl` (text, "Public HTTPS URL of the RelayMiner"). |
| "Services this supplier serves" | | `.filerow`: `select#supAdd` + `.btn.small` "Add" (`addSupplyService()`); `input[type=checkbox]#supShowAll` "Show all services on the network" (`onclick` → `populateSupplyAdd()`); `#supServices` table. |
| "Stake" | | `#supAmount` (number; hint `#supHint` "Minimum on <net> right now: M POKT. One stake covers every service the supplier lists."); `.big#supOpBal` "Operator liquid balance" with hint `#supOpBalHint`; `.filerow` `#supFundAmount` + `.btn.small` "Send from owner wallet" (`fundOperator()`), status `#supFundStatus`; `.btnrow` `.primary` "Run preflight" (`preflightSupply()`) and `.primary#btnSupply` (disabled; label "Stake supplier on <net>") → `executeSupply()`. |
| "Preflight" `.panel.hidden#supResults` | | `#supChecks`, `#supPlan` (label "Exact command the signer will run"), `#supStatus`, `#supLog`. |
| "Unstake this supplier" `.panel#supUnstakePanel` | | `#supUnstakeBox.warnbox.hidden`, `p.hint#supUnstakeHint`, `.btn.danger#btnUnstake` "Unstake supplier" (`unstakeSupplierDialog()`), `#supUnstakeStatus`. Hidden entirely when no supplier record. When unbonding: box "<b>Unstaking.</b> This supplier serves until block N and its X POKT <unbondingNote>. The record clears when the stake returns." and the button/hint hidden. |

Service rows (`state.sup.rows`, each `{id, name, url, rpc, checked, staked}`): `loadSupplierServices()` seeds from the on-chain record's `services[]` (checked, staked; url from `endpoints[0].url` or stack url; rpc from `endpoints[0].rpc_type`), then every owned service not yet listed (unchecked, url = stack url, rpc from the local card's `rpc_types[0].type` or "REST"), then the `preselect` id (ticked; appended from the catalog if not present). `populateSupplyAdd()` lists owned services (or the whole catalog when `#supShowAll` is ticked) not already in rows, with a "★ " prefix on owned ones; empty option text "All your services are listed; tick Show all to add others" / "Every service is already listed". `renderSupplyServices()` draws `table.services` with columns (checkbox), Service, Protocol, Endpoint URL, Now: checkbox `onclick="PSM.supRow(i,'checked',this.checked)"`, `select` of `REST, JSON_RPC, WEBSOCKET, GRPC, COMET_BFT` (`supRow(i,'rpc',v)`), text url (`supRow(i,'url',v)`), both disabled when unticked; "Now" badge: staked+checked → `ok` "staked"; staked+unchecked → `bad` "will be dropped"; new+checked → `info` "to add"; new+unchecked → `muted` "not served". Any `supRow` change invalidates the plan (`supPlanOk = false`, button disabled). Empty: "No services yet. Register one, or tick Show all and add one from the catalog."

`refreshOperatorBalance()`: operator must match `/^pokt1[0-9a-z]{38}$/` (else "Enter the operator address to see its balance."); reads balance and supplier record; `need = max(0, stake - current) + 5 POKT`; hints "Enough for X POKT of stake plus gas. Keep a few POKT here for claims and proofs." / "Needs about Y POKT more to cover ... gas." (prefills `#supFundAmount`).

`fundOperator()`: validates address and amount, wallet/Docker ready, owner balance `>= upokt + 1 POKT`; MainNet modal (type `SEND`) or Beta `confirm`; `run("tx-fund-operator", { network, to: operator, amount_upokt })`, `pollTx`, then `refreshBalance(); refreshOperatorBalance(); loadHistory()`, status ok "Sent X POKT to the operator in block N.", clears the amount.

**Preflight (`preflightSupply`).** Fail items: no wallet ("it is the owner named in the stake"); no server; stack dir not an absolute Linux path ("has no <net> stack. Provision it under Settings."); SSH key file missing; operator not a pokt1 address; amount not > 0; operator equals the owner address ("must be a different key ... non-custodial"); no ticked service; each ticked service's URL must match `/^https:\/\/[^\s]+$/` and the id must be in the catalog. Then `refreshNetwork(); refreshBalance()`; fail if `supMinStake` unreadable or `upokt < min`; warn if `upokt === min` ("no margin ... Add a few hundred POKT of margin."); else ok. Info list "Serving N service(s): id (rpc), ..."; warn "Unticked services will stop being served by this supplier: ..." with sub "The stake list on chain is replaced by the ticked services." Operator account (`/cosmos/auth/v1beta1/accounts/{op}`): ok when `account.pub_key` present; fail "exists but has never signed a transaction" or "does not exist on <net> yet". Existing supplier record: owner mismatch → fail; info "Supplier already staked with X POKT for ... This is an update."; fail if `upokt < current`; 404 → ok "No supplier exists for this operator yet; this creates one."; else fail. Operator balance: `need = delta + 1 POKT`; fail "Operator holds X POKT but needs ... Fund it from the owner wallet using the box above." with sub "Suggested: <need - bal + 4 POKT> POKT." (prefills `#supFundAmount`); warn if `bal - delta < 2 POKT`; else ok. Each distinct endpoint URL is `httpGet` once: ok "<url> answered (HTTP N)." or warn "Could not reach <url> from this PC...". Info "The stake takes effect at the next session boundary: height H, about N block(s) (~eta) from now." and "Unstaking later takes S sessions, about <eta>, before the POKT returns to the owner wallet." On pass: status busy "Building the plan", `run("remote-stake-supplier", { network, host, port, user, key_path, path: stackDir, owner_address, operator_address, stake_upokt, services: [{service_id, url, rpc_type}], dry: true })` → `{ok, command, config}`; `#supPlanCmd = command + "\n\n# supplier_stake.yaml (copied to the server)\n" + config`; `supForm = {op, upokt, services, isUpdate, server, conn, key: JSON.stringify(services)}`; enable `#btnSupply`.

**Execute (`executeSupply`).** Form-changed guard (server, operator, amount, and the JSON of currently ticked rows). MainNet modal (type the server name; dangerbox "This locks X POKT of real funds as a supplier stake for operator <op>, serving <ids>. Unstaking takes S sessions.") or Beta `confirm`. Log "Copying the stake config to <server> and signing with the operator key there, X POKT for <ids> on <net>", status busy "Waiting for the server (simulating gas, signing, broadcasting)", `run("remote-stake-supplier", {...no dry})`, mempool log, `pollTx`, "Included in block N.", then verify: re-read the supplier record; `services[]` is the active set and `service_config_history[]` entries with `deactivation_height == 0` are scheduled (`activation_height`); `okv` requires `stake.amount >= upokt` and every requested id either active or scheduled; log "On chain: supplier <op> staked X POKT; active for <ids>; <pending ids> scheduled from height H."; status ok "Supplier staked on <net> for <ids>. New services start serving at height H (the next session boundary)." or err "Transaction succeeded but the supplier record does not list every service; check the Activity list."; on success `recordManifestFor(folder, ...)` for each served service with a local folder: `supplier_stake_tx`, `supplier_operator`, `supplier_url`, `deploy_host`, `deploy_path`. Then `refreshBalance(); refreshOperatorBalance(); loadHistory(); loadSupplierServices(); renderServices()`.

**Unstake (`unstakeSupplierDialog`).** Guards: not busy, record exists, not already unbonding, wallet/Docker ready, `rec.owner_address === state.address`. `refreshNetwork()`; computes `sessions = supplier_unbonding_period_sessions`, `blocks = sessions * blocksPerSession`, `ret = nextSession.height + blocks`, `eta`. Modal body: dangerbox "This unstakes the supplier on <server> (operator <op>) on <net>. It stops serving <ids> when the current session ends at block N." + paragraph "Its X POKT stake is then locked for S sessions (about <eta>) and returns to the owner wallet around block R. The unbonding period is a network parameter read just now. To serve again after that, provision is kept and the supplier is staked anew." MainNet adds "Type UNSTAKE"; Beta button "Unstake on Beta TestNet". Then `run("tx-unstake-supplier", { network, operator_address })`, `pollTx`, re-read record, `refreshNetwork(); loadHistory(); refreshBalance()`, `renderUnstakePanel()`, status ok "Unstake accepted in block N. Serving until block E; <unbondingNote>."

**Live reads.** `supplier/params` (`min_stake`), `shared/params`, supplier record, operator balance and account, catalog, `httpGet` of stack and endpoint URLs.

**Files.** `settings.supplierServer`; `service.json` network fields listed above.

### 3.7 Deploy service

**Purpose.** Ship a service's `backend/` to a provisioned server, build and start it, and add it to that network's relayer. README: "Deploy service".

**Panel.** `#tab-deploy.tabpane` > `.panel` with `h2` "Deploy a service" + `span.badge#depNetBadge`, intro hint, a `.row` with two selects, `.btnrow`, `#depStatus`, `ul.checks#depChecks`, `.log.hidden#depLog`.

**Inputs.**
- `#depId` (Service): `openDeploy()` lists `deployableServices()` = local folders containing `backend/Dockerfile`, text `"<id> (<name>)"`; empty "No deployable services". `onchange` → `onDeployServiceChange()`: `#depIdHint` = "Builds <folder>\backend with the service's own deploy compose file." (when `<folder>/deploy/docker-compose.yaml` exists) or "... with the standard backend-only compose file." plus " Last deployed to <deploy_host>." from the manifest.
- `#depServer` (Server): `provisionedServers()` = servers whose stack for the current network is `ready` with a `dir`, text `"<name> (user@host)"`, default from `settings.supplierServer`; empty "No provisioned servers" and `#depServerHint` "No server is provisioned for <net>. Provision one under Settings." (link).

**Buttons.** `.primary#btnDeploy` "Deploy" → `runDeploy()`; `.btn.hidden#btnDeployStake` "Stake the supplier for it" → `deployThenStake()` (→ `openSupplier(server, id)`); `.btn.hidden#btnDeployTest` "Test it" → `deployThenTest()` (→ `svcTest(id)`).

**Run (`runDeploy`).** Guards (status err): no service/folder, no server, SSH key missing. `root = server.deployRoot || "/opt/pocket/services"`, `hp = readinessPath(id)` (the card's readiness probe path, default `/healthz`). Narration: log "Deploying <id> to <server> (user@host) for <net>: backend at <root>/<id>, relayer in <stackDir>"; status busy "Deploying". Steps, each `mark(label, ok, note)` into `#depChecks` and `fail(msg)` on error (log err, status err "Deployment stopped."):
1. `run("ssh-test", {host, port, user, key_path, path: stackDir})` (60 s) → needs `r.keyring` ("No operator keyring in <dir>. Provision the server first."); mark "SSH connection and supplier" with `r.hostname`.
2. Log "Packing the backend (without node_modules) and its compose file, and copying them to the server."; `run("deploy-ship", {host, port, user, key_path, deploy_root, service_id, folder})` (600 s) → mark "Ship the backend" with "<bytes> bytes, <files> files, compose from <compose_from>".
3. Log "Building the image and starting <id>-backend on the supplier network; waiting for <hp> to answer."; `run("supplier-run", {..., step: "deploy", service_id, deploy_root, health_path})` (600 s) → mark "Build and start the backend" with the last two output lines.
4. Log "Adding the service to the RelayMiner and recreating the relayer."; `run("supplier-run", {..., step: "add-service", service_id, backend_url: "http://<id>-backend:8080", health_path})` (240 s) → mark "Connect to the RelayMiner".
5. `recordManifestFor(folder, "deploy_host", server)`, `"deploy_path"`, `"deployed_at"` (ISO); `refreshNetwork()`; consult `supplyStatusMap()[id]`: active → log "The supplier on <net> is active for <id>: relays can flow now." and status "Deployed on <net>. Active now: test it."; pending → "... serves it from <activationNote>"; else "The supplier is not yet staked for <id> on <net>. Stake it next, then test." / "Now stake the supplier for it."; `state.deployed = {id, server}`; `#btnDeployStake` shown as `btn primary` unless active; `#btnDeployTest` shown as `btn primary` when active else `btn`; `loadHistory()`.

**Files.** `service.json` `networks.<net>.deploy_host/deploy_path/deployed_at`; ships `<servicesRoot>/<folder>/backend` and `deploy/docker-compose.yaml`.

### 3.8 Test service

**Purpose.** Send the card's probes through the protocol with pocket-ap, graded against the card and the JSON-object rule; log every run. README: "Test service".

**Panel.** `#tab-test.tabpane` > `.panel` with `h2` "Test a service" + `span.badge#tstNetBadge`, intro hint, `.row` of three columns, `.btnrow`, `#tstStatus`, `ul.checks#tstChecks`, `.log.hidden#tstLog`; plus `.panel.hidden#tstLogPanel` "Previous tests" > `#tstLogTable`.

**Inputs.**
- `#tstId` (Service): union of owned and local services as `"<id> (<name>)"`; empty "No services". `onchange` → `onTestServiceChange()`.
- `#tstWallet` (Application wallet): owner plus app wallets with an address, text `"<name> (staked for <ids>)"` or `"(no application stake)"`; the first wallet staked for the chosen service is auto-selected. `#tstWalletHint` = "<wallet> is staked for <id>." or `#8a5a00` "No wallet is staked for <id> on <net>. Stake one first (Stake application)."
- `#tstClient` (Relay client): `badge ok` "pocket-ap ready" / "pocket-ap image not downloaded" + `.btn.small` "Download pocket-ap" (`pullPocketAp()` → `run("pocketap-pull")`, 900 s; then `badge ok` `<version>`) / `badge bad` "Docker is not running".
- `#tstIdHint` = "N probes from the card." or "No card found; using the default probes (N)." plus `#8a5a00` "Not deployed on <net> from this machine yet: the supplier has no relayer for it until Deploy service runs, so relays will fail." when the manifest lacks `deployed_at`.

**Probe list (`testProbes(id)`).** From the local card's `serving.healthcheck[]`: label "Identity probe" / "Readiness probe" / "Functional probe" by notes text, `"<label> <METHOD> <path>"`; each POST probe with a body adds "Bad input POST <path>" with body `{}` expecting a 4xx JSON error. Without a card: "Identity probe GET /v1/version" (`$.service` matches `^<id>$`) and "Readiness probe GET /healthz" (`$.status` matches `^ok$`).

**Session preflight (Electron only, product owner, 2026-09-20).** `.hint#tstSession` between the three columns and the button row. A stake joins the session that is drawn at a boundary, never the one already running, so a service registered, supplied, and deployed minutes ago answers nothing and every probe fails with the node's own `no suppliers ... not found for session`, which reads as a broken service. Before a test can run, the screen asks the node for the session this wallet and service would relay through (`GET /pokt-network/poktroll/session/get_session`, `checkSession()` in `src/core/chain.ts`) at a freshly read head height, and grades the answer (`classifySession()`):

- suppliers in the session -> `badge ok` "in session" and "N supplier(s) are serving <id> in the session running now, which ends at block H, N blocks (~t) from now."
- none, and the chain lists no supplier staked for the service -> `badge warn` "not in session yet" and "No supplier is staked for <id> yet, so a relay has nowhere to go. Supply the service on a server and deploy it first; testing works from the session after the supplier stake."
- none, but a stake exists or the supplier lookup did not answer -> `badge warn` and "Nothing is serving <id> in the session running now. A supplier joins only at a session boundary, never the moment it stakes. Sessions start every N blocks. The next one is block H, N blocks (~t) from now at block C. Relays fail until then, so the test waits." The block named is the supplier's own `activation_height` when one is scheduled, otherwise the next boundary from `nextSessionBoundary()`.
- the query failed for any other reason -> `badge warn` "session unknown" and "Could not read the current session from the network (<detail>). The test will run and show whatever the protocol answers."

"Run test" is disabled while the state is waiting and while the first check is in flight; `runTest()` re-runs the check and refuses with the same sentence if the answer is still waiting, so a stale line cannot let a doomed test through. A `.btn.small` "Check again" re-asks at any time, and a waiting-for-the-boundary state re-asks itself every 20 s until it clears (a missing supplier does not, because that one needs the user to act). An answer is rendered only against the service and wallet it was asked about. Every height, the session length, and the block time are read live; nothing here is a stored chain value.

**Buttons.** `.primary#btnTest` "Run test" → `runTest()`; "View log" → `viewTestLog()`; `.danger` "Clear log" → `clearTestLog()` (`confirm("Delete every logged test result on this machine?")`).

**Run (`runTest`).** Guards: service, wallet, Docker ready, pocket-ap present. Status busy "Running N probes"; log "Testing <id> on <net> as <wallet>. Each relay looks up the current session, picks a supplier, signs the request, and verifies the supplier's signature on the answer." For each step: log "Probe i of N: <label> with body ... (expecting ...)"; `run("relay-call", { network, wallet, service_id, method, path, body })` (120 s) → `{ok, error, detail, body, http, exit_code, diagnostics, ms}`; parse diagnostics for `session: <8 hex>` and `attempt N: <pokt1...> in <Nms> via <host> -> <status>` and log "Supplier <short>… answered in <ms> via <host> (<status>), session <id>…"; `gradeStep`: relay failure → note from the last diagnostics line; first non-space char not `{`/`[` → "response is not a JSON object (starts with 'x'); gateways penalize this"; invalid JSON; bad-input probe passes only on HTTP 4xx with `json.error`; non-200 fails; JSONPath (`$.a.b[0].c` subset) value must match the regex; log "Passed: <note>" / "Failed: <note>" with a 160-char body preview. `#tstChecks` is re-rendered after each probe with `(<ms> ms)` and notes. `finish()`: appends one JSON line `{time, network, service, wallet, passed, total, ms, steps}` to `<stateDir>/relay-tests.log`; log "P of N probes passed in <duration>. Logged."; status ok "All probes passed. The service answers through the protocol." or err "P of N probes passed."; `loadHistory()`.

**View log.** Parses the JSONL newest-first into `table.hist` (Time (UTC), Network, Service, Wallet, Result as `badge ok/bad` "P/N" + duration, Probes as per-step ✓/✗ lines) inside `#tstLogPanel`; empty "No tests logged yet."; after clearing "Log cleared."

### 3.9 Wallets

**Purpose.** Application wallets (one per service) in the same keyring as the owner wallet: create, recover, import, fund, stake, export, remove. README: "Wallets".

**Panel.** `#tab-wallets.tabpane` > `.panel` with `h2` "Wallets" + `span.badge#walNetBadge`, intro hint, `#walList`, `.btnrow` (`.primary` "New app wallet" → `newWalletDialog()`, "Recover from phrase" → `recoverWalletDialog()`, "Import private key" → `importAppWalletDialog()`, `.small` "Refresh" → `loadWallets(true)`), `.status#walStatus` (present but unused by the code).

**Table (`renderWallets`).** No owner wallet → `.empty` "Import the owner wallet first (side panel). Application wallets are created inside its keyring." Otherwise `table.services` with the owner row first then `state.wallets` (from `run("wallet-list")` → `{ok, verified, wallets:[{name, address, service_id, present}]}`): columns Wallet (`.svcid` name + `badge blue` "owner" or `badge bad` "missing from keyring" when `present === false`), For service (service id, or hint "registers services" / "unassigned"), Address (`.mono` short with full title), Balance (live), "Application stake on <net>" (`"<stake> POKT for <b>ids</b>"` + `badge warn` "unbonding" + `badge warn` "not <service_id>" when staked for a different service; or "none"), Actions: owner → "Copy address"; app wallet → "Copy address", "Fund" (`fundWalletDialog(name)`), "Stake"/"Restake" (`svcStakeAs(service_id || firstStakedId, name)`), "Export key" (`exportWalletDialog(name)`), `.danger` "Remove" (`removeWalletDialog(name)`). Footer hint when `!walletsVerified`: "Docker is down, so the list could not be checked against the keyring."

**Dialogs.** All require `walletReady(what)` (owner imported and Docker ready; else `alert`). Wallet name rule `validWalletName`: `/^[a-z0-9][a-z0-9_-]{0,39}$/`, not `service-manager`, not existing. Service selects use `serviceOptionsHtml(selected)` = "(choose later)" + owned then local ids, preselecting `#stkId`.

| Dialog | Elements | Signer call | On success |
|---|---|---|---|
| New application wallet | `#nwService` (`onchange` → name = `"app-" + service` unless `#nwName` has `data-manual`), `#nwName` (maxlength 40), `#nwHint`, warnbox about the one-time phrase, buttons `#nwCancel`, `#nwGo` "Create wallet" | `run("wallet-create", {name, service_id}, cb, {shred:true})` → `{ok, name, address, mnemonic}` | `showMnemonic(r)`: modal `wide` "Write down the recovery phrase" with a `.kv` grid of numbered words in `.keybox#nwPhrase`, "Copy phrase to clipboard", checkbox `#nwSaved` gating `#nwDone` "Done" → close, footer "Wallet <name> created: <addr>", `loadWallets(true)`. Result object nulled afterwards. |
| Recover a wallet from its phrase | `#rwService`, `#rwName`, `#rwHint`, `textarea#rwPhrase`, warnbox, `#rwCancel`, `#rwGo` "Recover" | phrase normalised (single spaces, lowercase), word count must be 12/15/18/21/24; `run("wallet-recover", {name, service_id}, cb, {env: {PSM_IMPORT_MNEMONIC: phrase}, shred:true})` | textarea cleared; close; footer "Wallet <name> recovered: <addr>"; `loadWallets(true)` |
| Import an application wallet key | `#iwService`, `#iwName`, `#iwHint`, `input[type=password]#iwKey`, warnbox, `#iwCancel`, `#iwGo` "Import" | hex must be 64 hex chars (optional `0x` stripped); `run("wallet-import-app", {name, service_id}, cb, {env: {PSM_IMPORT_KEY: hex}, shred:true})` | field cleared; close; footer; `loadWallets(true)` |
| Show the private key of <name> (Export) | dangerbox, "Type EXPORT", `#exConfirm`, buttons Cancel / `.danger.solid` "Show key" | `run("wallet-export", {name}, cb, {shred:true})` → `{hex}` | second modal "Private key of <name>": address, `.keybox#exKey`, "Copy to clipboard", hint about `POCKET_APP_PRIVATE_KEY`, "Close" |
| Remove wallet <name> | dangerboxes when balance > 0 ("Without its key or phrase those funds are lost.") and when staked ("The stake stays on chain and can only be unstaked with this key."), "Type the wallet name to confirm." `#rmConfirm`, buttons Cancel / `.danger.solid` "Remove from this machine" | `run("wallet-remove", {name, confirm: name})` | close; footer "Wallet <name> removed."; `loadWallets(true)` |
| Fund <name> from the owner wallet | text "<name> holds X POKT on <net>. The application minimum stake is M POKT, plus about 1 POKT for gas.", `#fwAmount` prefilled with `ceil(max(0, min + 2 POKT - bal))`, `#fwStatus`, buttons `#fwClose` "Close", `#fwGo` "Send" | `fundWallet(name, upokt, "fwStatus", cb)` (see 4.6) | after 1.5 s close and `loadWallets(true)` |

**Live reads.** Balance and application record per wallet.

### 3.10 Activity

There is no separate screen; the README's "Activity" is the "Recent activity" panel on the Dashboard (`#histWrap > table.hist#histTable`), refreshed by `loadHistory()` after every broadcast and on Docker-ready. `run("history")` → `{ok, entries:[{time, network, op, service_id, address, txhash, code}]}`; rows are reversed (newest first). Columns: Time (UTC) (`time` cut to 19 chars, `T` → space), Network, Action (`op`), Service (`service_id || address`), Result (`badge ok` "accepted" when `code == 0`, `badge bad` "rejected <code>", blank when no hash), Tx (first 12 chars + "…" as a link that opens `<NET[entry.network].lcd>/cosmos/tx/v1beta1/txs/<hash>` in the system browser via `openUrl`). Empty: one cell spanning six columns "Nothing yet." The history file itself is written by the signer, not by `app.js`.

### 3.11 Settings

**Updates (Electron only, Start here tab).** `.panel#updatesPanel`: heading with a badge (up to date / version N available), a `kv` table (this app, latest release, last checked), "Check for updates", and "Install version N" when one is available; the header shows `#updateLink` "Update available: N. Click to install." left of the Docker status. Both open the update dialog: versions, plain-text release notes, an install note by install kind, and Later / Release notes / the install button (Update with Scoop, Download and install, or Download). See docs/ARCHITECTURE.md section 8.

**Electron layout (product owner, 2026-09-15).** The screen is split into four sub-tabs (`.subtabs.settings-tabs`, store `settingsTab`), "Start here" open by default: Start here (Services folder, Welcome message), Servers (the servers table and editor with Test connection), Suppliers (Provision a supplier), Claude Integration. `openProvision` switches to Suppliers; the Help guide's links open the Servers and Claude Integration tabs directly.

**Purpose.** Services folder, server list with add/edit, Provision panel, connection test, welcome message. README: "Settings" and "Provision".

**Panel.** `#tab-settings.tabpane` with four `.panel`s.

#### Services folder

`#setRoot` (text; initial value `state.servicesRoot`), `.btn.small` "Use this folder" → `saveServicesRoot()` (folder must exist, else status err "That folder does not exist."; saves `settings.servicesRoot`, `loadServiceFolders()`, status ok "Using <path>."), `.btnrow`: "Open folder" (`openServicesFolder()` → `explorer.exe`), "Rescan" (`loadServiceFolders()`), "Back to default" (`resetServicesRoot()`: `servicesRoot = <repo>/services`, saves `servicesRoot: ""`, status ok "Back to the repository's services folder."). Status `#setRootStatus`. Default root: `<repo>/services` where repo = two levels above the app folder.

**Electron deviation (product owner, 2026-09-15).** The Dashboard's services-directory note shows the path and the "Open folder" / "change it in Settings" links only; the HTA's "N service folders" count is dropped because the services are listed on the same screen. In the Settings file row, the button never wraps (`.filerow .btn`).

**Electron deviation (by design).** The Electron app is installed on its own and has no repository two levels up, so there is no default services root. "Back to default" is therefore "Clear": it saves `servicesRoot: ""`, rescans (which yields no folders), and reports "No folder chosen. Pick one to see and create service folders." "Open folder" is disabled until a root is set, and a "Browse" button opens the native folder picker. The importer records the HTA's absolute default so imported installs keep their folders (`docs/MIGRATION.md`).

#### Servers

`#srvList` from `renderServers()`: empty → hint "No servers yet. Fill in the form below, then provision the server for a network."; else `table.services` columns Name, Connection (`user@host:port`), Deploy root (or `/opt/pocket/services`), Beta TestNet, MainNet, Actions ("Edit" → `editServer(name)`, `.danger` "Remove" → `removeServer(name)`). Network cells via `stackCell(s, net)`: `badge muted` "not provisioned"; else `badge ok` "provisioned" / `badge warn` "provisioning pending" + `.mono` short operator (title full) + `.hint` hostname (`hostOfUrl(url)`) + `.hint.mono` dir + `.hint` `provisioned_at` date (first 10 chars). `renderServers()` also calls `populateProvServers()` and, when `#provDir` is empty, sets `#provNet = state.net` and `onProvNetChange()`.

Form (`h2#srvFormTitle` "Add new server" / "Edit server <name>"): `#srvName` (maxlength 40), `#srvHost`, `#srvPort` (number 1..65535, value 22), `#srvUser`, `#srvKey` (SSH private key file path; hint "An OpenSSH key on this PC. Its passphrase, if any, must be held by ssh-agent."), `#srvRoot` (Deploy root, placeholder `/opt/pocket/services`). Buttons: `.primary` "Save server" → `saveServer()`; "Test connection" → `testServer()`; "Clear form" → `clearServerForm()` (resets, port 22, root `/opt/pocket/services`). Status `#srvStatus`.

`validateServer`: name `/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/`; host `/^[A-Za-z0-9.-]+$/`; port 1..65535; user `/^[A-Za-z0-9._-]+$/`; key file must exist on this PC; deploy root, if given, `/^\/[A-Za-z0-9._\/-]*$/`. `saveServer()` upserts by name, preserving the existing `suppliers` map, saves `settings.servers`, status ok "Added/Updated server <name>.", resets the title, `renderServers(); populateSupplyServers()`. `editServer` fills the form and status "Editing <name>. Save to apply.". `removeServer` asks `confirm("Remove server '<name>' from this app? Nothing on the server changes.")`, drops it, clears `settings.supplierServer` if it pointed there.

`testServer()`: validates the form, status busy "Connecting to user@host on port N", `run("ssh-test", {host, port, user, key_path, path: <current-network stack dir or "">})` (60 s) → `{ok, hostname, docker, keyring, error, detail}`; status "Connected: <hostname>, <docker | docker not found>, <net> operator keyring found | no pocket-home in <dir>." (ok when docker present and, if a stack dir is known, keyring found; else err).

#### Provision a supplier (`.panel#provPanel`)

Inputs: `#provServer` (select of server names; hint `#provServerHint` shows `user@host:port` or "Add a server above first."; `onchange` → `onProvServerChange()`), `#provNet` (select `beta` "Beta TestNet" / `main` "MainNet"; `onchange` → `onProvNetChange()`), `#provDir` (Stack directory; default `stack.dir` or `/opt/pocket/supplier-<net>`; hint `#provDirHint`: ready → "This server already has a <net> stack there; its operator key and relayer config are kept."; pending → "Provisioning of this stack was interrupted after its operator key was created. Start provisioning resumes it; finished steps are not repeated."; none → "A new stack for <net>; a new operator key is created on the server."), `#provHost` (Public hostname; default `hostOfUrl(stack.url)`), `#provFund` (Operator gas top-up (POKT), number, value 10; hint "Sent from the owner wallet only if the operator holds less than 5 POKT."). Button `.primary#btnProv` with label "Start provisioning" / "Continue provisioning" (pending) / "Re-provision" (ready) → `runProvision()`. Status `#provStatus`, `ul.checks#provChecks`, `.log.hidden#provLog`.

Entry points: `openProvision(name, net)` (sets server and network, clears results, scrolls the panel into view) and `provisionOn(name, net)` (switches the app network first via `setNetwork(net)` when needed, then `tab("settings"); openProvision(...)`).

`runProvision()` guards (status err): no server; dir not absolute Linux path; dir already used by the other network's stack ("Each network needs its own directory."); hostname must match `/^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/`; wallet and Docker ready; `net === state.net` ("Switch the app to <net> first; the operator is funded and published on the network being provisioned."). Constants: `project = existing.project || "pocket-supplier-" + net`; ports `stackPorts(net)` = beta `{health:8081, relayer_metrics:9090, miner_metrics:9092}`, main `{8082, 9091, 9093}`; `CADDY_DIR = "/opt/pocket/caddy"`. Steps (each `mark()` into `#provChecks`, narrated in `#provLog`; `fail()` → status err "Provisioning stopped. Fix the problem and start again; finished steps are kept."):
1. `ssh-test` (60 s) → needs `r.docker`; mark "SSH connection and Docker".
2. `run("supplier-ship", {conn..., path: dir, network, hostname, project, caddy_dir, health_port, relayer_metrics_port, miner_metrics_port, block_time: round(blockTime)})` (180 s) → mark "Ship the stack" with "Copied <files>" (+ "; the existing relayer config with its services was kept"); `setStack(server, net, {dir, project, url: "https://" + host})`.
3. `supplier-run step "operator"` (120 s) → `{ok, address, lines, err}`; `operator = address`; `setStack(..., {operator})`; mark "Operator key".
4. `supplier-run step "keys"` (120 s) → mark "RelayMiner key file" "supplier-keys.yaml written".
5. Operator balance: `>= 5 POKT` → mark "Operator gas" ok; else needs `topup > 0` (fail "Enter a top-up amount."), fills `#supOperator`/`#supFundAmount`, confirms (MainNet modal type `SEND`, cancel → `fail("Funding cancelled.")`; Beta `confirm`), `run("tx-fund-operator", {network, to, amount_upokt})`, `pollTx`, mark "Sent X POKT in block N", `refreshBalance()`.
6. `/cosmos/auth/v1beta1/accounts/{operator}`: if `pub_key` present mark "Operator public key on chain" "already published"; else `supplier-run step "publish"` with `network` (420 s) (a 1 uPOKT self-transfer signed on the server).
7. `supplier-run step "start"` (300 s) → mark "Start the stack" with the last three lines; then `step "status"` (120 s) → mark "Status".
8. `done()`: `setStack(server, net, {dir, project, url, operator, provisioned_at: ISO})`; log ok "Server <name> now has a <net> supplier stack at <dir>. Deploy a service to it next (Services, Deploy service)."; status ok "Provisioned. Operator <addr>."; `renderServers(); populateSupplyServers(); loadHistory()`.

#### Claude Integration (Electron only)

Not in the HTA. Two parts. The remote read-only MCP endpoint (`MCP_ENDPOINT` in `src/core/versions.ts`) with Copy, then a "Claude Code" block with a badge (not added, added, needs updating) and two sub-tabs, Desktop shown first: Desktop has "Add to Claude Code" / "Update" / "Remove" (one entry named `pocket` in Claude Code's user settings, the same helper the bridge uses), the "Always allow" reminder, and the Claude chat connector steps; Terminal has the `claude mcp add` command with Copy and the same reminder. No JSON is shown. Below it the **Local action bridge** (`docs/ARCHITECTURE.md` section 7): a status badge (off, running on port N, stopped with the error), Port, Endpoint with Copy, Token (masked; Show, Copy, Rotate token with a confirm), "Turn on" / "Turn off", and while running a "Claude Code" block with a badge (not added, added, needs updating), "Add to Claude Code" / "Update in Claude Code" / "Remove from Claude Code" (with confirm), and the hint that this writes one entry into Claude Code's user settings file and that a new session then has the psm tools (the same entry serves the Claude desktop app's Code tab and a terminal). No JSON is ever shown to the user. A bridge request opens the "Assistant request" modal (dangerbox on MainNet, warnbox otherwise; a facts table; a typed token when required; Decline / Approve); Escape declines. After any bridge call the footer says which tool ran and the history, balance, wallets, and folders refresh.

#### Welcome message

Hint plus `.btn.small` "Show Welcome Message" → `showWelcome()`.

**Files.** `settings.json` keys `servicesRoot`, `servers[]`, `supplierServer`, `welcomeSeen`.

### 3.12 Revoke (owner key)

Entry: "Revoke key" in the owner wallet card → `revokeDialog()`. Modal "Revoke the wallet key": dangerbox "Revoking shows the private key one time so you can store it elsewhere, then deletes the encrypted keyring, the Docker volume, and the sealed passphrase from this machine. Registered services and stakes on the network are not affected."; if `state.wallets.length > 0` a second dangerbox "The keyring also holds N application wallet(s), which would be deleted with it. Export or remove them on the Wallets tab first; the signer refuses to revoke while they exist."; "Type REVOKE to continue." `#revConfirm`; buttons Cancel / `.danger.solid` "Show key and continue" → body becomes `p.status.busy` "Exporting the key from the keyring", `run("wallet-export", {}, cb, {shred:true})` → `showExported(hex)`: modal "Save this key now" with `.keybox#revKey`, "Copy to clipboard", buttons "Keep the key, cancel revoke" (close) and `.danger.solid` "I saved it. Delete from this machine" → busy "Deleting the keyring volume and sealed passphrase", `run("wallet-delete")` → close, footer "Wallet key deleted from this machine.", `walletStatus()`. Errors render a dangerbox in the modal body.

### 3.13 Owner wallet import (dialog, part of the shell)

`importDialog()`: requires Docker ready with the image (else `alert`). Modal "Import the wallet private key": explanation paragraph, warnbox ("handed to pocketd through the process environment..."), `input[type=password]#impKey` (focused after 50 ms), hint `#impHint` "Optional 0x prefix is fine.", buttons `#impCancel` / `.primary#impGo` "Import" → `doImport()`: hex must be 64 hex chars; disables both buttons, hint "Importing, this takes a few seconds"; `run("wallet-import", {}, cb, {env: {PSM_IMPORT_KEY: hex}, shred: true})` → `{ok, address}`; field cleared; on success close, footer "Wallet imported: <addr>", `walletStatus()`; on failure re-enable and show the error in the hint (or footer if the dialog is gone).

---

### 3.14 Help (Electron only)

Not in the HTA. Menu: the Settings section holds two screens, Settings and Help. **List first:** `.panel.help` with `h2` "Help", a hint, and a `table.services` of five chapters (number, title, one-line blurb, "Read"); a row click opens the chapter. **Page:** "Back to chapters", `h2` "N of 5. <title>", the chapter body in `.help-body`, then Previous and Next buttons (the last chapter's Next is "Back to chapters"). Chapters, in order: How a service works (off-chain service app and RelayMiner; on-chain service record, application stake, supplier stake; sessions; the owner and supplier roles, one person for a bespoke service, other suppliers possible when the service app code is public; the JSON-object rule), Before you start (Docker Desktop; the owner wallet with a live table of the registration fee and the application and supplier minimum stakes for the selected network plus a "Read again" button; the service app requirements; the server requirements; Claude Code), The steps (seven, framed as about twenty minutes: import the owner wallet; create and register; stake an application; add and provision the server; deploy; stake the supplier; test), Working with Claude Code (the bridge, what stays with the user, what to ask for), Resources (explorer for the selected network, the Beta faucet, the docs site, the four repositories, and the foundation address with a Copy button for the agentic portal request). Written for a first-time owner in a teacher's voice: no commands, no typed-in chain values.

## 4. Shared behaviours

### 4.1 Network switching (`setNetwork(n)`)

Refused while `state.busy` (`alert("Wait for the current transaction to finish before switching networks.")`). Switching to MainNet asks `confirm("Switch to MainNet? Transactions there spend real POKT.")`. Then: `state.net = n`, `saveSettings({network: n})`, `applyNetworkUi()` (body class, net buttons, all `*NetBadge`s, the three primary button labels "Register on X" / "Stake on X" / "Stake supplier on X"), invalidates `regPlanOk`, `stkPlanOk`, `supPlanOk`, `supForm`, `sup`, `deployed`, disables `#btnRegister`/`#btnStake`, hides `#regResults`/`#stkResults`, `clearResults()`, `refreshNetwork()`, `refreshBalance()`, and re-enters the current screen with `tab(state.screen)` (which drops a supplier editor back to the list). `applyTheme()` is called inside `applyNetworkUi()` so the body class is `net-main|net-beta` + optional `theme-dark`.

### 4.2 Screen entry (`tab(name)`)

Per-screen opener calls: `dashboard` → `renderDashboard()`; `services` → `renderServices()`; `wallets` → `renderWallets()`; `test` → `openTest()`; `deploy` → `openDeploy()`; `settings` → `renderServers()` and `#setRoot = servicesRoot`; `stake` → `populateStakeSelect(); populateStakeFrom(); onStakeServiceChange(); renderDelegation()`; `supply` → show list view, hide editor, `renderSuppliers()`. `create` and `register` have no opener (their state persists). The section containing the screen is forced open in `navOpen`, `renderNav()` runs, `#content.scrollTop = 0`.

### 4.3 Refresh cadence

There is no timer-based refresh of balances, block height, or block time. Everything is event-driven:
- `refreshNetwork()` (params + latest block + block 1,000 back + catalog; then `renderChain()`, `loadCatalog()` → `renderServices()`, `onCuprChange()`): on the first Docker-ready cycle, on network switch, on the wallet card "Refresh", on the Dashboard / My services / Suppliers "Refresh" buttons, at the start of every preflight (register, stake, supply), before the unstake dialog, after a deploy, after a supplier unstake.
- `refreshBalance()` (owner balance): after `wallet-status` reports imported, with `refreshNetwork()` in the cases above, before and after every transfer, after every broadcast.
- Per-row balances/records (wallets, suppliers, dashboard) are read synchronously each time the table renders.
- Loops that do exist: Docker retry every 10 s while down; Docker start poll every 5 s (max 24); `run()` result poll every 300 ms (default timeout 240 s; per-call overrides up to 900 s); `pollTx` every 3 s for up to 180 s.
- Block time is derived, not polled: `(t_head - t_head-1000) / 1000` seconds, shown as "measured over 1,000 blocks".

The port may add a gentle periodic refresh of the chain panel, but parity means the numbers above are refreshed only on those events.

### 4.4 Persistence: `settings.json` (`%LOCALAPPDATA%\PocketServiceManager\settings.json`)

`loadSettings()` / `saveSettings(patch)` (merge, skipped when `state.noSave`). Keys written by `app.js`:

| Key | Type | Written by |
|---|---|---|
| `network` | `"beta"` / `"main"` | `setNetwork` |
| `theme` | `"light"` / `"dark"` | `toggleTheme` |
| `servicesRoot` | path or `""` | `saveServicesRoot`, `resetServicesRoot` |
| `lastService` | folder name | `onServiceFolder` (restored on init: sets `#svcFolder` and re-runs `onServiceFolder`) |
| `welcomeSeen` | boolean | welcome Close |
| `servers` | array of `{name, host, port, user, keyPath, deployRoot, suppliers: { beta?: {dir, project, url, operator, provisioned_at}, main?: {...} }}` | `saveServer`, `removeServer`, `setStack`, `updateServer`, legacy migration |
| `supplierServer` | server name | `onSupplyServerChange`, cleared by `removeServer` |

Legacy migration (`migrateServer`): entries with top-level `supplierDir`/`operator`/`url`/`network`/`provisioned_at` are moved into `suppliers[<network or beta>]` with `project: "pocket-supplier"` and the old keys deleted; saved back on first read. Stack state: `none` when no `operator` and no `dir`; `pending` when either exists but no `provisioned_at`; `ready` when `provisioned_at` is set.

Other state-dir files: `runs/` (signer request/result files, deleted or shredded after each call), `relay-tests.log` (JSONL), `selftest.flag`/`selftest.txt` (selftest mode), and the signer's own `wallet.json`, `wallets.json`, `keyring.pass.dpapi` (never read by `app.js`).

### 4.5 Service folders and the on-chain merge

`state.servicesRoot` = `settings.servicesRoot` if that folder exists, else `<repo>/services`. `localServices()` enumerates subfolders and reads each `service.json` → `{folder, id: service_id || folder, name, cupr, hasCard, manifest}`. `ownedServices()` filters the catalog by `owner_address === state.address`. My services shows owned first (annotated with the matching local folder) then unmatched local folders (flagged "ID taken by another owner" when the id exists under a different owner). Test and the wallet dialogs use the union of ids; Deploy uses only local folders with `backend/Dockerfile`.

`service.json` fields read/written by `app.js`: `service_id`, `name`, `compute_units_per_relay`, `card` (relative or absolute path, default `card.json`), `application_stake_pokt`, and `networks.<beta|main>.{register_tx, last_update_tx, app_stake_tx, app_wallet, app_address, supplier_stake_tx, supplier_operator, supplier_url, deploy_host, deploy_path, deployed_at}`.

### 4.6 Transfers from the owner wallet

`fundWallet(name, upokt, statusId, cb)` (to an app wallet) and `fundOperator()` (to an operator address) share the pattern: validate, `refreshBalance()`, require `balance >= upokt + 1 POKT`, confirm (MainNet `SEND` modal / Beta `confirm`), `state.busy = true`, `run("tx-fund-wallet", {network, name, amount_upokt})` or `run("tx-fund-operator", {network, to, amount_upokt})`, status "Broadcast, waiting for the block (<hash10>)", `pollTx`, `refreshBalance(); loadHistory()`, status ok "Sent X POKT to <target> in block N.".

### 4.7 The preflight pattern

Used by Register, Stake application, and Supplier stake:
1. Reset the results panel (`#<p>Results` shown, `#<p>Plan` and `#<p>Log` hidden, status cleared), `<p>PlanOk = false`, action button disabled.
2. Re-check Docker once if the cached state says not ready (`dockerCycle(false, cb)` then recurse with `rechecked = true`).
3. Local validation → fail list; stop if any fail.
4. `refreshNetwork(); refreshBalance()` and chain reads (catalog, records, balances, params).
5. Render the checklist; stop with "Fix the red items and run preflight again." if any fail.
6. Dry run through the signer (`dry: true`) → show the exact command (and YAML config) in the `.plan` block, store the form snapshot (`regForm` / `stkForm` / `supForm`), enable the action button, status ok "Preflight passed. Review the plan, then press <button>."
7. Execute compares the current form to the snapshot and refuses on any change ("The form changed since preflight. Run preflight again.").
8. Execute: confirmation → `busy = true`, button disabled, log line, status busy "Waiting for pocketd (simulating gas, signing, broadcasting)" → signer → "Accepted into the mempool. Tx <link> (gas estimate N)" → status busy "Waiting for the transaction to be included in a block" → `pollTx` → "Included in block N." → read-back verification → status ok/err → manifest record → refresh balance/catalog/history → `busy = false`, `<p>PlanOk = false`.

### 4.8 Narrated multi-step runs

Provision, Deploy, and Test use `mark(label, ok, note)` (appends to a results array and re-renders `ul.checks`) plus `logTo()` narration and a terminal `fail(msg)` that logs in red, sets an `err` status, and re-enables the start button. Steps are sequential nested callbacks; each `run()` has its own timeout. Test additionally shows per-probe timing in the checklist.

**Electron deviation (by design).** A screen's last status line, checklist, log, and plan live in the screen component and are cleared when the user leaves the screen; the HTA kept them in the DOM until the next run.

### 4.9 `run()` result surfacing

Every result is `{ok, ...}`; failures carry `error` and often `detail` (and `raw_log` for transactions, `err`/`lines` for `supplier-run`). The UI shows `esc(r.error) + " " + esc(r.detail || "")` in the relevant status or checklist item; transaction results carry `txhash` and `gas`. A missing/unparseable result becomes `{ok:false, error:"The signer did not return a result.", detail: <stderr/stdout up to 3000 chars>}`; a timeout becomes `"Timed out waiting for the signer (Ns)."`. Sensitive calls pass `{shred:true}` so the request/result files are overwritten before deletion, and secrets travel only through `opts.env` (`PSM_IMPORT_KEY`, `PSM_IMPORT_MNEMONIC`), never in the payload.

Signer operations used (name → payload keys): `docker-check`, `docker-start`, `image-pull`, `pocketap-pull`, `wallet-status`, `wallet-list`, `wallet-import` (env key), `wallet-export` ({} for owner, `{name}` for app wallet), `wallet-delete`, `wallet-create {name, service_id}`, `wallet-recover {name, service_id}` (env phrase), `wallet-import-app {name, service_id}` (env key), `wallet-remove {name, confirm}`, `tx-fund-wallet {network, name, amount_upokt}`, `tx-fund-operator {network, to, amount_upokt}`, `tx-add-service {network, service_id, name, compute_units_per_relay, card_path, dry?}`, `tx-stake-app {network, service_id, stake_upokt, from, dry?}`, `tx-delegate-gateway` / `tx-undelegate-gateway {network, from, gateway_address}`, `tx-unstake-supplier {network, operator_address}`, `remote-stake-supplier {network, host, port, user, key_path, path, owner_address, operator_address, stake_upokt, services, dry?}`, `validate-card {card_path, script}`, `ssh-test {host, port, user, key_path, path?}`, `supplier-ship {conn..., network, hostname, project, caddy_dir, health_port, relayer_metrics_port, miner_metrics_port, block_time}`, `supplier-run {conn..., step: operator|keys|publish|start|status|deploy|add-service, ...}`, `deploy-ship {host, port, user, key_path, deploy_root, service_id, folder}`, `relay-call {network, wallet, service_id, method, path, body}`, `history`.

### 4.10 Keyboard and focus

Minimal: the owner import dialog focuses `#impKey` after 50 ms; `#crId`/`#svcId`/`#svcCupr` react on `keyup`; the mnemonic "Done" button is gated by a checkbox; typed-confirmation buttons silently ignore clicks until the token matches (no Enter handling). No keyboard shortcuts. The port should add Enter/Escape handling in modals while keeping the token gate.

### 4.11 Clipboard and external links

`copy(text)` uses `window.clipboardData` and footer "Copied to clipboard" (alert on failure). `openUrl(u)` shells out to the default browser; used for tx links (LCD URL, not the explorer).

---

## 5. LCD and HTTP surface

Bases (from `NET` in `app.js`):

| Network | Chain label | LCD base | Explorer (defined, unused) |
|---|---|---|---|
| `beta` | "Beta TestNet" | `https://sauron-api.beta.infra.pocket.network` | `https://explorer.pocket.network/beta` |
| `main` | "MainNet" | `https://sauron-api.infra.pocket.network` | `https://explorer.pocket.network` |

`httpGet` uses `MSXML2.ServerXMLHTTP.6.0` with timeouts 8 s / 8 s / 20 s / 40 s and `Accept: application/json`; `lcd()` returns `{status, json}` (`status: 0` on transport error). Transaction links open `<lcd>/cosmos/tx/v1beta1/txs/<hash>` in the browser; `NET.explorer` is never referenced.

| Path | Used by | Extracted |
|---|---|---|
| `/cosmos/bank/v1beta1/balances/{addr}` | owner card (`refreshBalance`), Wallets rows, Stake ("Staking wallet balance"), Supply editor (operator), Suppliers list / Dashboard (operator gas), Provision (operator balance), Remove-wallet and Fund dialogs, transfer guards | `balances[].amount` where `denom === "upokt"`; `null` when status != 200 |
| `/pokt-network/poktroll/application/application/{addr}` | Wallets, Dashboard services, My services, Stake (unbonding box, preflight, verification), Delegation, Test wallet list, Remove wallet | `application.stake.amount`, `service_configs[].service_id`, `unstake_session_end_height`, `delegatee_gateway_addresses[]`, `pending_undelegations{}` |
| `/pokt-network/poktroll/service/params` | `refreshNetwork` (owner card "Registration fee", Register preflight) | `params.add_service_fee.amount` |
| `/pokt-network/poktroll/application/params` | `refreshNetwork` (owner card "Application min stake", Stake defaults, Dashboard margins, Delegation max) | `params.min_stake.amount`, `params.max_delegated_gateways` |
| `/pokt-network/poktroll/supplier/params` | `refreshNetwork` (owner card "Supplier min stake", Supply default and preflight) | `params.min_stake.amount` |
| `/pokt-network/poktroll/shared/params` | `refreshNetwork` (price per relay, session length, session anchor, unbonding period) | `compute_units_to_tokens_multiplier`, `compute_unit_cost_granularity`, `num_blocks_per_session`, `session_grid_anchor_height`, `supplier_unbonding_period_sessions` |
| `/cosmos/base/tendermint/v1beta1/blocks/latest` | `refreshNetwork` (Dashboard chain panel, session maths, activation notes) | `block.header.height`, `chain_id`, `time` |
| `/cosmos/base/tendermint/v1beta1/blocks/{height-1000}` | `refreshNetwork` (measured block time) | `block.header.time` |
| `/pokt-network/poktroll/service/service?pagination.limit=2000` | `loadCatalog` (My services, Stake select, Supply add list, Register near-collision checks, wallet dialogs) | `service[]` with `id`, `name`, `owner_address`, `compute_units_per_relay` |
| `/pokt-network/poktroll/service/service/{id}` | Register preflight and post-tx verification, Stake preflight, selftest | `service.owner_address`, `name`, `compute_units_per_relay`; 404 means free |
| `/pokt-network/poktroll/gateway/gateway?pagination.limit=1000` | Delegation panel | `gateways[]` with `address`, `stake.amount` |
| `/pokt-network/poktroll/supplier/supplier/{operator}` | Suppliers list, Dashboard, Supply editor, `supplyStatusMap`, preflight and verification, unstake | `supplier.stake.amount`, `owner_address`, `operator_address`, `services[].service_id`, `services[].endpoints[].{url, rpc_type}`, `service_config_history[].{service.service_id, activation_height, deactivation_height}`, `unstake_session_end_height`; 404 = not staked |
| `/cosmos/auth/v1beta1/accounts/{addr}` | Supply preflight, Provision | presence of `account.pub_key` |
| `/cosmos/tx/v1beta1/txs/{hash}` | `pollTx` after every broadcast; also the link target in logs and Activity | `tx_response.code`, `height`, `raw_log` |
| `httpGet(stack.url)` | Suppliers list, Dashboard ("answers" / "no answer") | any HTTP status counts as answering |
| `httpGet(endpoint url)` | Supply preflight (one per distinct ticked URL) | status for the ok/warn item |

---

## 6. Proposed React component tree

```
<App>                                   global store: network, theme, ownerWallet{imported,address,verified,partial,balance},
 ├─ <TitleBar/>                          wallets[], walletsVerified, settings, docker{ok,image,pocketd,pocketap,docker,error},
 ├─ <TopBar>                             params (live), catalog, busy, screen, history[]
 │   ├─ <NetworkSwitch/>
 │   ├─ <ThemeToggle/>
 │   ├─ <DockerStatus/>                  (Start / Download / Re-check actions)
 │   └─ <MainNetBanner/>
 ├─ <Layout>
 │   ├─ <Sidebar>
 │   │   ├─ <OwnerWalletCard/>           (ImportKeyDialog, RevokeDialog)
 │   │   └─ <AccordionNav/>
 │   └─ <Content>  (one of)
 │       ├─ <DashboardScreen>  <StatsList/> <ChainPanel/> <ServicesDirNote/> <DashboardServicesTable/> <DashboardSuppliersTable/> <ActivityTable/>
 │       ├─ <MyServicesScreen> <ServicesTable/>
 │       ├─ <CreateServiceScreen> <CardForm/> <ChecksList/> <PlanBlock(card.json)/>
 │       ├─ <RegisterScreen>   <RegisterForm/> <PreflightPanel/>
 │       ├─ <StakeScreen>      <StakeForm/> <FundBox/> <PreflightPanel/> <DelegationPanel/>
 │       ├─ <SupplyScreen>     <SuppliersList/> | <SupplierEditor> <ServiceRowsTable/> <StakeBox/> <FundBox/> <PreflightPanel/> <UnstakePanel/>
 │       ├─ <DeployScreen>     <RunPanel/>
 │       ├─ <TestScreen>       <RunPanel/> <TestLogTable/>
 │       ├─ <WalletsScreen>    <WalletsTable/> (NewWalletDialog, MnemonicDialog, RecoverDialog, ImportAppWalletDialog, ExportDialog, RemoveDialog, FundDialog)
 │       └─ <SettingsScreen>   <ServicesRootPanel/> <ServersPanel/> <ServerForm/> <ProvisionPanel/> <WelcomePanel/>
 ├─ <Footer/>
 ├─ <ResizeGrip/>
 └─ <ModalHost/>                          (WelcomeDialog, ConfirmDialog, TypedConfirmDialog)
```

Three shared patterns to build once:

| Pattern | Component | Used by |
|---|---|---|
| Form with preflight | `<PreflightForm>`: fields, "Run preflight", disabled action button whose label carries the network, `<ChecksList>`, `<PlanBlock>`, `<StatusLine>`, `<LogBox>`, snapshot-and-compare guard, MainNet `<TypedConfirmDialog>` | Register, Stake application, Supplier editor (stake) |
| Live table with row actions | `<LiveTable>`: columns, per-row badges, `.btn.small` actions, empty state (`.empty` + orbit or hint), "Refresh" that re-reads the chain | My services, Wallets, Suppliers list, Dashboard services/suppliers, Servers, Delegations, Supplier service rows (with editable cells), Activity, Test log |
| Narrated multi-step run | `<RunPanel>`: start button (disabled while busy), `<StatusLine busy>`, `<ChecksList>` marks, `<LogBox>` narration, per-step timeouts, terminal fail state, follow-up buttons | Provision, Deploy, Test (and the execute phase of the three preflight forms) |

Global store vs local state:

- Global: `network`, `theme`, owner wallet (`imported`, `address`, `verified`, `partial`, `balance`), `wallets` + `walletsVerified`, `settings` (servers, servicesRoot, supplierServer, lastService, welcomeSeen), `docker`, live `params` (fee, min stakes, multiplier, granularity, blocksPerSession, sessionAnchor, unbondingSessions, height, chainId, headTime, blockTime, maxDelegated), `catalog` + `catalogNet`, `busy`, current `screen`, history entries, `servicesRoot` (resolved), `stateDir`/`skillScripts` paths.
- Local per screen: Create form values and `crAuto` flags; Register form, `regPlanOk`, `regForm`, `regUpdate`; Stake form, `stkPlanOk`, `stkForm`, `stkFromBalance`; Supply editor `state.sup` (`server`, `rec`, `status`, `rows`), `supPlanOk`, `supForm`, `opBalance`, show-all toggle; Deploy selections and `deployed`; Test selections and results; Settings server form and `provServer`; nav `navOpen`; modal contents and typed tokens.

---

## 7. Port order and parity checklist

Suggested order: Wallets → Settings → Services (My services, Create, Register, Stake) → Suppliers (list, Manage, Provision) → Deploy → Test → Dashboard → Activity. Each step assumes the shell (title bar, top bar, owner card, nav, modal host, status/log/checks primitives) exists first.

**Shell (before everything)**
- [ ] Body class `net-beta|net-main` + `theme-dark`; layout top offset grows when the banner shows.
- [ ] Docker state text and inline buttons for all four states; retry every 10 s while down; start poll; image pull with long timeout.
- [ ] Owner card three states; address click copies; fees from live params; Refresh; Revoke flow with `REVOKE`, key shown once, refusal note when app wallets exist.
- [ ] Import dialog: 64-hex validation, `0x` stripped, buttons disabled during import, the key travels only through the typed `wallet-import` channel and never appears in a command line, log, request file, or activity entry.
- [ ] Accordion: single sections are links, multi sections toggle, active section forced open on `tab()`.
- [ ] Welcome shown once (`welcomeSeen`), reopenable from Settings.
- [ ] Network switch: refused while busy, MainNet confirm, all invalidations in 4.1, current screen re-entered.
- [ ] Footer messages and clipboard toast.

**Wallets**
- [ ] Empty state without owner wallet; owner row first with `badge blue` "owner".
- [ ] Per-row live balance and application stake with "unbonding" and "not <service>" badges; "missing from keyring" badge; unverified hint when Docker is down.
- [ ] New wallet: name auto `app-<service>` until edited; validation messages; mnemonic grid, copy, checkbox-gated Done; list refresh.
- [ ] Recover: word-count check (12/15/18/21/24), phrase normalised, phrase cleared after.
- [ ] Import: hex check, field cleared after.
- [ ] Export: `EXPORT` token, second modal with key and copy.
- [ ] Remove: name token, balance and stake warnings.
- [ ] Fund: suggested amount `min + 2 POKT - balance`, owner-balance guard, MainNet `SEND`, list refresh after 1.5 s.
- [ ] Stake/Restake row action lands on Stake with the wallet preselected.

**Settings**
- [ ] Services root: validate exists, save, reset to default (`servicesRoot: ""`), rescan repopulates `#svcFolder` and `#crFolder`, open in file manager.
- [ ] Servers table with Beta/MainNet stack cells (badge, operator, hostname, dir, date); Edit fills the form and title; Remove confirms and clears `supplierServer`; legacy entries migrate.
- [ ] Server validation messages (six rules); key file must exist locally.
- [ ] Test connection: busy status, result sentence including keyring check for the current network.
- [ ] Provision panel: server/network selects, dir default `/opt/pocket/supplier-<net>`, hostname from stack url, hint and button label by stack state, guards (dir clash, hostname regex, wallet/Docker, network mismatch), eight narrated steps with marks, resumable (stack saved after ship and after operator), funding branch with confirmation and cancel → fail, publish skipped when pub_key exists, `provisioned_at` written at the end.
- [ ] `provisionOn` from Suppliers switches network first.

**Services: My services**
- [ ] Hint text with/without wallet; merge of owned and local; "ID taken by another owner"; lifecycle badges (created/registered/pending/active) with server and activation note; "not deployed from this machine" warning; "no card" badge.
- [ ] Price column with uPOKT/relay from live multiplier.
- [ ] App stake total with unbonding note.
- [ ] Row actions and their prefills (Update with/without folder, Register, Stake, Deploy only with Dockerfile, Supply default server, Test, Edit card).
- [ ] Empty state with orbit and "Create your first service".

**Services: Create**
- [ ] All 33 inputs with defaults; auto-derived apis/hint/impl/idMatch and manual override flags; id hint states.
- [ ] Validation list (fail/warn/info) exactly as 3.3; preview with byte count vs 4 KiB.
- [ ] Card JSON shape identical to `buildCard` (key order, probe notes, gateway sentence, `updated` date).
- [ ] Create: overwrite confirm, `service.json` merge, validate-card result appended, folder list rescanned, Register prefilled and `lastService` saved, status text.
- [ ] Load from folder: reverse mapping including probe classification and notes stripping; round-trip preserves body JSON.

**Services: Register**
- [ ] Folder select fills all fields and `#stkAmount`/`#stkId`; `lastService` restored on launch.
- [ ] Id/cupr hints; card path browse fallback (native dialog in Electron).
- [ ] Check card: size limits (262,144 hard, 4,096 warn), JSON object, `service_id` mismatch, validate-card.
- [ ] Save to service.json (relative card path).
- [ ] Preflight items in order (Docker recheck, wallet, id/name/cupr, fee, catalog exists/owner/free, near-collisions, card, balance vs fee+1 POKT, price info, validate-card, dry run) and the plan block.
- [ ] Execute: form-changed guard, MainNet type-the-id / Beta confirm, log lines, pollTx, read-back verification, manifest `register_tx`/`last_update_tx`, `#stkId` set, catalog/balance/history refreshed.

**Services: Stake application**
- [ ] Service select from owned services; wallet preselected by `service_id`; suggested amount = live min +10% rounded up; hint text.
- [ ] Stake-as hints (owner, re-point, normal); unbonding warnbox with amount bump.
- [ ] Staking wallet balance and "needs about X more" prefill of the fund box; fund from owner (guard against owner selected).
- [ ] Preflight items (margin rule `< min * 1.01` fails, service exists, current stake / re-point / cannot lower / unbonding, balance vs delta + 1 POKT) and plan with `app_stake.yaml`.
- [ ] Execute with verification, manifest `app_stake_tx/app_wallet/app_address`, wallets reloaded.
- [ ] Delegation: holders list, live gateway list with stakes, address copy hint with "K of M used", delegations table with Undelegate, pending undelegations note, guards (already delegated, max reached), MainNet plain modal, status text incl. "takes effect when the current session ends".

**Suppliers: list, Manage, Provision**
- [ ] List row per server with status cell variants (not provisioned, pending, staked, unstaking with return block/eta, not staked, unreadable), services, gas warn `< 2 POKT`, URL answers; action button label by state.
- [ ] Manage: header with `user@host`, operator/url from stack, hint when stack missing, service rows seeded from chain + owned + preselect, add list with star and show-all, editable rpc/url disabled when unticked, "Now" badges, any edit invalidates the plan.
- [ ] Amount default `max(current, min)`; operator balance hints with 5 POKT gas allowance and fund prefill; fund operator flow.
- [ ] Preflight items (3.6) incl. operator != owner, https URLs, catalog membership, account pub_key, existing record owner/update/cannot lower, gas thresholds (need +1, keep 2, suggest +4), URL reachability per distinct URL, next session and unbonding info; plan with `supplier_stake.yaml`.
- [ ] Execute: MainNet type-the-server-name, verification against `services` and `service_config_history`, pending activation message, manifest fields for each served local service.
- [ ] Unstake: guards, live unbonding maths in the dialog, `UNSTAKE` on MainNet, post-tx panel state.
- [ ] Back to suppliers re-renders the list.

**Deploy**
- [ ] Deployable list (Dockerfile) and provisioned server list with `supplierServer` default; hints incl. compose source and last deploy host.
- [ ] Four narrated steps with timeouts; readiness path from the card; manifest `deploy_host/deploy_path/deployed_at`; post-deploy supply status message and follow-up buttons (Stake / Test) with correct emphasis.

**Test**
- [ ] Service union list; wallet auto-pick by stake; hints for unstaked wallet and undeployed service; pocket-ap presence/download.
- [ ] Probe list from card incl. bad-input probe; default probes without a card.
- [ ] Per-probe narration with supplier/session parsing; grading rules (JSON-first-byte, 4xx JSON error, status, JSONPath + regex); checklist with ms; JSONL log entry; final status.
- [ ] View log table newest-first; Clear log with confirm.

**Dashboard**
- [ ] Three clickable stats with the exact labels and sub-lines.
- [ ] Chain panel values and formats; next session maths with the grid anchor; services directory note (two variants in Electron: there is no built-in default root, see 3.11).
- [ ] Services table with supply, stakes, margin badges (5% threshold), relays estimate, alerts dangerbox text.
- [ ] Suppliers table rows clickable to Manage or Suppliers.
- [ ] Refresh re-reads params and balance.

**Activity**
- [ ] Newest-first, six columns, accepted/rejected badges, tx link opens the LCD tx URL for the entry's own network; "Nothing yet." empty row; refreshed after every broadcast.
