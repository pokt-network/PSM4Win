/* Pocket Service Manager: UI logic. Runs in the IE11 engine inside mshta, so
   this is ES5: no arrow functions, no let/const, no Promise, no fetch.
   Everything that signs or touches the keyring goes through signer.ps1 via
   runner.cmd; this file only reads the network (LCD over HTTPS) and drives
   the form. */

var PSM = (function () {
  "use strict";

  var fso = new ActiveXObject("Scripting.FileSystemObject");
  var sh = new ActiveXObject("WScript.Shell");
  var SEP = String.fromCharCode(92);
  var POKT = 1000000; // upokt per POKT

  var NET = {
    beta: { label: "Beta TestNet", lcd: "https://sauron-api.beta.infra.pocket.network", explorer: "https://explorer.pocket.network/beta" },
    main: { label: "MainNet", lcd: "https://sauron-api.infra.pocket.network", explorer: "https://explorer.pocket.network" }
  };
  // The server's shared Caddy lives here; each network's stack adds one site to it.
  var CADDY_DIR = "/opt/pocket/caddy";

  var state = {
    net: "beta",
    appDir: "",
    stateDir: "",
    runsDir: "",
    servicesRoot: "",
    skillScripts: "",
    docker: null,
    address: "",
    imported: false,
    params: {},
    catalog: null,
    catalogNet: "",
    regPlanOk: false,
    stkPlanOk: false,
    wallets: [],          // application wallets managed by the signer (wallets.json)
    walletsVerified: false,
    busy: false
  };
  var PARENT = "service-manager"; // the owner wallet's key name in the keyring

  // ------------------------------------------------------------ utils ----

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s === undefined || s === null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  function now() { return new Date().getTime(); }
  function trim(s) { return String(s === undefined || s === null ? "" : s).replace(/^\s+|\s+$/g, ""); }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function stamp() { var d = new Date(); return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds()); }
  function fmtPokt(upokt) {
    var n = Number(upokt) / POKT;
    if (isNaN(n)) return "?";
    var s = n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
    var parts = s.split(".");
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return parts.join(".");
  }
  function fmtInt(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }
  function fmtDuration(seconds) {
    if (seconds < 90) return Math.round(seconds) + " s";
    if (seconds < 5400) return Math.round(seconds / 60) + " min";
    if (seconds < 172800) return (seconds / 3600).toFixed(1).replace(/\.0$/, "") + " h";
    return (seconds / 86400).toFixed(1).replace(/\.0$/, "") + " days";
  }
  function join() { var p = arguments[0]; for (var i = 1; i < arguments.length; i++) p = fso.BuildPath(p, arguments[i]); return p; }

  function readUtf8(path) {
    if (!fso.FileExists(path)) return "";
    var st = new ActiveXObject("ADODB.Stream");
    st.Type = 2; st.Charset = "utf-8"; st.Open(); st.LoadFromFile(path);
    var t = st.ReadText(); st.Close(); return t;
  }
  function writeUtf8(path, text) {
    var st = new ActiveXObject("ADODB.Stream");
    st.Type = 2; st.Charset = "utf-8"; st.Open(); st.WriteText(text);
    // strip BOM: copy to a binary stream skipping 3 bytes
    st.Position = 0; st.Type = 1; st.Position = 3;
    var bin = new ActiveXObject("ADODB.Stream"); bin.Type = 1; bin.Open(); st.CopyTo(bin); st.Close();
    bin.SaveToFile(path, 2); bin.Close();
  }
  function shred(path) {
    try {
      if (!fso.FileExists(path)) return;
      var size = fso.GetFile(path).Size;
      var f = fso.OpenTextFile(path, 2, true);
      var blank = ""; for (var i = 0; i < size; i++) blank += " ";
      f.Write(blank); f.Close();
      fso.DeleteFile(path, true);
    } catch (e) { try { fso.DeleteFile(path, true); } catch (e2) {} }
  }
  function ensureDir(p) { if (!fso.FolderExists(p)) fso.CreateFolder(p); }

  function httpGet(url) {
    var x = new ActiveXObject("MSXML2.ServerXMLHTTP.6.0");
    x.setTimeouts(8000, 8000, 20000, 40000);
    x.open("GET", url, false);
    x.setRequestHeader("Accept", "application/json");
    x.send();
    return { status: x.status, text: x.responseText };
  }
  function lcd(path) {
    var r;
    try { r = httpGet(NET[state.net].lcd + path); } catch (e) { return { status: 0, json: null, error: e.message }; }
    var j = null; try { j = JSON.parse(r.text); } catch (e2) {}
    return { status: r.status, json: j };
  }

  // -------------------------------------------------------- run signer ----

  function run(op, payload, cb, opts) {
    opts = opts || {};
    payload = payload || {};
    payload.op = op;
    var id = now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
    var base = join(state.runsDir, id);
    writeUtf8(base + ".req.json", JSON.stringify(payload));
    var cmdline = '"' + join(state.appDir, "runner.cmd") + '" "' + state.runsDir + '" ' + id + ' "' + join(state.appDir, "signer.ps1") + '"';
    var env = sh.Environment("PROCESS");
    var k;
    if (opts.env) { for (k in opts.env) { if (opts.env.hasOwnProperty(k)) env(k) = opts.env[k]; } }
    sh.Run(cmdline, 0, false);
    if (opts.env) { for (k in opts.env) { if (opts.env.hasOwnProperty(k)) { try { env.Remove(k); } catch (e) {} } } }
    var t0 = now(), timeout = opts.timeoutMs || 240000;
    // Polling uses a self-rescheduling timeout, never setInterval: the IE engine
    // mishandles clearInterval from inside the interval's own callback when that
    // callback starts new timers, and the poll then fires forever.
    function tick() {
      if (fso.FileExists(base + ".done")) {
        var out = readUtf8(base + ".out"), err = readUtf8(base + ".err");
        var res;
        try { res = JSON.parse(out); } catch (e) {
          res = { ok: false, error: "The signer did not return a result.", detail: trim(err || out).substring(0, 3000) };
        }
        var files = [".req.json", ".out", ".err", ".done"];
        for (var i = 0; i < files.length; i++) { if (opts.shred) shred(base + files[i]); else { try { fso.DeleteFile(base + files[i], true); } catch (e3) {} } }
        cb(res);
        return;
      }
      if (now() - t0 > timeout) { cb({ ok: false, error: "Timed out waiting for the signer (" + Math.round(timeout / 1000) + "s)." }); return; }
      setTimeout(tick, 300);
    }
    setTimeout(tick, 300);
  }

  // ------------------------------------------------------------ modal ----

  function modal(title, bodyHtml, buttons, wide) {
    $("modalTitle").innerHTML = title;
    $("modalBody").innerHTML = bodyHtml;
    var bb = $("modalButtons"); bb.innerHTML = "";
    for (var i = 0; i < buttons.length; i++) {
      (function (b) {
        var el = document.createElement("button");
        el.className = "btn " + (b.cls || "");
        el.innerHTML = b.label;
        if (b.id) el.id = b.id;
        el.onclick = function () { if (b.onClick) b.onClick(); };
        bb.appendChild(el);
      })(buttons[i]);
    }
    $("modal").className = wide === true ? "wide" : (wide || "");
    $("modalWrap").className = "";
  }
  function closeModal() { $("modalWrap").className = "hidden"; $("modalBody").innerHTML = ""; }

  // ---------------------------------------------------------- welcome ----
  // Shown once on first run (settings.welcomeSeen) and on demand from Settings.
  // Content only: what the app does, what to have ready, the order of the steps.

  function showWelcome() {
    var h = '';
    h += '<p class="welcome-lead">Pocket Service Manager takes an HTTP API from a folder on this PC to a live service on Pocket Network. It writes the service card, registers the service on chain, turns a server of yours into a supplier that serves it, stakes the supplier and an application wallet, and tests real relays through the protocol. Every step is a button; you never type a <span class="mono">pocketd</span> command.</p>';
    h += '<div class="welcome-cols"><div>';
    h += '<h4>Have these ready</h4><ul class="checks">';
    h += '<li class="info"><b>Docker Desktop</b>, installed and running.<span class="sub">The Pocket tools run in containers here; the app downloads them once.</span></li>';
    h += '<li class="info"><b>A funded owner wallet.</b><span class="sub">The hex private key of a Pocket account holding POKT on the network you will use. It owns your services and pays the registration fee, the stakes, and the operator gas. Beta TestNet POKT comes from the faucet; MainNet spends real POKT.</span></li>';
    h += '<li class="info"><b>A Linux server</b> you can reach over SSH.<span class="sub">Docker Compose installed, a public hostname whose DNS already points at it, ports 80 and 443 open, and an OpenSSH key on this PC for the login user. One server hosts one supplier for any number of services.</span></li>';
    h += '<li class="info"><b>Your service backend</b> in a folder with a Dockerfile.<span class="sub">Any HTTP API: it must answer <span class="mono">GET /</span> with 2xx and return a JSON object on every response. Anything else, HTML included, rides inside a JSON field.</span></li>';
    h += '<li class="info"><b>Optional: Claude</b> with the pocket-service-builder Skill.<span class="sub">It can write the backend, the card, and the probes with you.</span></li>';
    h += '</ul></div><div>';
    h += '<h4>The steps, in order</h4><ol class="welcome-steps">';
    h += '<li>Pick the network and import the owner wallet.<span class="sub">Beta TestNet first; MainNet asks you to confirm every transaction.</span></li>';
    h += '<li>Create the service.<span class="sub">The form writes the card and validates it.</span></li>';
    h += '<li>Register it on chain.</li>';
    h += '<li>Add your server in Settings and provision it.<span class="sub">Installs the RelayMiner and creates the operator key on the server.</span></li>';
    h += '<li>Deploy the backend to that server.</li>';
    h += '<li>Stake the supplier and stake an application wallet.<span class="sub">Both take effect at the next session boundary.</span></li>';
    h += '<li>Test it.<span class="sub">Real relays through the protocol, graded against the card.</span></li>';
    h += '</ol></div></div>';
    h += '<p class="hint welcome-note">Fees and minimum stakes are read live from the network; the owner wallet card shows them. This message is available any time from Settings.</p>';
    modal('<img src="assets/pocket-mark-40.png" alt="">Welcome to Pocket Service Manager', h,
      [{ label: "Close", cls: "primary", onClick: function () { closeModal(); saveSettings({ welcomeSeen: true }); } }], "welcome");
  }

  // ------------------------------------------------------------ log ui ----

  function logTo(id, msg, cls) {
    var el = $(id); el.className = "log";
    var d = document.createElement("div");
    d.innerHTML = '<span class="t">' + stamp() + '</span><span class="' + (cls || "") + '">' + msg + '</span>';
    el.appendChild(d); el.scrollTop = el.scrollHeight;
  }
  function status(id, msg, cls) { var el = $(id); el.innerHTML = msg; el.className = "status " + (cls || ""); }
  // Results and logs belong to the network they ran on; wipe them when it changes.
  function clearResults() {
    var ids = ["reg", "stk", "dep", "tst", "sup", "prov", "dlg"];
    for (var i = 0; i < ids.length; i++) {
      var c = $(ids[i] + "Checks"), l = $(ids[i] + "Log"), s = $(ids[i] + "Status");
      if (c) c.innerHTML = ""; if (l) { l.className = "log hidden"; l.innerHTML = ""; } if (s) { s.innerHTML = ""; s.className = "status"; }
    }
    $("btnDeployStake").className = "btn hidden"; $("btnDeployTest").className = "btn hidden";
  }
  function foot(msg) { $("footText").innerHTML = msg; }
  function checks(id, items) {
    var h = "";
    for (var i = 0; i < items.length; i++) {
      h += '<li class="' + items[i].level + '">' + items[i].text + (items[i].sub ? '<span class="sub">' + items[i].sub + '</span>' : "") + "</li>";
    }
    $(id).innerHTML = h;
  }
  function hasFail(items) { for (var i = 0; i < items.length; i++) if (items[i].level === "fail") return true; return false; }

  // ------------------------------------------------------------- init ----

  function parseCommandLine() {
    // The HTA's own path comes from location.href; commandLine is only used for flags
    // because it is not exposed in every document mode.
    var cl = "";
    try { var app = document.getElementById("PSMApp"); if (app && app.commandLine) cl = String(app.commandLine); } catch (e) {}
    var path = "";
    var m = String(location.href || "").match(/^file:\/\/\/(.*)$/);
    if (m) path = decodeURIComponent(m[1]).replace(/\//g, SEP);
    if (!path) { var m2 = cl.match(/^\s*"([^"]+)"/); path = m2 ? m2[1] : cl.split(/\s+/)[0]; }
    var flag = join(sh.ExpandEnvironmentStrings("%LOCALAPPDATA%"), "PocketServiceManager", "selftest.flag");
    var selftest = /--selftest/.test(cl);
    if (fso.FileExists(flag)) { selftest = true; try { fso.DeleteFile(flag, true); } catch (e2) {} }
    return { path: path, selftest: selftest };
  }

  function init() {
    var cl = parseCommandLine();
    state.appDir = fso.GetParentFolderName(fso.GetAbsolutePathName(cl.path));
    state.stateDir = join(sh.ExpandEnvironmentStrings("%LOCALAPPDATA%"), "PocketServiceManager");
    ensureDir(state.stateDir);
    state.runsDir = join(state.stateDir, "runs"); ensureDir(state.runsDir);
    var repo = fso.GetParentFolderName(fso.GetParentFolderName(state.appDir));
    state.defaultServicesRoot = join(repo, "services");
    state.skillScripts = join(repo, "skills", "pocket-service-builder", "scripts");

    try { window.resizeTo(1320, 900); window.moveTo(Math.max(0, (screen.availWidth - 1320) / 2), Math.max(0, (screen.availHeight - 900) / 2)); } catch (e) {}
    goFrameless();

    var settings = loadSettings();
    if (settings.network === "main" || settings.network === "beta") state.net = settings.network;
    state.theme = settings.theme === "dark" ? "dark" : "light";
    state.servicesRoot = (settings.servicesRoot && fso.FolderExists(settings.servicesRoot)) ? settings.servicesRoot : state.defaultServicesRoot;
    $("setRoot").value = state.servicesRoot;
    applyTheme();
    applyNetworkUi();
    renderNav();
    loadServiceFolders();
    if (settings.lastService) { $("svcFolder").value = settings.lastService; onServiceFolder(); }

    if (cl.selftest) { selftest(); return; }
    tab("dashboard");
    dockerCycle(true);
    if (!settings.welcomeSeen) showWelcome();
  }

  // ------------------------------------------------------- side menu ----
  // An accordion: sections with one screen act as links, the others expand.

  var NAV = [
    { id: "dashboard", label: "Dashboard", screens: [["dashboard", "Dashboard"]] },
    { id: "services", label: "Services", screens: [["services", "My services"], ["create", "Create service"], ["register", "Register service"], ["stake", "Stake application"], ["deploy", "Deploy service"], ["test", "Test service"]] },
    { id: "suppliers", label: "Suppliers", screens: [["supply", "Supply service"]] },
    { id: "wallets", label: "Wallets", screens: [["wallets", "Wallets"]] },
    { id: "settings", label: "Settings", screens: [["settings", "Settings"]] }
  ];
  var navOpen = {};
  function sectionOf(screen) { for (var i = 0; i < NAV.length; i++) for (var j = 0; j < NAV[i].screens.length; j++) if (NAV[i].screens[j][0] === screen) return NAV[i]; return NAV[0]; }
  function renderNav() {
    var cur = state.screen || "dashboard", h = "";
    for (var i = 0; i < NAV.length; i++) {
      var s = NAV[i], single = s.screens.length === 1, active = sectionOf(cur).id === s.id, open = single ? false : (navOpen[s.id] === undefined ? active : navOpen[s.id]);
      h += '<div class="sec' + (open ? " open" : "") + '">';
      h += '<a class="hd' + (active ? " on" : "") + '" onclick="PSM.' + (single ? "tab('" + s.screens[0][0] + "')" : "navToggle('" + s.id + "')") + '">' + esc(s.label) + (single ? "" : '<span class="chev">&#9654;</span>') + '</a>';
      if (!single) {
        h += '<div class="items">';
        for (var j = 0; j < s.screens.length; j++) h += '<a class="item' + (s.screens[j][0] === cur ? " on" : "") + '" onclick="PSM.tab(\'' + s.screens[j][0] + '\')">' + esc(s.screens[j][1]) + '</a>';
        h += '</div>';
      }
      h += '</div>';
    }
    $("nav").innerHTML = h;
  }
  function navToggle(id) {
    var isOpen = navOpen[id] === undefined ? (sectionOf(state.screen || "dashboard").id === id) : navOpen[id];
    navOpen[id] = !isOpen;
    renderNav();
  }

  function loadSettings() {
    try { var t = readUtf8(join(state.stateDir, "settings.json")); return t ? JSON.parse(t) : {}; } catch (e) { return {}; }
  }
  function saveSettings(patch) {
    if (state.noSave) return; // selftest must not disturb the user's saved preferences
    var s = loadSettings();
    for (var k in patch) if (patch.hasOwnProperty(k)) s[k] = patch[k];
    writeUtf8(join(state.stateDir, "settings.json"), JSON.stringify(s));
  }

  // ----------------------------------------------------------- docker ----

  var dockerRetry = null;
  function dockerReady() { return !!(state.docker && state.docker.ok && state.docker.image); }

  // Checks Docker and the pocketd image, updates the top bar, and calls cb(ready).
  // While Docker is down it keeps re-checking in the background, because the user
  // may start Docker Desktop themselves at any time.
  function dockerCycle(first, cb) {
    foot("Checking Docker Desktop");
    run("docker-check", {}, function (r) {
      state.docker = r;
      var ds = $("dockerState");
      if (!r.ok) {
        ds.className = "bad";
        $("dockerText").innerHTML = "Docker: " + esc(r.error) + ' <button onclick="PSM.startDocker()">Start Docker Desktop</button><button onclick="PSM.recheckDocker()">Re-check</button>';
        foot("Docker Desktop is not running. Nothing can be signed until it is.");
        walletStatus();
        if (!dockerRetry) {
          dockerRetry = true;
          var retry = function () {
            run("docker-check", {}, function (c) { if (c.ok) { dockerRetry = null; dockerCycle(true); } else setTimeout(retry, 10000); });
          };
          setTimeout(retry, 10000);
        }
        if (cb) cb(false);
        return;
      }
      if (!r.image) {
        ds.className = "";
        $("dockerText").innerHTML = "Docker " + esc(r.docker) + ", pocketd not downloaded " + ' <button onclick="PSM.pullImage()">Download pocketd</button><button onclick="PSM.recheckDocker()">Re-check</button>';
        foot("Download the pocketd image once; it is about 100 MB.");
        walletStatus();
        if (cb) cb(false);
        return;
      }
      ds.className = "ok";
      $("dockerText").innerHTML = "Docker " + esc(r.docker) + ", pocketd " + esc(r.pocketd);
      foot("Ready");
      walletStatus();
      if (first) { refreshNetwork(); loadHistory(); }
      if (cb) cb(true);
    });
  }
  function recheckDocker() { dockerCycle(true); }
  function startDocker() {
    $("dockerText").innerHTML = '<span class="status busy">Starting Docker Desktop, this can take a minute</span>';
    run("docker-start", {}, function (r) {
      if (!r.ok) { $("dockerText").innerHTML = "Docker: " + esc(r.error); return; }
      var tries = 0;
      function again() {
        tries++;
        run("docker-check", {}, function (c) {
          if (c.ok || tries > 24) dockerCycle(true); else setTimeout(again, 5000);
        });
      }
      setTimeout(again, 5000);
    });
  }
  function pullImage() {
    $("dockerText").innerHTML = '<span class="status busy">Downloading pocketd image</span>';
    run("image-pull", {}, function (r) {
      if (!r.ok) { $("dockerText").innerHTML = "Download failed: " + esc(r.error) + " " + esc(r.detail); return; }
      dockerCycle(true);
    }, { timeoutMs: 900000 });
  }

  // ----------------------------------------------------------- wallet ----

  function walletStatus() {
    run("wallet-status", {}, function (r) {
      state.imported = !!r.imported;
      state.address = r.address || "";
      $("walletNone").className = r.imported ? "hidden" : "";
      $("walletSome").className = r.imported ? "" : "hidden";
      $("walletPartial").className = (!r.imported && r.partial) ? "warnbox" : "hidden";
      if (r.imported) {
        $("walletAddr").innerHTML = esc(r.address) + (r.verified ? "" : ' <span class="badge muted">not verified, Docker is down</span>');
        refreshBalance();
      }
      populateStakeSelect();
      // The wallet answer arrives after the first screen has drawn, so repaint
      // whatever is open that shows owner-dependent numbers.
      loadWallets(false, function () {
        renderServices();
        if (state.screen === "dashboard") renderDashboard();
        if (state.screen === "wallets") renderWallets();
        if (state.screen === "test") onTestServiceChange();
      });
    });
  }

  // ---------------------------------------------------------- wallets ----
  // Application wallets: an account can be staked as an application for exactly
  // one service, so each service gets its own wallet. They live in the same
  // encrypted keyring as the owner wallet; the signer keeps the list
  // (wallets.json) and this file only reads balances and stakes from the network.

  function balanceOf(addr) {
    var ob = lcd("/cosmos/bank/v1beta1/balances/" + addr), bal = 0;
    if (ob.status !== 200) return null;
    if (ob.json && ob.json.balances) for (var b = 0; b < ob.json.balances.length; b++) if (ob.json.balances[b].denom === "upokt") bal = Number(ob.json.balances[b].amount);
    return bal;
  }
  function appRecordOf(addr) {
    if (!addr) return null;
    var r = lcd("/pokt-network/poktroll/application/application/" + addr);
    return (r.status === 200 && r.json && r.json.application) ? r.json.application : null;
  }
  function appServiceIds(a) { var ids = []; for (var i = 0; i < ((a && a.service_configs) || []).length; i++) ids.push(a.service_configs[i].service_id); return ids; }

  function walletByName(name) {
    if (!name || name === PARENT) return state.imported ? { name: PARENT, address: state.address, parent: true, service_id: "" } : null;
    for (var i = 0; i < state.wallets.length; i++) if (state.wallets[i].name === name) return state.wallets[i];
    return null;
  }
  function walletForService(id) {
    for (var i = 0; i < state.wallets.length; i++) if (state.wallets[i].service_id === id) return state.wallets[i];
    return null;
  }

  function loadWallets(render, cb) {
    run("wallet-list", {}, function (r) {
      state.wallets = (r.ok && r.wallets) ? r.wallets : [];
      state.walletsVerified = !!(r.ok && r.verified);
      populateStakeFrom();
      if (render) renderWallets();
      if (cb) cb();
    });
  }

  function shortAddr(a) { a = String(a || ""); return a.length > 16 ? a.substring(0, 10) + "&hellip;" + a.substring(a.length - 5) : esc(a); }

  function renderWallets() {
    var box = $("walList");
    $("walNetBadge").innerHTML = NET[state.net].label; $("walNetBadge").className = "badge " + (state.net === "main" ? "bad" : "info");
    if (!state.imported) { box.innerHTML = '<div class="empty"><div class="orbit"></div><p>Import the owner wallet first (side panel). Application wallets are created inside its keyring.</p></div>'; return; }
    var rows = [{ name: PARENT, address: state.address, parent: true, service_id: "", present: true }].concat(state.wallets);
    var h = '<table class="services"><tr><th>Wallet</th><th>For service</th><th>Address</th><th>Balance</th><th>Application stake on ' + esc(NET[state.net].label) + '</th><th>Actions</th></tr>';
    for (var i = 0; i < rows.length; i++) {
      var w = rows[i], bal = balanceOf(w.address), app = appRecordOf(w.address), ids = appServiceIds(app);
      var nameCell = '<span class="svcid">' + esc(w.name) + '</span>' + (w.parent ? ' <span class="badge blue">owner</span>' : (w.present === false ? ' <span class="badge bad">missing from keyring</span>' : ""));
      var stakeCell = app ? fmtPokt(app.stake.amount) + " POKT for <b>" + esc(ids.join(", ") || "?") + "</b>" + (appUnbonding(app) ? ' <span class="badge warn">unbonding</span>' : "") + (!w.parent && w.service_id && ids.length && ids[0] !== w.service_id ? ' <span class="badge warn">not ' + esc(w.service_id) + '</span>' : "") : '<span class="hint">none</span>';
      var actions = "";
      if (w.parent) actions += '<button class="btn small" onclick="PSM.copy(\'' + esc(w.address) + '\')">Copy address</button>';
      else {
        actions += '<button class="btn small" onclick="PSM.copy(\'' + esc(w.address) + '\')">Copy address</button>';
        actions += '<button class="btn small" onclick="PSM.fundWalletDialog(\'' + esc(w.name) + '\')">Fund</button>';
        actions += '<button class="btn small" onclick="PSM.svcStakeAs(\'' + esc(w.service_id || (ids[0] || "")) + '\',\'' + esc(w.name) + '\')">' + (app ? "Restake" : "Stake") + '</button>';
        actions += '<button class="btn small" onclick="PSM.exportWalletDialog(\'' + esc(w.name) + '\')">Export key</button>';
        actions += '<button class="btn small danger" onclick="PSM.removeWalletDialog(\'' + esc(w.name) + '\')">Remove</button>';
      }
      h += '<tr><td>' + nameCell + '</td><td>' + (w.service_id ? esc(w.service_id) : '<span class="hint">' + (w.parent ? "registers services" : "unassigned") + '</span>') + '</td><td class="mono" title="' + esc(w.address) + '">' + shortAddr(w.address) + '</td><td>' + (bal === null ? "?" : fmtPokt(bal) + " POKT") + '</td><td>' + stakeCell + '</td><td class="actions">' + actions + '</td></tr>';
    }
    h += "</table>";
    if (!state.walletsVerified) h += '<div class="hint" style="margin-top:6px">Docker is down, so the list could not be checked against the keyring.</div>';
    box.innerHTML = h;
  }

  function serviceOptionsHtml(selected) {
    var ids = [], seen = {}, owned = ownedServices(), local = localServices();
    for (var i = 0; i < owned.length; i++) { if (!seen[owned[i].id]) { seen[owned[i].id] = true; ids.push(owned[i].id); } }
    for (var j = 0; j < local.length; j++) { if (!seen[local[j].id]) { seen[local[j].id] = true; ids.push(local[j].id); } }
    var h = '<option value="">(choose later)</option>';
    for (var k = 0; k < ids.length; k++) h += '<option value="' + esc(ids[k]) + '"' + (ids[k] === selected ? " selected" : "") + '>' + esc(ids[k]) + '</option>';
    return h;
  }
  function walletReady(what) {
    if (!state.imported) { alert("Import the owner wallet first; " + what + " needs its keyring."); return false; }
    if (!dockerReady()) { alert("Docker Desktop must be running with the pocketd image downloaded."); return false; }
    return true;
  }
  function validWalletName(name, hintId) {
    if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(name)) { $(hintId).innerHTML = '<span style="color:#b71c1c">Lowercase letters, digits, hyphen, underscore; 1 to 40 characters.</span>'; return false; }
    if (name === PARENT) { $(hintId).innerHTML = '<span style="color:#b71c1c">That is the owner wallet\'s name.</span>'; return false; }
    if (walletByName(name)) { $(hintId).innerHTML = '<span style="color:#b71c1c">A wallet with that name already exists.</span>'; return false; }
    return true;
  }
  function onNewWalletService() { var s = $("nwService").value; if (s && !$("nwName").getAttribute("data-manual")) $("nwName").value = "app-" + s; }

  function newWalletDialog() {
    if (!walletReady("creating a wallet")) return;
    modal("New application wallet",
      '<p>Creates a new key in the encrypted keyring, to be staked as an application for one service. Pick the service it will call; the name follows from it.</p>' +
      '<label>Service</label><select id="nwService" onchange="PSM.onNewWalletService()">' + serviceOptionsHtml($("stkId").value) + '</select>' +
      '<label>Wallet name</label><input type="text" id="nwName" maxlength="40" onkeyup="this.setAttribute(\'data-manual\',\'1\')">' +
      '<div class="hint" id="nwHint">Lowercase letters, digits, hyphen, underscore.</div>' +
      '<div class="warnbox">The 24-word recovery phrase is shown once, right after creation, and is not stored anywhere. Have your password manager ready and close any screen sharing.</div>',
      [
        { label: "Cancel", id: "nwCancel", onClick: closeModal },
        { label: "Create wallet", cls: "primary", id: "nwGo", onClick: doCreateWallet }
      ]);
    onNewWalletService();
  }
  function doCreateWallet() {
    var name = trim($("nwName").value), sid = $("nwService").value;
    if (!validWalletName(name, "nwHint")) return;
    $("nwGo").disabled = true; $("nwCancel").disabled = true; $("nwHint").innerHTML = '<span class="status busy">Creating the key</span>';
    run("wallet-create", { name: name, service_id: sid }, function (r) {
      if (!r.ok) { if ($("nwGo")) { $("nwGo").disabled = false; $("nwCancel").disabled = false; $("nwHint").innerHTML = '<span style="color:#b71c1c">' + esc(r.error) + " " + esc(r.detail) + "</span>"; } else foot("Wallet creation failed: " + r.error); return; }
      showMnemonic(r);
    }, { shred: true });
  }
  function showMnemonic(r) {
    var name = String(r.name), address = String(r.address); // kept for the Done handler; r itself is dropped below
    var words = String(r.mnemonic || "").split(" "), h = '<table class="kv" style="width:100%"><tr>';
    for (var i = 0; i < words.length; i++) { h += '<td class="mono" style="padding:3px 6px"><span class="hint">' + (i + 1) + '</span> ' + esc(words[i]) + '</td>'; if (i % 4 === 3 && i < words.length - 1) h += "</tr><tr>"; }
    h += "</tr></table>";
    modal("Write down the recovery phrase",
      '<p>Wallet <b>' + esc(r.name) + '</b> was created with address <span class="mono">' + esc(r.address) + '</span>.</p>' +
      '<div class="dangerbox">These ' + words.length + ' words are the only way to recover this wallet outside this machine. They are shown once and are not stored anywhere. Anyone who has them controls the wallet.</div>' +
      '<div class="keybox" id="nwPhrase">' + h + '</div>' +
      '<div class="btnrow"><button class="btn small" onclick="PSM.copy(\'' + esc(words.join(" ")) + '\')">Copy phrase to clipboard</button></div>' +
      '<p><input type="checkbox" id="nwSaved" onclick="document.getElementById(\'nwDone\').disabled=!this.checked"> <label for="nwSaved" style="display:inline">I have written down all ' + words.length + ' words in order.</label></p>',
      [{ label: "Done", cls: "primary", id: "nwDone", onClick: function () { closeModal(); foot("Wallet " + name + " created: " + address); loadWallets(true); } }], true);
    $("nwDone").disabled = true;
    r = null; words = null;
  }

  function recoverWalletDialog() {
    if (!walletReady("recovering a wallet")) return;
    modal("Recover a wallet from its phrase",
      '<p>Re-creates a key in the keyring from a 12 or 24 word recovery phrase, for example an application wallet made on another machine.</p>' +
      '<label>Service</label><select id="rwService" onchange="var s=this.value;if(s)document.getElementById(\'rwName\').value=\'app-\'+s">' + serviceOptionsHtml($("stkId").value) + '</select>' +
      '<label>Wallet name</label><input type="text" id="rwName" maxlength="40"><div class="hint" id="rwHint">Lowercase letters, digits, hyphen, underscore.</div>' +
      '<label>Recovery phrase</label><textarea id="rwPhrase" rows="3" autocomplete="off" spellcheck="false"></textarea>' +
      '<div class="warnbox">The phrase is handed to pocketd through the process environment, never through a file or the command line. Close any screen sharing before pasting.</div>',
      [
        { label: "Cancel", id: "rwCancel", onClick: closeModal },
        { label: "Recover", cls: "primary", id: "rwGo", onClick: doRecoverWallet }
      ]);
  }
  function doRecoverWallet() {
    var name = trim($("rwName").value), sid = $("rwService").value, phrase = trim($("rwPhrase").value).replace(/\s+/g, " ").toLowerCase();
    if (!validWalletName(name, "rwHint")) return;
    var n = phrase ? phrase.split(" ").length : 0;
    if (!(n === 12 || n === 15 || n === 18 || n === 21 || n === 24)) { $("rwHint").innerHTML = '<span style="color:#b71c1c">A recovery phrase has 12 or 24 words; this has ' + n + '.</span>'; return; }
    $("rwGo").disabled = true; $("rwCancel").disabled = true; $("rwHint").innerHTML = '<span class="status busy">Recovering the key</span>';
    run("wallet-recover", { name: name, service_id: sid }, function (r) {
      var ta = $("rwPhrase"); if (ta) ta.value = "";
      if (!r.ok) { if ($("rwGo")) { $("rwGo").disabled = false; $("rwCancel").disabled = false; $("rwHint").innerHTML = '<span style="color:#b71c1c">' + esc(r.error) + " " + esc(r.detail) + "</span>"; } else foot("Recovery failed: " + r.error); return; }
      closeModal(); foot("Wallet " + r.name + " recovered: " + r.address); loadWallets(true);
    }, { env: { PSM_IMPORT_MNEMONIC: phrase }, shred: true });
    phrase = null;
  }

  function importAppWalletDialog() {
    if (!walletReady("importing a wallet")) return;
    modal("Import an application wallet key",
      '<p>Adds an existing key to the keyring from its 64-character hex private key.</p>' +
      '<label>Service</label><select id="iwService" onchange="var s=this.value;if(s)document.getElementById(\'iwName\').value=\'app-\'+s">' + serviceOptionsHtml($("stkId").value) + '</select>' +
      '<label>Wallet name</label><input type="text" id="iwName" maxlength="40"><div class="hint" id="iwHint">Lowercase letters, digits, hyphen, underscore.</div>' +
      '<label>Private key (hex)</label><input type="password" id="iwKey" autocomplete="off">' +
      '<div class="warnbox">The key is handed to pocketd through the process environment, never through a file or the command line.</div>',
      [
        { label: "Cancel", id: "iwCancel", onClick: closeModal },
        { label: "Import", cls: "primary", id: "iwGo", onClick: doImportAppWallet }
      ]);
  }
  function doImportAppWallet() {
    var name = trim($("iwName").value), sid = $("iwService").value, hex = trim($("iwKey").value).replace(/^0[xX]/, "");
    if (!validWalletName(name, "iwHint")) return;
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) { $("iwHint").innerHTML = '<span style="color:#b71c1c">That is not a 64-character hex key.</span>'; return; }
    $("iwGo").disabled = true; $("iwCancel").disabled = true; $("iwHint").innerHTML = '<span class="status busy">Importing the key</span>';
    run("wallet-import-app", { name: name, service_id: sid }, function (r) {
      var k = $("iwKey"); if (k) k.value = "";
      if (!r.ok) { if ($("iwGo")) { $("iwGo").disabled = false; $("iwCancel").disabled = false; $("iwHint").innerHTML = '<span style="color:#b71c1c">' + esc(r.error) + " " + esc(r.detail) + "</span>"; } else foot("Import failed: " + r.error); return; }
      closeModal(); foot("Wallet " + r.name + " imported: " + r.address); loadWallets(true);
    }, { env: { PSM_IMPORT_KEY: hex }, shred: true });
    hex = null;
  }

  function exportWalletDialog(name) {
    if (!walletReady("exporting a key")) return;
    var w = walletByName(name); if (!w || w.parent) return;
    modal("Show the private key of " + esc(name),
      '<div class="dangerbox">The key stays in the keyring; this only displays it, for example to give a relay client such as pocket-ap its <span class="mono">POCKET_APP_PRIVATE_KEY</span>. Anyone who sees it controls the wallet and its stake. Close any screen sharing first.</div>' +
      '<p>Type <b>EXPORT</b> to continue.</p><input type="text" id="exConfirm" autocomplete="off">',
      [
        { label: "Cancel", onClick: closeModal },
        { label: "Show key", cls: "danger solid", onClick: function () {
            if (trim($("exConfirm").value) !== "EXPORT") return;
            $("modalBody").innerHTML = '<p class="status busy">Reading the key from the keyring</p>';
            run("wallet-export", { name: name }, function (r) {
              if (!r.ok) { $("modalBody").innerHTML = '<div class="dangerbox">' + esc(r.error) + " " + esc(r.detail) + "</div>"; return; }
              modal("Private key of " + esc(name),
                '<p>Address <span class="mono">' + esc(w.address) + '</span></p>' +
                '<div class="keybox" id="exKey">' + esc(r.hex) + '</div>' +
                '<div class="btnrow"><button class="btn small" onclick="PSM.copy(document.getElementById(\'exKey\').innerText)">Copy to clipboard</button></div>' +
                '<div class="hint">On the supplier host, pocket-ap reads it from the POCKET_APP_PRIVATE_KEY environment variable; do not put it in a file that is committed.</div>',
                [{ label: "Close", cls: "primary", onClick: closeModal }]);
              r = null;
            }, { shred: true });
          } }
      ]);
  }

  function removeWalletDialog(name) {
    if (!walletReady("removing a wallet")) return;
    var w = walletByName(name); if (!w || w.parent) return;
    var bal = balanceOf(w.address), app = appRecordOf(w.address), warn = "";
    if (bal) warn += '<div class="dangerbox">This wallet holds <b>' + fmtPokt(bal) + ' POKT</b> on ' + esc(NET[state.net].label) + '. Without its key or phrase those funds are lost.</div>';
    if (app) warn += '<div class="dangerbox">This wallet is staked as an application with <b>' + fmtPokt(app.stake.amount) + ' POKT</b> for ' + esc(appServiceIds(app).join(", ")) + '. The stake stays on chain and can only be unstaked with this key.</div>';
    modal("Remove wallet " + esc(name),
      '<p>Deletes the key <b>' + esc(name) + '</b> (' + shortAddr(w.address) + ') from the keyring on this machine. Nothing on the network changes.</p>' + warn +
      (bal || app ? '<p>Export the key first if you have not saved the recovery phrase.</p>' : "") +
      '<p>Type the wallet name to confirm.</p><input type="text" id="rmConfirm" autocomplete="off">',
      [
        { label: "Cancel", onClick: closeModal },
        { label: "Remove from this machine", cls: "danger solid", onClick: function () {
            if (trim($("rmConfirm").value) !== name) return;
            $("modalBody").innerHTML = '<p class="status busy">Removing the key</p>';
            run("wallet-remove", { name: name, confirm: name }, function (r) {
              if (!r.ok) { $("modalBody").innerHTML = '<div class="dangerbox">' + esc(r.error) + " " + esc(r.detail) + "</div>"; return; }
              closeModal(); foot("Wallet " + name + " removed."); loadWallets(true);
            });
          } }
      ]);
  }

  // Sends POKT from the owner wallet to an application wallet, then calls cb(ok).
  function fundWallet(name, upokt, statusId, cb) {
    if (state.busy) return;
    var w = walletByName(name);
    if (!w || w.parent) { status(statusId, "Choose an application wallet to fund.", "err"); return; }
    if (!(upokt > 0)) { status(statusId, "Enter an amount in POKT.", "err"); return; }
    if (!state.imported || !dockerReady()) { status(statusId, "Owner wallet and Docker must be ready.", "err"); return; }
    refreshBalance();
    if (state.balance !== null && state.balance < upokt + 1 * POKT) { status(statusId, "The owner wallet holds " + fmtPokt(state.balance) + " POKT; not enough for " + fmtPokt(upokt) + " plus gas.", "err"); return; }
    var go = function () {
      state.busy = true; status(statusId, "Sending " + fmtPokt(upokt) + " POKT to " + esc(name));
      run("tx-fund-wallet", { network: state.net, name: name, amount_upokt: upokt }, function (r) {
        if (!r.ok) { state.busy = false; status(statusId, esc(r.error) + " " + esc(r.detail || ""), "err"); if (cb) cb(false); return; }
        status(statusId, "Broadcast, waiting for the block (" + esc(r.txhash.substring(0, 10)) + ")");
        pollTx(r.txhash, function (t) {
          state.busy = false;
          if (!t.ok) { status(statusId, esc(t.error), "err"); if (cb) cb(false); return; }
          refreshBalance(); loadHistory();
          status(statusId, "Sent " + fmtPokt(upokt) + " POKT to " + esc(name) + " in block " + fmtInt(t.height) + ".", "ok");
          if (cb) cb(true);
        });
      });
    };
    if (state.net === "main") {
      modal("Confirm MainNet transfer",
        '<div class="dangerbox">This sends <b>' + fmtPokt(upokt) + ' POKT</b> of real funds from the owner wallet to <b>' + esc(name) + '</b> (' + esc(w.address) + '). Transfers cannot be reversed.</div><p>Type <b>SEND</b> to confirm.</p><input type="text" id="mainConfirm" autocomplete="off">',
        [{ label: "Cancel", onClick: closeModal }, { label: "Send on MainNet", cls: "danger solid", onClick: function () { if (trim($("mainConfirm").value) !== "SEND") return; closeModal(); go(); } }]);
    } else if (confirm("Send " + fmtPokt(upokt) + " POKT from the owner wallet to " + name + " on Beta TestNet?")) go();
  }
  function fundWalletDialog(name) {
    var w = walletByName(name); if (!w || w.parent) return;
    var bal = balanceOf(w.address) || 0, min = state.params.appMinStake || 0, suggest = Math.max(0, min + 2 * POKT - bal);
    modal("Fund " + esc(name) + " from the owner wallet",
      '<p>' + esc(name) + ' holds ' + fmtPokt(bal) + ' POKT on ' + esc(NET[state.net].label) + '. The application minimum stake is ' + (min ? fmtPokt(min) : "?") + ' POKT, plus about 1 POKT for gas.</p>' +
      '<label>Amount (POKT)</label><input type="number" id="fwAmount" min="0" step="1" value="' + (suggest ? Math.ceil(suggest / POKT) : "") + '">' +
      '<div class="status" id="fwStatus"></div>',
      [{ label: "Close", id: "fwClose", onClick: closeModal }, { label: "Send", cls: "primary", id: "fwGo", onClick: function () {
          var pokt = parseFloat($("fwAmount").value);
          fundWallet(name, Math.round(pokt * POKT), "fwStatus", function (ok) { if (ok) { setTimeout(function () { closeModal(); loadWallets(true); }, 1500); } });
        } }]);
  }

  function refreshBalance() {
    if (!state.address) return;
    var r = lcd("/cosmos/bank/v1beta1/balances/" + state.address);
    var bal = 0;
    if (r.json && r.json.balances) {
      for (var i = 0; i < r.json.balances.length; i++) if (r.json.balances[i].denom === "upokt") bal = Number(r.json.balances[i].amount);
    }
    state.balance = (r.status === 200) ? bal : null;
    $("walletBal").innerHTML = (state.balance === null) ? "?" : fmtPokt(bal);
    $("walletBalNote").innerHTML = "balance on " + NET[state.net].label + (state.balance === null ? " (could not read the network)" : "");
  }

  function importDialog() {
    if (!state.docker || !state.docker.ok || !state.docker.image) { alert("Docker Desktop must be running and the pocketd image downloaded before a key can be imported."); return; }
    modal("Import the wallet private key",
      '<p>Paste the 64-character hex private key of the wallet that will own your services. This is the only time it is entered. It is imported into an encrypted keyring inside a Docker volume, the keyring passphrase is random and sealed to your Windows login, and the key is never displayed again unless you use Revoke.</p>' +
      '<div class="warnbox">The key is handed to pocketd through the process environment, never through a file or the command line. Close any screen-sharing before pasting.</div>' +
      '<label>Private key (hex)</label><input type="password" id="impKey" autocomplete="off">' +
      '<div class="hint" id="impHint">Optional 0x prefix is fine.</div>',
      [
        { label: "Cancel", id: "impCancel", onClick: closeModal },
        { label: "Import", cls: "primary", id: "impGo", onClick: doImport }
      ]);
    setTimeout(function () { try { $("impKey").focus(); } catch (e) {} }, 50);
  }
  function doImport() {
    var raw = trim($("impKey").value);
    var hex = raw.replace(/^0[xX]/, "");
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) { $("impHint").innerHTML = '<span style="color:#b71c1c">That is not a 64-character hex key.</span>'; return; }
    $("impGo").disabled = true; $("impCancel").disabled = true; $("impHint").innerHTML = "Importing, this takes a few seconds";
    run("wallet-import", {}, function (r) {
      // The dialog may already be gone by the time the signer answers; never assume its elements exist.
      var key = $("impKey"), go = $("impGo"), cancel = $("impCancel"), hint = $("impHint");
      if (key) key.value = "";
      if (!r.ok) {
        if (go) go.disabled = false;
        if (cancel) cancel.disabled = false;
        if (hint) hint.innerHTML = '<span style="color:#b71c1c">' + esc(r.error) + " " + esc(r.detail) + "</span>";
        else foot("Import failed: " + r.error);
        return;
      }
      closeModal();
      foot("Wallet imported: " + r.address);
      walletStatus();
    }, { env: { PSM_IMPORT_KEY: hex }, shred: true });
    raw = null; hex = null;
  }

  function revokeDialog() {
    var apps = state.wallets.length;
    modal("Revoke the wallet key",
      '<div class="dangerbox">Revoking shows the private key one time so you can store it elsewhere, then deletes the encrypted keyring, the Docker volume, and the sealed passphrase from this machine. Registered services and stakes on the network are not affected.</div>' +
      (apps ? '<div class="dangerbox">The keyring also holds <b>' + apps + ' application wallet' + (apps === 1 ? "" : "s") + '</b>, which would be deleted with it. Export or remove them on the Wallets tab first; the signer refuses to revoke while they exist.</div>' : "") +
      '<p>Type <b>REVOKE</b> to continue.</p><input type="text" id="revConfirm" autocomplete="off">',
      [
        { label: "Cancel", onClick: closeModal },
        { label: "Show key and continue", cls: "danger solid", onClick: function () {
            if (trim($("revConfirm").value) !== "REVOKE") { return; }
            $("modalBody").innerHTML = '<p class="status busy">Exporting the key from the keyring</p>';
            run("wallet-export", {}, function (r) {
              if (!r.ok) { $("modalBody").innerHTML = '<div class="dangerbox">' + esc(r.error) + " " + esc(r.detail) + "</div>"; return; }
              showExported(r.hex);
            }, { shred: true });
          } }
      ]);
  }
  function showExported(hex) {
    modal("Save this key now",
      '<p>This is the wallet private key. It will not be shown again. Copy it into your password manager before deleting.</p>' +
      '<div class="keybox" id="revKey">' + esc(hex) + '</div>' +
      '<div class="btnrow"><button class="btn small" onclick="PSM.copy(document.getElementById(\'revKey\').innerText)">Copy to clipboard</button></div>',
      [
        { label: "Keep the key, cancel revoke", onClick: function () { closeModal(); } },
        { label: "I saved it. Delete from this machine", cls: "danger solid", onClick: function () {
            $("modalBody").innerHTML = '<p class="status busy">Deleting the keyring volume and sealed passphrase</p>';
            run("wallet-delete", {}, function (r) {
              if (!r.ok) { $("modalBody").innerHTML = '<div class="dangerbox">' + esc(r.error) + " " + esc(r.detail) + "</div>"; return; }
              closeModal(); foot("Wallet key deleted from this machine."); walletStatus();
            });
          } }
      ]);
    hex = null;
  }

  function copy(text) { try { window.clipboardData.setData("Text", text); foot("Copied to clipboard"); } catch (e) { alert("Could not access the clipboard."); } }

  // ---------------------------------------------------------- network ----

  function setNetwork(n) {
    if (state.busy) { alert("Wait for the current transaction to finish before switching networks."); return; }
    if (n === "main" && state.net !== "main") {
      if (!confirm("Switch to MainNet? Transactions there spend real POKT.")) return;
    }
    state.net = n;
    saveSettings({ network: n });
    applyNetworkUi();
    state.regPlanOk = false; state.stkPlanOk = false;
    $("btnRegister").disabled = true; $("btnStake").disabled = true;
    $("regResults").className = "panel hidden"; $("stkResults").className = "panel hidden";
    state.supPlanOk = false; state.supForm = null; state.sup = null; state.deployed = null;
    clearResults();
    refreshNetwork();
    refreshBalance();
    // Every screen reads state.net when it renders, so repaint the one that is open.
    // A supplier being edited belongs to the old network; tab() drops back to the list.
    tab(state.screen || "dashboard");
  }
  // Same sun and moon glyphs as the other Pocket web surfaces (analytics ThemeToggle).
  var ICON_SUN = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';
  var ICON_MOON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';

  function applyTheme() {
    var main = state.net === "main";
    document.body.className = (main ? "net-main" : "net-beta") + (state.theme === "dark" ? " theme-dark" : "");
    var b = $("themeBtn");
    b.innerHTML = state.theme === "dark" ? ICON_SUN : ICON_MOON;
    b.title = state.theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
  }
  function toggleTheme() {
    state.theme = state.theme === "dark" ? "light" : "dark";
    saveSettings({ theme: state.theme });
    applyTheme();
  }

  function applyNetworkUi() {
    var main = state.net === "main";
    applyTheme();
    $("svcNetBadge").innerHTML = NET[state.net].label;
    $("svcNetBadge").className = "badge " + (main ? "bad" : "info");
    $("netBeta").className = "net" + (main ? "" : " on");
    $("netMain").className = "net" + (main ? " on main" : "");
    $("dashNetBadge").innerHTML = NET[state.net].label;
    $("dashNetBadge").className = "badge " + (main ? "bad" : "info");
    $("btnRegister").innerHTML = "Register on " + NET[state.net].label;
    $("btnStake").innerHTML = "Stake on " + NET[state.net].label;
    $("btnSupply").innerHTML = "Stake supplier on " + NET[state.net].label;
    $("walNetBadge").innerHTML = NET[state.net].label;
    $("walNetBadge").className = "badge " + (main ? "bad" : "info");
  }

  function refreshNetwork() {
    var p = {};
    var r = lcd("/pokt-network/poktroll/service/params"); if (r.json && r.json.params) p.addServiceFee = Number(r.json.params.add_service_fee.amount);
    r = lcd("/pokt-network/poktroll/application/params"); if (r.json && r.json.params) { p.appMinStake = Number(r.json.params.min_stake.amount); p.appMaxDelegated = Number(r.json.params.max_delegated_gateways || 0); }
    r = lcd("/pokt-network/poktroll/supplier/params"); if (r.json && r.json.params) p.supMinStake = Number(r.json.params.min_stake.amount);
    r = lcd("/pokt-network/poktroll/shared/params");
    if (r.json && r.json.params) {
      p.cuMultiplier = Number(r.json.params.compute_units_to_tokens_multiplier); p.cuGranularity = Number(r.json.params.compute_unit_cost_granularity); p.blocksPerSession = Number(r.json.params.num_blocks_per_session);
      p.sessionAnchor = Number(r.json.params.session_grid_anchor_height); p.supplierUnbondingSessions = Number(r.json.params.supplier_unbonding_period_sessions);
    }
    r = lcd("/cosmos/base/tendermint/v1beta1/blocks/latest");
    if (r.json && r.json.block) { p.height = r.json.block.header.height; p.chainId = r.json.block.header.chain_id; p.headTime = r.json.block.header.time; }
    // Measured block time over the last 1,000 blocks, so session and unbonding lengths can be shown as time.
    if (p.height && Number(p.height) > 1000) {
      var rb = lcd("/cosmos/base/tendermint/v1beta1/blocks/" + (Number(p.height) - 1000));
      if (rb.json && rb.json.block) { var t1 = Date.parse(p.headTime.substring(0, 23) + "Z"), t0 = Date.parse(rb.json.block.header.time.substring(0, 23) + "Z"); if (t1 > t0) p.blockTime = (t1 - t0) / 1000 / 1000; }
    }
    state.params = p;
    $("pFee").innerHTML = p.addServiceFee !== undefined ? fmtPokt(p.addServiceFee) + " POKT" : "?";
    $("pAppMin").innerHTML = p.appMinStake !== undefined ? fmtPokt(p.appMinStake) + " POKT" : "?";
    $("pSupMin").innerHTML = p.supMinStake !== undefined ? fmtPokt(p.supMinStake) + " POKT" : "?";
    $("supHint").innerHTML = p.supMinStake !== undefined ? "Minimum on " + NET[state.net].label + " right now: " + fmtPokt(p.supMinStake) + " POKT. One stake covers every service the supplier lists." : "Minimum could not be read.";
    $("stkHint").innerHTML = p.appMinStake !== undefined ? "Minimum on " + NET[state.net].label + " right now: " + fmtPokt(p.appMinStake) + " POKT. Stake above it; suggested " + fmtPokt(suggestedAppStake()) + " POKT." : "Minimum could not be read.";
    if (p.appMinStake !== undefined) $("stkAmount").placeholder = String(suggestedAppStake() / POKT);
    renderChain();
    loadCatalog();
    onCuprChange();
  }
  // The folder the app reads service subfolders from: the one set in Settings, else
  // the repository default when it exists, else a pointer to Settings.
  function renderServicesDir() {
    var set = loadSettings().servicesRoot, box = $("dashServicesDir");
    if (set && fso.FolderExists(set)) box.innerHTML = '<span class="mono">' + esc(set) + '</span><div class="hint">' + localServices().length + ' service folder' + (localServices().length === 1 ? "" : "s") + '. <a href="#" onclick="PSM.openServicesFolder();return false;">Open folder</a> or <a href="#" onclick="PSM.tab(\'settings\');return false;">change it in Settings</a>.</div>';
    else if (state.servicesRoot && fso.FolderExists(state.servicesRoot)) box.innerHTML = '<span class="mono">' + esc(state.servicesRoot) + '</span><div class="hint">Not chosen in Settings, so the app is using its built-in default, the repository\'s services folder. <a href="#" onclick="PSM.tab(\'settings\');return false;">Choose a folder in Settings</a> to make it explicit.</div>';
    else box.innerHTML = 'No directory set. <a href="#" onclick="PSM.tab(\'settings\');return false;">Select it in Settings.</a>';
  }
  // Application stakes held by any wallet this app manages, keyed by service id.
  function appStakesByService() {
    var stakes = {}, holders = [];
    if (state.address) holders.push({ name: PARENT, address: state.address });
    for (var wi = 0; wi < state.wallets.length; wi++) holders.push(state.wallets[wi]);
    for (var hi = 0; hi < holders.length; hi++) {
      var rec = appRecordOf(holders[hi].address);
      if (!rec) continue;
      var sids = appServiceIds(rec);
      for (var si = 0; si < sids.length; si++) { (stakes[sids[si]] = stakes[sids[si]] || []).push({ name: holders[hi].name, address: holders[hi].address, stake: Number(rec.stake.amount), unbonding: appUnbonding(rec) }); }
    }
    return stakes;
  }
  // Dashboard Services card: for each owned service, who serves it and how much
  // margin its application stake has above the minimum. This is the check that
  // catches a stake about to be auto-unstaked.
  function renderDashboardServices() {
    var box = $("dashServices");
    if (!state.imported) { box.innerHTML = '<span class="hint">Import the owner wallet to see its services.</span>'; return; }
    var owned = ownedServices();
    if (!owned.length) { box.innerHTML = '<span class="hint">No services owned on ' + esc(NET[state.net].label) + ' yet. <a href="#" onclick="PSM.tab(\'create\');return false;">Create one.</a></span>'; return; }
    var supply = supplyStatusMap(), stakes = appStakesByService(), min = state.params.appMinStake || 0, alerts = [], h;
    h = '<table class="services"><tr><th>Service</th><th>Supply</th><th>Application stake</th><th>Margin above minimum</th><th>Actions</th></tr>';
    for (var i = 0; i < owned.length; i++) {
      var s = owned[i], sp = supply[s.id], st = stakes[s.id] || [], per = costPerRelayUpokt(Number(s.compute_units_per_relay));
      var supplyCell = sp && sp.state === "active" ? '<span class="badge ok">active</span><div class="hint">' + esc(sp.server) + '</div>' : sp && sp.state === "pending" ? '<span class="badge warn">pending</span><div class="hint">from block ' + fmtInt(sp.activation_height) + '</div>' : '<span class="badge muted">no supplier of yours</span>';
      var stakeCell = "", marginCell = "", level = "";
      if (!st.length) { stakeCell = '<span class="badge muted">none</span>'; marginCell = '<span class="hint">Stake an application to call the service.</span>'; }
      for (var k = 0; k < st.length; k++) {
        var e = st[k], margin = e.stake - min, relays = (per && margin > 0) ? Math.floor(margin / per) : 0, cls = e.unbonding ? "bad" : (margin <= 0 ? "bad" : (margin < min * 0.05 ? "warn" : "ok"));
        stakeCell += '<div>' + esc(e.name) + ": " + fmtPokt(e.stake) + " POKT" + (e.unbonding ? ' <span class="badge bad">unbonding</span>' : "") + '</div>';
        marginCell += '<div><span class="badge ' + cls + '">' + (e.unbonding ? "stops at block " + fmtInt(e.unbonding) : margin <= 0 ? "below minimum" : fmtPokt(margin) + " POKT") + '</span>' + (!e.unbonding && margin > 0 && per ? '<div class="hint">about ' + fmtInt(relays) + ' relays before the minimum</div>' : "") + '</div>';
        if (e.unbonding) alerts.push("<b>" + esc(e.name) + "</b> (" + esc(s.id) + ") is unbonding; its stake stops at block " + fmtInt(e.unbonding) + ". Restake it now to cancel that and keep its delegations.");
        else if (margin <= 0) alerts.push("<b>" + esc(e.name) + "</b> (" + esc(s.id) + ") is at or below the minimum stake and will be unstaked at the session end. Restake it with a margin.");
        else if (margin < min * 0.05) alerts.push("<b>" + esc(e.name) + "</b> (" + esc(s.id) + ") has only " + fmtPokt(margin) + " POKT of margin left, about " + fmtInt(relays) + " relays. Top the stake up soon.");
      }
      h += '<tr><td class="svcid">' + esc(s.id) + '<div class="hint">' + esc(s.name || "") + '</div></td><td>' + supplyCell + '</td><td>' + stakeCell + '</td><td>' + marginCell + '</td><td class="actions"><button class="btn small' + (st.length ? "" : " primary") + '" onclick="PSM.svcStake(\'' + esc(s.id) + '\')">' + (st.length ? "Restake" : "Stake application") + '</button></td></tr>';
    }
    h += "</table>";
    box.innerHTML = (alerts.length ? '<div class="dangerbox">' + alerts.join("<br>") + "</div>" : "") + h;
  }
  function renderChain() {
    var p = state.params, ns = nextSessionBoundary();
    $("dHeight").innerHTML = p.height ? fmtInt(p.height) : "?";
    $("dBlockTime").innerHTML = p.blockTime ? p.blockTime.toFixed(1) + " s (measured over 1,000 blocks)" : "?";
    $("dSession").innerHTML = p.blocksPerSession ? p.blocksPerSession + " blocks" + (p.blockTime ? " (~" + fmtDuration(p.blocksPerSession * p.blockTime) + ")" : "") : "?";
    $("dNext").innerHTML = ns ? "height " + fmtInt(ns.height) + ", in " + ns.blocks + " block" + (ns.blocks === 1 ? "" : "s") + (p.blockTime ? " (~" + fmtDuration(ns.blocks * p.blockTime) + ")" : "") : "?";
  }
  function loadCatalog() {
    var r = lcd("/pokt-network/poktroll/service/service?pagination.limit=2000");
    state.catalog = (r.json && r.json.service) ? r.json.service : null;
    state.catalogNet = state.net;
    populateStakeSelect();
    renderServices();
  }

  // Services in the live catalog whose owner is this wallet.
  function ownedServices() {
    var out = [];
    if (!state.catalog || !state.address) return out;
    for (var i = 0; i < state.catalog.length; i++) if (state.catalog[i].owner_address === state.address) out.push(state.catalog[i]);
    return out;
  }

  // Service folders on this machine, with what their service.json says.
  function localServices() {
    var out = [];
    if (!fso.FolderExists(state.servicesRoot)) return out;
    var e = new Enumerator(fso.GetFolder(state.servicesRoot).SubFolders);
    for (; !e.atEnd(); e.moveNext()) {
      var folder = e.item().Name, m = {};
      try { var t = readUtf8(manifestPath(folder)); if (t) m = JSON.parse(t); } catch (ex) { m = {}; }
      out.push({ folder: folder, id: m.service_id || folder, name: m.name || "", cupr: m.compute_units_per_relay || null, hasCard: fso.FileExists(join(state.servicesRoot, folder, m.card || "card.json")), manifest: m });
    }
    return out;
  }

  function populateStakeSelect() {
    var sel = $("stkId"), cur = sel.value, owned = ownedServices();
    sel.innerHTML = "";
    if (!owned.length) { sel.innerHTML = '<option value="">No registered services for this wallet on ' + esc(NET[state.net].label) + '</option>'; return; }
    for (var i = 0; i < owned.length; i++) { var o = document.createElement("option"); o.value = owned[i].id; o.text = owned[i].id + " (" + owned[i].name + ")"; sel.appendChild(o); }
    sel.value = cur; if (!sel.value) sel.selectedIndex = 0;
  }

  // ------------------------------------------------------- my services ----

  function renderServices(refresh) {
    if (refresh) { refreshNetwork(); refreshBalance(); return; } // refreshNetwork -> loadCatalog -> renderServices
    var box = $("svcList");
    if (!state.imported) {
      $("svcListHint").innerHTML = "Import the wallet to see which services it owns on the network. Folders on this machine are listed below.";
    } else {
      $("svcListHint").innerHTML = "Services this wallet owns on " + esc(NET[state.net].label) + ", plus service folders on this machine that are not registered there yet.";
    }
    var owned = ownedServices(), local = localServices(), rows = [], seen = {};
    var stakes = appStakesByService();
    var localById = {}; for (var l = 0; l < local.length; l++) localById[local[l].id] = local[l];
    for (var i = 0; i < owned.length; i++) { var s = owned[i]; seen[s.id] = true; rows.push({ id: s.id, name: s.name, cupr: Number(s.compute_units_per_relay), chain: true, local: localById[s.id] || null, stake: stakes[s.id] }); }
    for (var j = 0; j < local.length; j++) { if (seen[local[j].id]) continue; var onChainElsewhere = null; if (state.catalog) for (var k = 0; k < state.catalog.length; k++) if (state.catalog[k].id === local[j].id) onChainElsewhere = state.catalog[k]; rows.push({ id: local[j].id, name: local[j].name, cupr: local[j].cupr, chain: false, taken: onChainElsewhere, local: local[j], stake: stakes[local[j].id] }); }
    if (!rows.length) {
      box.innerHTML = '<div class="empty"><div class="orbit"></div><p>No services yet on ' + esc(NET[state.net].label) + ' and no service folders on this machine.</p><button class="btn primary" onclick="PSM.tab(\'create\')">Create your first service</button></div>';
      return;
    }
    var supply = supplyStatusMap();
    var h = '<table class="services"><tr><th>Service</th><th>Name</th><th>Price</th><th>Status on ' + esc(NET[state.net].label) + '</th><th>App stake</th><th>Actions</th></tr>';
    for (var r = 0; r < rows.length; r++) {
      var x = rows[r], u = x.cupr ? costPerRelayUpokt(x.cupr) : null, sp = supply[x.id], nm = (x.local && x.local.manifest && x.local.manifest.networks && x.local.manifest.networks[state.net]) || {};
      // Lifecycle: created (folder only) -> registered (on chain) -> pending (a supplier of ours is scheduled) -> active (served now).
      var chainCell;
      if (!x.chain) chainCell = x.taken ? '<span class="badge bad">ID taken by another owner</span>' : '<span class="badge muted">created</span><div class="hint">not registered here</div>';
      else if (sp && sp.state === "active") chainCell = '<span class="badge ok">active</span><div class="hint">served by ' + esc(sp.server) + '</div>' + (nm.deployed_at ? "" : '<div class="hint" style="color:#8a5a00">not deployed from this machine on ' + esc(NET[state.net].label) + '</div>');
      else if (sp && sp.state === "pending") chainCell = '<span class="badge warn">pending</span><div class="hint">' + esc(sp.server) + ' serves it from ' + activationNote(sp.activation_height) + '</div>';
      else chainCell = '<span class="badge info">registered</span><div class="hint">no supplier of yours serves it</div>';
      if (x.local && !x.local.hasCard) chainCell += ' <span class="badge warn">no card</span>';
      var stakeCell = "";
      if (x.stake) { var total = 0, ub = 0; for (var sc = 0; sc < x.stake.length; sc++) { total += x.stake[sc].stake; if (x.stake[sc].unbonding) ub = x.stake[sc].unbonding; } stakeCell = fmtPokt(total) + " POKT" + (ub ? ' <span class="badge warn">unbonding</span><div class="hint">stops at block ' + fmtInt(ub) + '; restake to cancel</div>' : ""); }
      else stakeCell = '<span class="hint">none</span>';
      var actions = "";
      var deployable = x.local && fso.FileExists(join(state.servicesRoot, x.local.folder, "backend", "Dockerfile"));
      if (x.chain) actions += '<button class="btn small" onclick="PSM.svcUpdate(\'' + esc(x.id) + '\')">Update</button><button class="btn small" onclick="PSM.svcStake(\'' + esc(x.id) + '\')">' + (x.stake ? "Restake" : "Stake") + '</button>' + (deployable ? '<button class="btn small" onclick="PSM.svcDeploy(\'' + esc(x.id) + '\')">Deploy</button>' : "") + '<button class="btn small" onclick="PSM.svcSupply(\'' + esc(x.id) + '\')">Supply</button><button class="btn small" onclick="PSM.svcTest(\'' + esc(x.id) + '\')">Test</button>';
      else if (!x.taken) actions += '<button class="btn small primary" onclick="PSM.svcRegister(\'' + esc(x.local.folder) + '\')">Register</button>';
      if (x.local) actions += '<button class="btn small" onclick="PSM.svcEdit(\'' + esc(x.local.folder) + '\')">Edit card</button>';
      h += '<tr><td class="svcid">' + esc(x.id) + '</td><td>' + esc(x.name || "") + '</td><td>' + (x.cupr ? esc(x.cupr) + " CU" + (u !== null ? '<div class="hint">' + u + " uPOKT/relay</div>" : "") : "") + '</td><td>' + chainCell + '</td><td>' + stakeCell + '</td><td class="actions">' + actions + '</td></tr>';
    }
    h += "</table>";
    box.innerHTML = h;
  }

  function folderForId(id) {
    var local = localServices();
    for (var i = 0; i < local.length; i++) if (local[i].id === id) return local[i].folder;
    return "";
  }
  function svcUpdate(id) {
    var folder = folderForId(id);
    if (folder) { $("svcFolder").value = folder; onServiceFolder(); }
    else {
      var s = null; for (var i = 0; i < (state.catalog || []).length; i++) if (state.catalog[i].id === id) s = state.catalog[i];
      $("svcFolder").value = ""; $("svcId").value = id; $("svcName").value = s ? s.name : ""; $("svcCupr").value = s ? s.compute_units_per_relay : 100; $("svcCard").value = "";
      onIdChange(); onCuprChange();
    }
    tab("register");
    foot("Editing '" + id + "'. Change what you need, run preflight, and the registration becomes an update (gas only).");
  }
  function svcRegister(folder) { $("svcFolder").value = folder; onServiceFolder(); tab("register"); }
  function svcStake(id) { populateStakeSelect(); $("stkId").value = id; tab("stake"); onStakeServiceChange(); }
  function svcStakeAs(id, walletName) { populateStakeSelect(); if (id) $("stkId").value = id; tab("stake"); populateStakeFrom(); $("stkFrom").value = walletName; onStakeFromChange(); }
  function svcEdit(folder) { $("crFolder").value = folder; loadCreateFromFolder(); tab("create"); }
  function costPerRelayUpokt(cupr) {
    var p = state.params; if (!p.cuMultiplier || !p.cuGranularity) return null;
    return cupr * p.cuMultiplier / p.cuGranularity;
  }
  function onCuprChange() {
    var c = parseInt($("svcCupr").value, 10);
    if (!(c >= 1 && c <= 1048576)) { $("cuprHint").innerHTML = '<span style="color:#b71c1c">Must be a whole number from 1 to 1,048,576.</span>'; return; }
    var u = costPerRelayUpokt(c);
    $("cuprHint").innerHTML = u === null ? "Sets the price of one relay. Fetch the network to see the cost." :
      "One relay costs " + u + " uPOKT (" + (u / POKT).toFixed(6).replace(/0+$/, "") + " POKT) at today's multiplier on " + NET[state.net].label + ".";
  }
  function onIdChange() {
    var id = trim($("svcId").value);
    var ok = /^[A-Za-z0-9_-]{1,42}$/.test(id);
    $("svcIdHint").innerHTML = !id ? "Permanent once registered. Lowercase, letters, digits, hyphen, underscore. Up to 42 characters." :
      ok ? (id !== id.toLowerCase() ? '<span style="color:#8a5a00">Allowed, but lowercase is the convention.</span>' : "Looks valid. Preflight checks the catalog.") :
      '<span style="color:#b71c1c">Only letters, digits, hyphen, underscore; 1 to 42 characters.</span>';
  }

  // --------------------------------------------------------- services ----

  function loadServiceFolders() {
    var sels = [[$("svcFolder"), "Choose a folder in services/"], [$("crFolder"), "Start from scratch"]];
    var names = [];
    if (fso.FolderExists(state.servicesRoot)) {
      var e = new Enumerator(fso.GetFolder(state.servicesRoot).SubFolders);
      for (; !e.atEnd(); e.moveNext()) names.push(e.item().Name);
    }
    for (var s = 0; s < sels.length; s++) {
      var sel = sels[s][0], cur = sel.value;
      sel.innerHTML = '<option value="">' + sels[s][1] + '</option>';
      for (var i = 0; i < names.length; i++) { var o = document.createElement("option"); o.value = names[i]; o.text = names[i]; sel.appendChild(o); }
      sel.value = cur;
    }
  }
  function manifestPath(folder) { return join(state.servicesRoot, folder, "service.json"); }
  function onServiceFolder() {
    var folder = $("svcFolder").value; if (!folder) return;
    saveSettings({ lastService: folder });
    var m = null; try { var t = readUtf8(manifestPath(folder)); if (t) m = JSON.parse(t); } catch (e) { foot("service.json in " + folder + " is not valid JSON: " + e.message); }
    m = m || {};
    if (m.service_id) $("svcId").value = m.service_id; else if (!$("svcId").value) $("svcId").value = folder;
    if (m.name) $("svcName").value = m.name;
    if (m.compute_units_per_relay) $("svcCupr").value = m.compute_units_per_relay;
    var card = m.card ? join(state.servicesRoot, folder, m.card) : join(state.servicesRoot, folder, "card.json");
    $("svcCard").value = fso.FileExists(card) ? card : (m.card ? card : "");
    if (m.application_stake_pokt) $("stkAmount").value = m.application_stake_pokt;
    if (m.service_id) $("stkId").value = m.service_id;
    onIdChange(); onCuprChange();
    foot("Loaded " + folder + (m.service_id ? "" : " (no service.json yet; save one from the form)"));
  }
  function saveManifest() {
    var folder = $("svcFolder").value;
    if (!folder) { alert("Choose a service folder first. Create one under services/ and press Rescan."); return; }
    var m = {}; try { var t = readUtf8(manifestPath(folder)); if (t) m = JSON.parse(t); } catch (e) { m = {}; }
    m.service_id = trim($("svcId").value);
    m.name = trim($("svcName").value);
    m.compute_units_per_relay = parseInt($("svcCupr").value, 10);
    var card = trim($("svcCard").value);
    var folderPath = join(state.servicesRoot, folder);
    if (card.toLowerCase().indexOf(folderPath.toLowerCase() + SEP) === 0) card = card.substring(folderPath.length + 1);
    m.card = card;
    var stk = parseFloat($("stkAmount").value); if (stk > 0) m.application_stake_pokt = stk;
    m.networks = m.networks || {};
    writeUtf8(manifestPath(folder), JSON.stringify(m, null, 2));
    foot("Saved " + manifestPath(folder));
  }
  function recordManifest(field, value) {
    var folder = $("svcFolder").value; if (!folder) return;
    var m = {}; try { var t = readUtf8(manifestPath(folder)); if (t) m = JSON.parse(t); } catch (e) { m = {}; }
    m.networks = m.networks || {}; m.networks[state.net] = m.networks[state.net] || {};
    m.networks[state.net][field] = value;
    writeUtf8(manifestPath(folder), JSON.stringify(m, null, 2));
  }
  function openServicesFolder() { ensureDir(state.servicesRoot); sh.Run('explorer.exe "' + state.servicesRoot + '"', 1, false); }
  function onCardBrowse(input) {
    var v = input.value || "";
    if (/fakepath/i.test(v) || !fso.FileExists(v)) { foot("The browser control hid the full path. Type or paste the card path instead."); return; }
    $("svcCard").value = v;
  }

  // ------------------------------------------------------------- card ----

  function cardChecks(path, items) {
    if (!path) { items.push({ level: "warn", text: "No service card given.", sub: "Allowed, but gateways and agents cannot discover what the service does. Add one with a later add-service." }); return null; }
    if (!fso.FileExists(path)) { items.push({ level: "fail", text: "Card file not found.", sub: esc(path) }); return null; }
    var size = fso.GetFile(path).Size;
    if (size > 262144) { items.push({ level: "fail", text: "Card is " + fmtInt(size) + " bytes; the chain limit is 262,144." }); return null; }
    var txt = readUtf8(path), card;
    try { card = JSON.parse(txt); } catch (e) { items.push({ level: "fail", text: "Card is not valid JSON.", sub: esc(e.message) }); return null; }
    if (Object.prototype.toString.call(card) !== "[object Object]") { items.push({ level: "fail", text: "Card must be a single JSON object." }); return null; }
    items.push({ level: size > 4096 ? "warn" : "ok", text: "Card parses; " + fmtInt(size) + " bytes." + (size > 4096 ? " Larger than the 4 KiB target." : ""), sub: esc(path) });
    if (card.service_id !== undefined && card.service_id !== trim($("svcId").value)) items.push({ level: "warn", text: "Card's service_id differs from the form.", sub: esc(card.service_id) + " vs " + esc(trim($("svcId").value)) });
    return card;
  }
  function validateCardOnly() {
    var items = []; var path = trim($("svcCard").value);
    cardChecks(path, items);
    $("regResults").className = "panel"; $("regPlan").className = "plan hidden"; $("regLog").className = "log hidden"; status("regStatus", "");
    checks("regChecks", items);
    if (!path || hasFail(items)) return;
    status("regStatus", "Running the Skill's validate_card.py", "busy");
    run("validate-card", { card_path: path, script: join(state.skillScripts, "validate_card.py") }, function (r) {
      if (r.skipped) { items.push({ level: "info", text: "Schema validation skipped.", sub: esc(r.reason) }); }
      else items.push({ level: r.ok ? "ok" : "fail", text: r.ok ? "validate_card.py passed." : "validate_card.py reported problems.", sub: "<pre>" + esc(r.output) + "</pre>" });
      checks("regChecks", items); status("regStatus", "");
    });
  }

  // --------------------------------------------------------- register ----

  function regForm() {
    return { id: trim($("svcId").value), name: trim($("svcName").value), cupr: parseInt($("svcCupr").value, 10), card: trim($("svcCard").value) };
  }

  function preflightRegister(rechecked) {
    if (state.busy) return;
    var f = regForm(), items = [];
    $("regResults").className = "panel"; $("regPlan").className = "plan hidden"; $("regLog").className = "log hidden"; status("regStatus", "");
    state.regPlanOk = false; $("btnRegister").disabled = true;

    if (!dockerReady() && !rechecked) {
      // The cached Docker state may be stale (Docker started after the app did). Check now.
      status("regStatus", "Checking Docker Desktop and the pocketd image", "busy");
      dockerCycle(false, function () { preflightRegister(true); });
      return;
    }
    if (!state.imported) items.push({ level: "fail", text: "No wallet imported." });
    if (!dockerReady()) items.push({ level: "fail", text: state.docker && state.docker.ok ? "The pocketd image is not downloaded. Use the Download pocketd button in the top bar." : "Docker Desktop is not running. Start it (button in the top bar) and run preflight again.", sub: esc((state.docker && state.docker.detail) || "") });
    if (!/^[A-Za-z0-9_-]{1,42}$/.test(f.id)) items.push({ level: "fail", text: "Service ID is invalid." });
    if (!/^[A-Za-z0-9 _-]{1,169}$/.test(f.name)) items.push({ level: "fail", text: "Display name is invalid or empty." });
    if (!(f.cupr >= 1 && f.cupr <= 1048576)) items.push({ level: "fail", text: "Compute units per relay must be 1 to 1,048,576." });
    if (hasFail(items)) { checks("regChecks", items); return; }

    refreshNetwork(); refreshBalance();
    var p = state.params;
    if (p.addServiceFee === undefined) items.push({ level: "fail", text: "Could not read the registration fee from the network." });

    // Catalog: does the ID exist? Is it ours?
    var existing = lcd("/pokt-network/poktroll/service/service/" + encodeURIComponent(f.id));
    var update = false;
    if (existing.status === 200 && existing.json && existing.json.service) {
      var s = existing.json.service;
      if (s.owner_address === state.address) {
        update = true;
        items.push({ level: "warn", text: "Service '" + esc(f.id) + "' already exists and this wallet owns it. This will be an UPDATE.", sub: "Name '" + esc(s.name) + "', " + esc(s.compute_units_per_relay) + " CU/relay today. Only fields you pass change; omitting the card keeps the current card. The registration fee is charged on creation only, so this costs gas alone." });
      } else {
        items.push({ level: "fail", text: "Service ID '" + esc(f.id) + "' is already taken by another owner. IDs are permanent; choose a different one.", sub: "Owner " + esc(s.owner_address) });
      }
    } else if (existing.status === 404) {
      items.push({ level: "ok", text: "Service ID '" + esc(f.id) + "' is free on " + NET[state.net].label + "." });
    } else {
      items.push({ level: "fail", text: "Could not check the catalog (HTTP " + existing.status + ")." });
    }
    // Name and near-ID collisions
    if (state.catalog) {
      var lowerId = f.id.toLowerCase().replace(/[-_]/g, ""), lowerName = f.name.toLowerCase();
      for (var i = 0; i < state.catalog.length; i++) {
        var c = state.catalog[i];
        if (c.id === f.id) continue;
        if (c.id.toLowerCase().replace(/[-_]/g, "") === lowerId) items.push({ level: "warn", text: "Existing service '" + esc(c.id) + "' differs only in case or separators.", sub: "Consider supplying that service instead of registering a near duplicate." });
        if ((c.name || "").toLowerCase() === lowerName && lowerName) items.push({ level: "warn", text: "Another service already uses the name '" + esc(c.name) + "' (ID " + esc(c.id) + ")." });
      }
    }
    var card = cardChecks(f.card, items);
    if (!update && card === null && !f.card) { /* warned already */ }

    // Money
    var fee = update ? 0 : (p.addServiceFee || 0); // x/service charges add_service_fee on creation only
    var margin = 1 * POKT; // gas allowance shown to the user; actual gas is simulated by pocketd
    if (state.balance === null || state.balance === undefined) items.push({ level: "fail", text: "Could not read the wallet balance." });
    else if (state.balance < fee + margin) items.push({ level: "fail", text: "Balance " + fmtPokt(state.balance) + " POKT is below the fee " + fmtPokt(fee) + " POKT plus about 1 POKT for gas." });
    else items.push({ level: "ok", text: "Balance " + fmtPokt(state.balance) + " POKT covers " + (update ? "the update (gas only)" : "the registration fee of " + fmtPokt(fee) + " POKT plus gas") + ".", sub: "Fee read live from the " + NET[state.net].label + " service module." });
    var u = costPerRelayUpokt(f.cupr);
    if (u !== null) items.push({ level: "info", text: "Price: " + f.cupr + " CU/relay = " + u + " uPOKT per relay at today's multiplier." });

    if (hasFail(items)) { checks("regChecks", items); status("regStatus", "Fix the red items and run preflight again.", "err"); return; }

    // Optional schema validation through the Skill script, then the dry-run plan.
    checks("regChecks", items); status("regStatus", "Validating the card and building the plan", "busy");
    var finish = function () {
      run("tx-add-service", { network: state.net, service_id: f.id, name: f.name, compute_units_per_relay: f.cupr, card_path: f.card, dry: true }, function (r) {
        if (!r.ok) { items.push({ level: "fail", text: "The signer refused the plan.", sub: esc(r.error) + " " + esc(r.detail) }); checks("regChecks", items); status("regStatus", "Fix the red items and run preflight again.", "err"); return; }
        $("regPlan").className = "plan"; $("regPlanCmd").innerHTML = esc(r.command);
        checks("regChecks", items);
        state.regPlanOk = true; state.regUpdate = update; state.regForm = f;
        $("btnRegister").disabled = false;
        status("regStatus", "Preflight passed. Review the plan, then press " + $("btnRegister").innerHTML + ".", "ok");
      });
    };
    if (f.card) {
      run("validate-card", { card_path: f.card, script: join(state.skillScripts, "validate_card.py") }, function (r) {
        if (r.skipped) items.push({ level: "info", text: "Schema validation skipped.", sub: esc(r.reason) });
        else if (r.ok) items.push({ level: "ok", text: "validate_card.py passed.", sub: "<pre>" + esc(r.output) + "</pre>" });
        else { items.push({ level: "fail", text: "validate_card.py reported problems.", sub: "<pre>" + esc(r.output) + "</pre>" }); checks("regChecks", items); status("regStatus", "Fix the card and run preflight again.", "err"); return; }
        finish();
      });
    } else finish();
  }

  function executeRegister() {
    if (!state.regPlanOk || state.busy) return;
    var f = state.regForm;
    if (JSON.stringify(f) !== JSON.stringify(regForm())) { status("regStatus", "The form changed since preflight. Run preflight again.", "err"); $("btnRegister").disabled = true; state.regPlanOk = false; return; }
    var go = function () {
      state.busy = true; $("btnRegister").disabled = true;
      $("regLog").className = "log"; $("regLog").innerHTML = "";
      logTo("regLog", "Signing and broadcasting add-service for '" + esc(f.id) + "' on " + NET[state.net].label);
      status("regStatus", "Waiting for pocketd (simulating gas, signing, broadcasting)", "busy");
      run("tx-add-service", { network: state.net, service_id: f.id, name: f.name, compute_units_per_relay: f.cupr, card_path: f.card }, function (r) {
        if (!r.ok) { state.busy = false; logTo("regLog", esc(r.error) + " " + esc(r.detail || r.raw_log), "err"); status("regStatus", "Registration failed. Nothing was charged unless a tx hash is shown above.", "err"); return; }
        logTo("regLog", "Accepted into the mempool. Tx " + txLink(r.txhash) + (r.gas ? " (gas estimate " + fmtInt(r.gas) + ")" : ""));
        status("regStatus", "Waiting for the transaction to be included in a block", "busy");
        pollTx(r.txhash, function (t) {
          if (!t.ok) { state.busy = false; logTo("regLog", esc(t.error), "err"); status("regStatus", "The transaction did not succeed.", "err"); return; }
          logTo("regLog", "Included in block " + fmtInt(t.height) + ".", "ok");
          var v = lcd("/pokt-network/poktroll/service/service/" + encodeURIComponent(f.id));
          if (v.status === 200 && v.json && v.json.service && v.json.service.owner_address === state.address) {
            var s = v.json.service;
            logTo("regLog", "Verified on chain: '" + esc(s.name) + "', " + esc(s.compute_units_per_relay) + " CU/relay, owner " + esc(s.owner_address) + ".", "ok");
            status("regStatus", "Service '" + esc(f.id) + "' is registered on " + NET[state.net].label + ".", "ok");
            recordManifest(state.regUpdate ? "last_update_tx" : "register_tx", r.txhash);
            $("stkId").value = f.id;
          } else {
            logTo("regLog", "The transaction succeeded but the service could not be read back yet. Refresh the network in a moment.", "err");
            status("regStatus", "Registered, verification pending.", "ok");
          }
          state.busy = false; state.regPlanOk = false; refreshBalance(); loadCatalog(); loadHistory();
        });
      });
    };
    if (state.net === "main") {
      modal("Confirm MainNet registration",
        '<div class="dangerbox">This spends real POKT: ' + (state.regUpdate ? 'gas for the update (the registration fee is charged on creation only)' : 'the registration fee of <b>' + fmtPokt(state.params.addServiceFee) + ' POKT</b> plus gas') + '. The service ID <b>' + esc(f.id) + '</b> is permanent.</div>' +
        '<p>Type the service ID to confirm.</p><input type="text" id="mainConfirm" autocomplete="off">',
        [{ label: "Cancel", onClick: closeModal }, { label: "Register on MainNet", cls: "danger solid", onClick: function () { if (trim($("mainConfirm").value) !== f.id) return; closeModal(); go(); } }]);
    } else if (confirm("Register '" + f.id + "' on Beta TestNet now?")) go();
  }

  // ------------------------------------------------------------ stake ----
  // The stake is signed by the wallet chosen in "Stake as": the app wallet made
  // for the service (preferred, since an account stakes for exactly one service)
  // or the owner wallet.

  function populateStakeFrom() {
    var sel = $("stkFrom"), cur = sel.value;
    sel.innerHTML = "";
    var o = document.createElement("option"); o.value = PARENT; o.text = "Owner wallet (" + PARENT + ")"; sel.appendChild(o);
    for (var i = 0; i < state.wallets.length; i++) {
      var w = state.wallets[i], op = document.createElement("option");
      op.value = w.name; op.text = w.name + (w.service_id ? " (for " + w.service_id + ")" : " (unassigned)"); sel.appendChild(op);
    }
    sel.value = cur; if (!sel.value) sel.value = PARENT;
  }
  function stakeWallet() { return walletByName(trim($("stkFrom").value)) || walletByName(PARENT); }
  // Relays settle against the stake, and the protocol unstakes an application that
  // drops below the minimum, so the default is the live minimum plus a 10% margin.
  function suggestedAppStake() { var min = state.params.appMinStake || 0; return Math.ceil((min * 1.1) / POKT) * POKT; }
  function appUnbonding(a) { var e = a && Number(a.unstake_session_end_height || 0); return e > 0 ? e : 0; }
  function onStakeServiceChange() {
    var id = $("stkId").value, w = walletForService(id);
    if (w) $("stkFrom").value = w.name;
    if (!trim($("stkAmount").value) && state.params.appMinStake) $("stkAmount").value = String(suggestedAppStake() / POKT);
    onStakeFromChange();
  }
  function onStakeFromChange() {
    var w = stakeWallet(), id = $("stkId").value;
    if (!w) { $("stkFromHint").innerHTML = "Import the owner wallet first."; $("stkFromBal").innerHTML = "?"; return; }
    if (w.parent) $("stkFromHint").innerHTML = 'The owner wallet can hold only one application stake. <a href="#" onclick="PSM.newWalletDialog();return false;">Create an app wallet</a> for ' + (id ? esc(id) : "the service") + " instead.";
    else if (w.service_id && id && w.service_id !== id) $("stkFromHint").innerHTML = '<span style="color:#8a5a00">' + esc(w.name) + " was made for " + esc(w.service_id) + "; staking it here re-points it to " + esc(id) + ".</span>";
    else $("stkFromHint").innerHTML = "Signs and holds the stake. Address " + shortAddr(w.address) + ".";
    // An application that fell below the minimum (or was unstaked) is unbonding; staking again cancels that.
    var rec = w.address ? appRecordOf(w.address) : null, ub = appUnbonding(rec), box = $("stkAppBox");
    if (ub) {
      var ns = { blocks: ub - Number(state.params.height || 0) };
      box.className = "warnbox";
      box.innerHTML = "<b>" + esc(w.name) + " is unbonding.</b> Its application stake of " + fmtPokt(rec.stake.amount) + " POKT" + (Number(rec.stake.amount) < (state.params.appMinStake || 0) ? " fell below the minimum of " + fmtPokt(state.params.appMinStake) + " POKT as relays settled, so the protocol unstaked it" : " is being returned") + "; the session it stops at ends at block " + fmtInt(ub) + (ns.blocks > 0 && state.params.blockTime ? " (~" + fmtDuration(ns.blocks * state.params.blockTime) + ")" : "") + ". <b>Staking again cancels the unbonding</b> and keeps its delegations: enter an amount with a margin above the minimum, fund the wallet if needed, run preflight, and stake.";
      if (!(parseFloat($("stkAmount").value) > Number(rec.stake.amount) / POKT)) $("stkAmount").value = String(Math.max(suggestedAppStake(), Number(rec.stake.amount) + (state.params.appMinStake || 0) * 0.1) / POKT);
    } else box.className = "warnbox hidden";
    refreshStakeFromBalance();
  }
  function refreshStakeFromBalance() {
    var w = stakeWallet(); if (!w || !w.address) { $("stkFromBal").innerHTML = "?"; return null; }
    var bal = balanceOf(w.address); state.stkFromBalance = bal;
    $("stkFromBal").innerHTML = bal === null ? "?" : fmtPokt(bal) + ' <small>POKT</small>';
    var pokt = parseFloat($("stkAmount").value), stake = pokt > 0 ? Math.round(pokt * POKT) : suggestedAppStake();
    var app = appRecordOf(w.address), current = app ? Number(app.stake.amount) : 0;
    var need = Math.max(0, stake - current) + 1 * POKT;
    if (bal === null) $("stkFromBalHint").innerHTML = "Could not read the balance.";
    else if (w.parent) $("stkFromBalHint").innerHTML = "The owner wallet pays from its own balance.";
    else if (bal >= need) $("stkFromBalHint").innerHTML = "Enough for " + fmtPokt(Math.max(0, stake - current)) + " POKT of stake plus gas.";
    else { $("stkFromBalHint").innerHTML = "Needs about " + fmtPokt(need - bal) + " POKT more to cover the stake plus gas."; if (!trim($("stkFundAmount").value)) $("stkFundAmount").value = Math.ceil((need - bal) / POKT); }
    return bal;
  }
  function fundStakeWallet() {
    var w = stakeWallet();
    if (!w || w.parent) { status("stkFundStatus", "Pick an application wallet under 'Stake as'; the owner wallet does not fund itself.", "err"); return; }
    var pokt = parseFloat($("stkFundAmount").value);
    fundWallet(w.name, Math.round(pokt * POKT), "stkFundStatus", function (ok) { if (ok) { $("stkFundAmount").value = ""; refreshStakeFromBalance(); } });
  }

  function preflightStake(rechecked) {
    if (state.busy) return;
    var id = trim($("stkId").value), pokt = parseFloat($("stkAmount").value), items = [];
    $("stkResults").className = "panel"; $("stkPlan").className = "plan hidden"; $("stkLog").className = "log hidden"; status("stkStatus", "");
    state.stkPlanOk = false; $("btnStake").disabled = true;
    if (!dockerReady() && !rechecked) {
      status("stkStatus", "Checking Docker Desktop and the pocketd image", "busy");
      dockerCycle(false, function () { preflightStake(true); });
      return;
    }
    var w = stakeWallet();
    if (!state.imported) items.push({ level: "fail", text: "No wallet imported." });
    if (!w) items.push({ level: "fail", text: "Choose the wallet to stake as." });
    if (!dockerReady()) items.push({ level: "fail", text: state.docker && state.docker.ok ? "The pocketd image is not downloaded. Use the Download pocketd button in the top bar." : "Docker Desktop is not running. Start it (button in the top bar) and run preflight again.", sub: esc((state.docker && state.docker.detail) || "") });
    if (!/^[A-Za-z0-9_-]{1,42}$/.test(id)) items.push({ level: "fail", text: "Service ID is invalid." });
    if (!(pokt > 0)) items.push({ level: "fail", text: "Enter a stake amount in POKT." });
    if (hasFail(items)) { checks("stkChecks", items); return; }
    refreshNetwork(); refreshBalance();
    var p = state.params, upokt = Math.round(pokt * POKT);
    if (w.parent) items.push({ level: "warn", text: "Staking the owner wallet itself. It can hold only one application stake, so a dedicated app wallet is the better choice.", sub: "Create one on the Wallets tab and pick it under 'Stake as'." });
    else items.push({ level: "ok", text: "Staking as app wallet '" + esc(w.name) + "' (" + esc(w.address) + ")." + (w.service_id && w.service_id !== id ? " It was made for '" + esc(w.service_id) + "'; this re-points it." : "") });
    if (p.appMinStake === undefined) items.push({ level: "fail", text: "Could not read the application minimum stake." });
    else if (upokt < p.appMinStake) items.push({ level: "fail", text: "Stake " + fmtPokt(upokt) + " POKT is below the minimum " + fmtPokt(p.appMinStake) + " POKT." });
    else if (upokt < p.appMinStake * 1.01) items.push({ level: "fail", text: "Stake " + fmtPokt(upokt) + " POKT has no margin above the minimum of " + fmtPokt(p.appMinStake) + " POKT.", sub: "Every settled relay is paid from the stake, and the protocol unstakes an application the moment it falls below the minimum. Stake at least " + fmtPokt(suggestedAppStake()) + " POKT." });
    else items.push({ level: "ok", text: "Stake " + fmtPokt(upokt) + " POKT is " + fmtPokt(upokt - p.appMinStake) + " POKT above the live minimum of " + fmtPokt(p.appMinStake) + " POKT; that margin is what relays draw down." });

    var svc = lcd("/pokt-network/poktroll/service/service/" + encodeURIComponent(id));
    if (svc.status === 200 && svc.json && svc.json.service) items.push({ level: "ok", text: "Service '" + esc(id) + "' exists on " + NET[state.net].label + " ('" + esc(svc.json.service.name) + "')." });
    else if (svc.status === 404) items.push({ level: "fail", text: "Service '" + esc(id) + "' is not registered on " + NET[state.net].label + ". Register it first." });
    else items.push({ level: "fail", text: "Could not check the service (HTTP " + svc.status + ")." });

    var app = lcd("/pokt-network/poktroll/application/application/" + w.address);
    var current = 0;
    if (app.status === 200 && app.json && app.json.application) {
      var a = app.json.application; current = Number(a.stake.amount);
      var ids = appServiceIds(a);
      if (ids.length && ids[0] !== id) items.push({ level: "warn", text: "This wallet is already staked as an application for '" + esc(ids.join(", ")) + "' with " + fmtPokt(current) + " POKT.", sub: "Staking again re-points it to '" + esc(id) + "'. An application stakes for exactly one service; the amount must not be lower than the current stake." });
      else items.push({ level: "info", text: "This wallet already has an application stake of " + fmtPokt(current) + " POKT for '" + esc(id) + "'. Staking again raises it to the new amount.", sub: "The new amount must be at least the current stake." });
      if (upokt < current) items.push({ level: "fail", text: "New stake must be at least the current " + fmtPokt(current) + " POKT (stakes cannot be lowered this way)." });
      if (appUnbonding(a)) items.push({ level: "warn", text: "This application is unbonding (its stake stops at the session ending at block " + fmtInt(appUnbonding(a)) + "). Staking now cancels that and keeps its gateway delegations." });
    } else if (app.status === 404) items.push({ level: "ok", text: "This wallet has no application stake yet on " + NET[state.net].label + "." });
    else items.push({ level: "fail", text: "Could not read the application record (HTTP " + app.status + ")." });

    var bal = refreshStakeFromBalance();
    var delta = Math.max(0, upokt - current), need = delta + 1 * POKT;
    if (bal === null || bal === undefined) items.push({ level: "fail", text: "Could not read the staking wallet's balance." });
    else if (bal < need) items.push({ level: "fail", text: "Balance " + fmtPokt(bal) + " POKT cannot cover " + fmtPokt(delta) + " POKT of new stake plus about 1 POKT gas." + (w.parent ? "" : " Fund it from the owner wallet using the box above.") });
    else items.push({ level: "ok", text: "Balance " + fmtPokt(bal) + " POKT covers " + fmtPokt(delta) + " POKT of additional stake plus gas." });

    if (hasFail(items)) { checks("stkChecks", items); status("stkStatus", "Fix the red items and run preflight again.", "err"); return; }
    checks("stkChecks", items); status("stkStatus", "Building the plan", "busy");
    run("tx-stake-app", { network: state.net, service_id: id, stake_upokt: upokt, from: w.name, dry: true }, function (r) {
      if (!r.ok) { items.push({ level: "fail", text: "The signer refused the plan.", sub: esc(r.error) + " " + esc(r.detail) }); checks("stkChecks", items); status("stkStatus", "", "err"); return; }
      $("stkPlan").className = "plan"; $("stkPlanCmd").innerHTML = esc(r.command) + "\n\n# app_stake.yaml\n" + esc(r.config);
      state.stkPlanOk = true; state.stkForm = { id: id, upokt: upokt, from: w.name, address: w.address };
      $("btnStake").disabled = false;
      status("stkStatus", "Preflight passed. Review the plan, then press " + $("btnStake").innerHTML + ".", "ok");
    });
  }

  // ------------------------------------------------------- delegation ----
  // An application delegates to gateways so they can sign relays for it. The
  // gateway list is read live from the network each time the panel renders.

  function loadGateways() {
    var r = lcd("/pokt-network/poktroll/gateway/gateway?pagination.limit=1000");
    return (r.json && r.json.gateways) ? r.json.gateways : [];
  }
  function delegationHolders() {
    var out = [], holders = [];
    if (state.address) holders.push({ name: PARENT, address: state.address, parent: true });
    for (var i = 0; i < state.wallets.length; i++) holders.push(state.wallets[i]);
    for (var h = 0; h < holders.length; h++) { if (!holders[h].address) continue; var a = appRecordOf(holders[h].address); if (a) out.push({ wallet: holders[h], app: a }); }
    return out;
  }
  function renderDelegation() {
    var sel = $("dlgFrom"), cur = sel.value, hs = delegationHolders();
    sel.innerHTML = "";
    if (!hs.length) { sel.innerHTML = '<option value="">No staked application on this network</option>'; $("dlgList").innerHTML = "Stake an application above first."; $("btnDelegate").disabled = true; }
    else {
      for (var i = 0; i < hs.length; i++) { var o = document.createElement("option"); o.value = hs[i].wallet.name; o.text = hs[i].wallet.name + " (staked for " + appServiceIds(hs[i].app).join(", ") + ")"; sel.appendChild(o); }
      sel.value = cur; if (!sel.value) sel.selectedIndex = 0;
      $("btnDelegate").disabled = false;
    }
    var gsel = $("dlgGateway"), gcur = gsel.value, gws = loadGateways();
    gsel.innerHTML = "";
    if (!gws.length) gsel.innerHTML = '<option value="">No gateways registered on ' + esc(NET[state.net].label) + '</option>';
    for (var g = 0; g < gws.length; g++) { var go = document.createElement("option"); go.value = gws[g].address; go.text = gws[g].address + "  (" + fmtPokt(gws[g].stake.amount) + " POKT staked)"; gsel.appendChild(go); }
    gsel.value = gcur; if (!gsel.value && gws.length) gsel.selectedIndex = 0;
    $("dlgGatewayHint").innerHTML = gws.length + " gateway" + (gws.length === 1 ? "" : "s") + " registered on " + esc(NET[state.net].label) + ", read just now. Pick the one that will route requests to your service.";
    onDelegateFromChange();
  }
  function delegationHolder() { var hs = delegationHolders(), n = $("dlgFrom").value; for (var i = 0; i < hs.length; i++) if (hs[i].wallet.name === n) return hs[i]; return null; }
  function onDelegateFromChange() {
    var h = delegationHolder(), box = $("dlgList");
    if (!h) { box.innerHTML = "Choose an application."; return; }
    var a = h.app, list = a.delegatee_gateway_addresses || [], max = state.params.appMaxDelegated || 0, pend = a.pending_undelegations || {}, hh = "";
    $("dlgFromHint").innerHTML = '<div class="addr" style="cursor:pointer;margin:4px 0" title="Click to copy" onclick="PSM.copy(\'' + esc(h.wallet.address) + '\')">' + esc(h.wallet.address) + '</div>Application address, click to copy; a gateway operator asks for it. ' + list.length + " of " + (max || "?") + " allowed delegations used." + (appUnbonding(h.app) ? ' <span style="color:#8a5a00">This application is unbonding; restake it above (Application stake) to keep the delegation.</span>' : "");
    if (!list.length) hh = '<div class="hint">' + esc(h.wallet.name) + " is not delegated to any gateway. Only self-signing clients such as pocket-ap can use it until it is.</div>";
    else {
      hh = '<table class="services"><tr><th>Gateway</th><th>Actions</th></tr>';
      for (var i = 0; i < list.length; i++) hh += '<tr><td class="mono">' + esc(list[i]) + '</td><td class="actions"><button class="btn small danger" onclick="PSM.undelegateGateway(\'' + esc(list[i]) + '\')">Undelegate</button></td></tr>';
      hh += "</table>";
    }
    var pk = []; for (var k in pend) if (pend.hasOwnProperty(k)) pk.push(k);
    if (pk.length) { hh += '<div class="hint" style="margin-top:6px">Pending undelegations, effective when the session ending at ' + pk.map(function (k) { return "block " + fmtInt(k); }).join(", ") + " closes.</div>"; }
    box.innerHTML = hh;
  }
  function delegateGateway() { delegationTx("delegate"); }
  function undelegateGateway(gw) { delegationTx("undelegate", gw); }
  function delegationTx(kind, gwArg) {
    if (state.busy) return;
    var h = delegationHolder(), gw = gwArg || $("dlgGateway").value;
    if (!h) { status("dlgStatus", "Choose a staked application.", "err"); return; }
    if (!/^pokt1[0-9a-z]{38}$/.test(gw)) { status("dlgStatus", "Choose a gateway.", "err"); return; }
    if (!state.imported || !dockerReady()) { status("dlgStatus", "Owner wallet and Docker must be ready.", "err"); return; }
    var list = h.app.delegatee_gateway_addresses || [], max = state.params.appMaxDelegated || 0;
    if (kind === "delegate" && list.indexOf(gw) >= 0) { status("dlgStatus", esc(h.wallet.name) + " is already delegated to that gateway.", "err"); return; }
    if (kind === "delegate" && max && list.length >= max) { status("dlgStatus", "This application already uses all " + max + " allowed delegations. Undelegate one first.", "err"); return; }
    var verb = kind === "delegate" ? "Delegate" : "Undelegate", prep = kind === "delegate" ? " to " : " from ";
    var go = function () {
      state.busy = true; status("dlgStatus", "Waiting for pocketd (simulating gas, signing, broadcasting)", "busy");
      run(kind === "delegate" ? "tx-delegate-gateway" : "tx-undelegate-gateway", { network: state.net, from: h.wallet.name, gateway_address: gw }, function (r) {
        if (!r.ok) { state.busy = false; status("dlgStatus", esc(r.error) + " " + esc(r.detail || ""), "err"); return; }
        status("dlgStatus", "Broadcast, waiting for the block (" + esc(r.txhash.substring(0, 10)) + ")", "busy");
        pollTx(r.txhash, function (t) {
          state.busy = false;
          if (!t.ok) { status("dlgStatus", esc(t.error), "err"); return; }
          loadHistory(); onDelegateFromChange();
          status("dlgStatus", verb + "d " + esc(h.wallet.name) + prep + shortAddr(gw) + " in block " + fmtInt(t.height) + "." + (kind === "undelegate" ? " It takes effect when the current session ends." : ""), "ok");
        });
      });
    };
    var body = "<p>" + verb + " <b>" + esc(h.wallet.name) + "</b> (" + esc(h.wallet.address) + ")" + prep + "gateway <b>" + esc(gw) + "</b> on " + esc(NET[state.net].label) + ". " + (kind === "delegate" ? "The gateway can then sign relays for this application; its stake pays for them." : "The gateway stops signing for this application when the current session ends.") + " Costs gas only.</p>";
    if (state.net === "main") modal("Confirm MainNet " + verb.toLowerCase(), body, [{ label: "Cancel", onClick: closeModal }, { label: verb + " on MainNet", cls: "primary", onClick: function () { closeModal(); go(); } }]);
    else if (confirm(verb + " " + h.wallet.name + prep + gw + " on Beta TestNet?")) go();
  }

  function executeStake() {
    if (!state.stkPlanOk || state.busy) return;
    var f = state.stkForm;
    if (f.id !== trim($("stkId").value) || f.from !== trim($("stkFrom").value) || f.upokt !== Math.round(parseFloat($("stkAmount").value) * POKT)) { status("stkStatus", "The form changed since preflight. Run preflight again.", "err"); $("btnStake").disabled = true; state.stkPlanOk = false; return; }
    var go = function () {
      state.busy = true; $("btnStake").disabled = true;
      $("stkLog").className = "log"; $("stkLog").innerHTML = "";
      logTo("stkLog", "Signing and broadcasting stake-application for '" + esc(f.id) + "' as '" + esc(f.from) + "' with " + fmtPokt(f.upokt) + " POKT on " + NET[state.net].label);
      status("stkStatus", "Waiting for pocketd (simulating gas, signing, broadcasting)", "busy");
      run("tx-stake-app", { network: state.net, service_id: f.id, stake_upokt: f.upokt, from: f.from }, function (r) {
        if (!r.ok) { state.busy = false; logTo("stkLog", esc(r.error) + " " + esc(r.detail || r.raw_log), "err"); status("stkStatus", "Staking failed.", "err"); return; }
        logTo("stkLog", "Accepted into the mempool. Tx " + txLink(r.txhash) + (r.gas ? " (gas estimate " + fmtInt(r.gas) + ")" : ""));
        status("stkStatus", "Waiting for the transaction to be included in a block", "busy");
        pollTx(r.txhash, function (t) {
          if (!t.ok) { state.busy = false; logTo("stkLog", esc(t.error), "err"); status("stkStatus", "The transaction did not succeed.", "err"); return; }
          logTo("stkLog", "Included in block " + fmtInt(t.height) + ".", "ok");
          var a = appRecordOf(f.address), okv = false;
          if (a) {
            var ids = appServiceIds(a);
            okv = ids.indexOf(f.id) >= 0 && Number(a.stake.amount) >= f.upokt;
            logTo("stkLog", "On chain: '" + esc(f.from) + "' staked " + fmtPokt(a.stake.amount) + " POKT for '" + esc(ids.join(", ")) + "'.", okv ? "ok" : "err");
          }
          status("stkStatus", okv ? "'" + esc(f.from) + "' is staked as an application for '" + esc(f.id) + "' on " + NET[state.net].label + "." : "Transaction succeeded but verification did not match; check the Activity tab.", okv ? "ok" : "err");
          if (okv) { recordManifest("app_stake_tx", r.txhash); recordManifest("app_wallet", f.from); recordManifest("app_address", f.address); }
          state.busy = false; state.stkPlanOk = false; refreshBalance(); loadHistory();
          loadWallets(false, function () { onStakeFromChange(); renderServices(); });
        });
      });
    };
    if (state.net === "main") {
      modal("Confirm MainNet stake",
        '<div class="dangerbox">This locks <b>' + fmtPokt(f.upokt) + ' POKT</b> of real funds from <b>' + esc(f.from) + '</b> as an application stake for <b>' + esc(f.id) + '</b>. Unstaking takes an unbonding period.</div>' +
        '<p>Type the service ID to confirm.</p><input type="text" id="mainConfirm" autocomplete="off">',
        [{ label: "Cancel", onClick: closeModal }, { label: "Stake on MainNet", cls: "danger solid", onClick: function () { if (trim($("mainConfirm").value) !== f.id) return; closeModal(); go(); } }]);
    } else if (confirm("Stake " + fmtPokt(f.upokt) + " POKT from '" + f.from + "' for '" + f.id + "' on Beta TestNet now?")) go();
  }

  // ----------------------------------------------------------- supply ----
  // A supplier is the operator key on one configured server, staked for one or
  // more services behind that server's RelayMiner URL. The Suppliers screen lists
  // one row per server; "Manage" opens the editor for that supplier, where the
  // service list is a table of tick boxes (the stake replaces the whole list).

  function supplyServer() { return serverByName($("supServer").value); }
  function onSupplyServerChange(quiet) {
    var s = supplyServer();
    if (!s) return;
    if (!quiet) saveSettings({ supplierServer: s.name });
    var st = stackOf(s, state.net) || {};
    $("supServerHint").innerHTML = "Signs on " + esc(s.user + "@" + s.host) + " with the " + esc(NET[state.net].label) + " operator keyring in " + (st.dir ? '<span class="mono">' + esc(st.dir) + "</span>" : '<span style="color:#b71c1c">a stack that is not provisioned (Settings)</span>') + ".";
    if (st.operator) $("supOperator").value = st.operator;
    if (st.url) $("supUrl").value = st.url;
    refreshOperatorBalance();
  }
  function populateSupplyServers() {
    var sel = $("supServer"), sv = servers(), cur = sel.value || loadSettings().supplierServer || "";
    sel.innerHTML = "";
    if (!sv.length) { sel.innerHTML = '<option value="">No servers configured</option>'; return; }
    for (var i = 0; i < sv.length; i++) { if (stackState(stackOf(sv[i], state.net)) !== "ready") continue; var o = document.createElement("option"); o.value = sv[i].name; o.text = sv[i].name; sel.appendChild(o); }
    sel.value = cur; if (!sel.value) sel.selectedIndex = 0;
  }

  // For every service: is one of our suppliers on this network serving it (active),
  // scheduled to at the next session (pending, with the block it starts at), or not.
  function supplyStatusMap() {
    var map = {}, sv = servers(), h = Number(state.params.height || 0);
    for (var i = 0; i < sv.length; i++) {
      var st = stackOf(sv[i], state.net); if (stackState(st) !== "ready") continue;
      var rec = supplierRecord(st.operator).rec; if (!rec) continue;
      for (var a = 0; a < (rec.services || []).length; a++) map[rec.services[a].service_id] = { state: "active", server: sv[i].name };
      for (var c = 0; c < (rec.service_config_history || []).length; c++) {
        var e = rec.service_config_history[c], sid = e.service && e.service.service_id, act = Number(e.activation_height || 0);
        if (!sid || String(e.deactivation_height || "0") !== "0" || act <= h || (map[sid] && map[sid].state === "active")) continue;
        map[sid] = { state: "pending", server: sv[i].name, activation_height: act };
      }
    }
    return map;
  }
  function activationNote(act) {
    var h = Number(state.params.height || 0), blocks = act - h, bt = state.params.blockTime || 0;
    return "block " + fmtInt(act) + (blocks > 0 ? ", " + blocks + " block" + (blocks === 1 ? "" : "s") + (bt ? " (~" + fmtDuration(blocks * bt) + ")" : "") + " from now at block " + fmtInt(h) : "");
  }
  function supplierRecord(op) {
    if (!/^pokt1[0-9a-z]{38}$/.test(op || "")) return { status: 0, rec: null };
    var r = lcd("/pokt-network/poktroll/supplier/supplier/" + op);
    return { status: r.status, rec: (r.status === 200 && r.json && r.json.supplier) ? r.json.supplier : null };
  }
  function supplierServiceIds(rec) { var ids = []; for (var i = 0; i < ((rec && rec.services) || []).length; i++) ids.push(rec.services[i].service_id); return ids; }

  // One row per server, read live from the chain. A server without a stack for
  // the current network is listed as unprovisioned so it can be provisioned here.
  function supplierRows() {
    var sv = servers(), out = [];
    for (var i = 0; i < sv.length; i++) {
      var s = sv[i], st = stackOf(s, state.net), sr, reach = null, ss = stackState(st);
      if (ss !== "ready") { out.push({ server: s, stack: st, state: ss, rec: null, status: 0, gas: (st && st.operator) ? balanceOf(st.operator) : null, answers: false }); continue; }
      sr = supplierRecord(st.operator);
      if (st.url) { try { reach = httpGet(st.url); } catch (e) { reach = null; } }
      out.push({ server: s, stack: st, state: "ready", rec: sr.rec, status: sr.status, gas: balanceOf(st.operator), answers: !!(reach && reach.status) });
    }
    return out;
  }
  // When an unbonding supplier's stake returns: the session end recorded at unstake
  // plus the live unbonding period. Null when the supplier is not unbonding.
  function unbondingOf(rec) {
    var end = rec && Number(rec.unstake_session_end_height || 0);
    if (!end) return null;
    var p = state.params, ret = end + (p.supplierUnbondingSessions || 0) * (p.blocksPerSession || 0), h = Number(p.height || 0), left = ret - h;
    return { serving_until: end, returns_at: ret, blocks_left: left, eta: (left > 0 && p.blockTime) ? fmtDuration(left * p.blockTime) : "" };
  }
  function unbondingNote(u) {
    if (!u) return "";
    return "stake returns to the owner wallet at block " + fmtInt(u.returns_at) + (u.blocks_left > 0 ? ", " + fmtInt(u.blocks_left) + " blocks" + (u.eta ? " (~" + u.eta + ")" : "") + " from now" : ", any moment now");
  }
  function supplierStatusCell(x) {
    if (x.state === "none") return '<span class="badge muted">not provisioned on ' + esc(NET[state.net].label) + '</span>';
    if (x.state === "pending") return '<span class="badge warn">provisioning pending</span>';
    if (x.rec) {
      var u = unbondingOf(x.rec);
      return u ? '<span class="badge warn">unstaking, ' + fmtPokt(x.rec.stake.amount) + ' POKT</span><div class="hint">' + unbondingNote(u) + '</div>' : '<span class="badge ok">staked, ' + fmtPokt(x.rec.stake.amount) + ' POKT</span>';
    }
    return x.status === 404 ? '<span class="badge muted">not staked</span>' : '<span class="badge bad">unreadable (HTTP ' + x.status + ')</span>';
  }

  function renderSuppliers(refresh) {
    if (refresh) refreshNetwork();
    $("supNetBadge").innerHTML = NET[state.net].label; $("supNetBadge").className = "badge " + (state.net === "main" ? "bad" : "info");
    var rows = supplierRows(), box = $("supList");
    if (!rows.length) { box.innerHTML = '<div class="empty"><div class="orbit"></div><p>No servers configured. A supplier lives on a server.</p><button class="btn primary" onclick="PSM.tab(\'settings\')">Add a server</button></div>'; return; }
    var h = '<table class="services"><tr><th>Server</th><th>Status on ' + esc(NET[state.net].label) + '</th><th>Services</th><th>Operator gas</th><th>URL</th><th>Actions</th></tr>';
    for (var i = 0; i < rows.length; i++) {
      var x = rows[i], s = x.server, st = x.stack || {}, ids = supplierServiceIds(x.rec);
      h += '<tr><td class="svcid">' + esc(s.name) + '<div class="hint mono">' + (st.operator ? shortAddr(st.operator) : "") + '</div></td><td>' + supplierStatusCell(x) + '</td><td>' + (ids.length ? esc(ids.join(", ")) : '<span class="hint">none</span>') + '</td><td>' + (x.gas === null ? "?" : (x.gas < 2 * POKT ? '<span class="badge warn">' + fmtPokt(x.gas) + ' POKT</span>' : fmtPokt(x.gas) + " POKT")) + '</td><td>' + (st.url ? (x.answers ? '<span class="badge ok">answers</span>' : '<span class="badge bad">no answer</span>') : '<span class="hint">none</span>') + '</td>' +
        '<td class="actions">' + (x.state === "ready" ? '<button class="btn small primary" onclick="PSM.openSupplier(\'' + esc(s.name) + '\')">' + (x.rec ? "Manage" : "Stake") + '</button>' : '<button class="btn small primary" onclick="PSM.provisionOn(\'' + esc(s.name) + '\',\'' + state.net + '\')">' + (x.state === "pending" ? "Continue provisioning" : "Provision for " + esc(NET[state.net].label)) + '</button>') + '</td></tr>';
    }
    box.innerHTML = h + "</table>";
  }

  // The editor for one supplier. state.sup.rows drive the service table.
  function openSupplier(name, preselect) {
    var s = serverByName(name);
    if (!s) { tab("supply"); return; }
    if (state.screen !== "supply") tab("supply");
    $("supListView").className = "hidden"; $("supEditView").className = "";
    $("supEditName").innerHTML = esc(s.name) + ' <span class="hint mono">' + esc(s.user + "@" + s.host) + "</span>";
    populateSupplyServers(); $("supServer").value = name; onSupplyServerChange();
    $("supResults").className = "panel hidden"; state.supPlanOk = false; $("btnSupply").disabled = true;
    loadSupplierServices(preselect);
    var current = state.sup.rec ? Number(state.sup.rec.stake.amount) : 0, min = state.params.supMinStake || 0;
    $("supAmount").value = Math.max(current, min) / POKT;
    refreshOperatorBalance();
    renderUnstakePanel();
  }
  function renderUnstakePanel() {
    var rec = state.sup && state.sup.rec, u = unbondingOf(rec);
    status("supUnstakeStatus", "");
    if (!rec) { $("supUnstakePanel").className = "panel hidden"; return; }
    $("supUnstakePanel").className = "panel";
    if (u) {
      $("supUnstakeBox").className = "warnbox";
      $("supUnstakeBox").innerHTML = "<b>Unstaking.</b> This supplier serves until block " + fmtInt(u.serving_until) + " and its " + fmtPokt(rec.stake.amount) + " POKT " + unbondingNote(u) + ". The record clears when the stake returns.";
      $("btnUnstake").className = "btn danger hidden"; $("supUnstakeHint").className = "hint hidden";
    } else {
      $("supUnstakeBox").className = "warnbox hidden";
      $("btnUnstake").className = "btn danger"; $("supUnstakeHint").className = "hint";
    }
  }
  function unstakeSupplierDialog() {
    if (state.busy || !state.sup || !state.sup.rec) return;
    var rec = state.sup.rec, op = rec.operator_address, server = state.sup.server;
    if (unbondingOf(rec)) { status("supUnstakeStatus", "This supplier is already unstaking.", "err"); return; }
    if (!state.imported || !dockerReady()) { status("supUnstakeStatus", "Owner wallet and Docker must be ready.", "err"); return; }
    if (rec.owner_address !== state.address) { status("supUnstakeStatus", "This supplier is owned by " + esc(rec.owner_address) + ", not the owner wallet.", "err"); return; }
    refreshNetwork();
    var p = state.params, ns = nextSessionBoundary(), sessions = p.supplierUnbondingSessions || 0, blocks = sessions * (p.blocksPerSession || 0);
    var ret = ns ? ns.height + blocks : 0, eta = p.blockTime ? fmtDuration(((ns ? ns.blocks : 0) + blocks) * p.blockTime) : "";
    var ids = supplierServiceIds(rec);
    var body = '<div class="dangerbox">This unstakes the supplier on <b>' + esc(server) + '</b> (operator <b>' + esc(op) + '</b>) on ' + esc(NET[state.net].label) + '. It stops serving <b>' + esc(ids.join(", ") || "its services") + '</b> when the current session ends' + (ns ? ' at block ' + fmtInt(ns.height) : '') + '.</div>' +
      '<p>Its <b>' + fmtPokt(rec.stake.amount) + ' POKT</b> stake is then locked for <b>' + fmtInt(sessions) + ' sessions</b>' + (eta ? ' (about <b>' + esc(eta) + '</b>)' : '') + (ret ? ' and returns to the owner wallet around block ' + fmtInt(ret) : '') + '. The unbonding period is a network parameter read just now. To serve again after that, provision is kept and the supplier is staked anew.</p>';
    var go = function () {
      state.busy = true; status("supUnstakeStatus", "Waiting for pocketd (simulating gas, signing, broadcasting)", "busy");
      run("tx-unstake-supplier", { network: state.net, operator_address: op }, function (r) {
        if (!r.ok) { state.busy = false; status("supUnstakeStatus", esc(r.error) + " " + esc(r.detail || ""), "err"); return; }
        status("supUnstakeStatus", "Broadcast, waiting for the block (" + esc(r.txhash.substring(0, 10)) + ")", "busy");
        pollTx(r.txhash, function (t) {
          state.busy = false;
          if (!t.ok) { status("supUnstakeStatus", esc(t.error), "err"); return; }
          var v = supplierRecord(op); state.sup.rec = v.rec; refreshNetwork(); loadHistory(); refreshBalance();
          var u = unbondingOf(v.rec);
          renderUnstakePanel();
          status("supUnstakeStatus", "Unstake accepted in block " + fmtInt(t.height) + "." + (u ? " Serving until block " + fmtInt(u.serving_until) + "; " + unbondingNote(u) + "." : ""), "ok");
        });
      });
    };
    if (state.net === "main") {
      modal("Confirm MainNet unstake", body + '<p>Type <b>UNSTAKE</b> to confirm.</p><input type="text" id="mainConfirm" autocomplete="off">',
        [{ label: "Cancel", onClick: closeModal }, { label: "Unstake on MainNet", cls: "danger solid", onClick: function () { if (trim($("mainConfirm").value) !== "UNSTAKE") return; closeModal(); go(); } }]);
    } else {
      modal("Unstake this supplier", body, [{ label: "Cancel", onClick: closeModal }, { label: "Unstake on Beta TestNet", cls: "danger solid", onClick: function () { closeModal(); go(); } }]);
    }
  }
  function closeSupplier() { $("supEditView").className = "hidden"; $("supListView").className = ""; renderSuppliers(); }

  function rpcTypeFor(id) {
    var m = readManifestFor(id);
    if (m) { try { var c = JSON.parse(readUtf8(join(state.servicesRoot, folderForId(id), m.card || "card.json"))); if (c.rpc_types && c.rpc_types[0] && c.rpc_types[0].type) return c.rpc_types[0].type; } catch (e) {} }
    return "REST";
  }
  function catalogEntry(id) { for (var i = 0; i < (state.catalog || []).length; i++) if (state.catalog[i].id === id) return state.catalog[i]; return null; }
  function supRowById(id) { for (var i = 0; i < state.sup.rows.length; i++) if (state.sup.rows[i].id === id) return state.sup.rows[i]; return null; }

  function loadSupplierServices(preselect) {
    var s = supplyServer(), st = stackOf(s, state.net) || {}, sr = supplierRecord(st.operator), rows = [];
    state.sup = { server: s.name, rec: sr.rec, status: sr.status, rows: rows };
    // Services already on chain for this supplier: kept unless unticked.
    for (var i = 0; i < ((sr.rec && sr.rec.services) || []).length; i++) {
      var sc = sr.rec.services[i], ep = (sc.endpoints && sc.endpoints[0]) || {}, ce = catalogEntry(sc.service_id);
      rows.push({ id: sc.service_id, name: ce ? ce.name : "", url: ep.url || st.url || "", rpc: ep.rpc_type || "REST", checked: true, staked: true });
    }
    // Services the owner wallet owns but this supplier does not serve yet: offered unticked.
    var owned = ownedServices();
    for (var j = 0; j < owned.length; j++) if (!supRowById(owned[j].id)) rows.push({ id: owned[j].id, name: owned[j].name, url: st.url || "", rpc: rpcTypeFor(owned[j].id), checked: false, staked: false });
    if (preselect) { var pr = supRowById(preselect); if (pr) pr.checked = true; else { var ce2 = catalogEntry(preselect); rows.push({ id: preselect, name: ce2 ? ce2.name : "", url: st.url || "", rpc: rpcTypeFor(preselect), checked: true, staked: false }); } }
    populateSupplyAdd();
    renderSupplyServices();
  }
  function populateSupplyAdd() {
    var sel = $("supAdd"), all = $("supShowAll").checked, list = all ? (state.catalog || []) : ownedServices(), owned = {}, o2 = ownedServices();
    for (var k = 0; k < o2.length; k++) owned[o2[k].id] = true;
    sel.innerHTML = "";
    var n = 0;
    for (var i = 0; i < list.length; i++) {
      if (supRowById(list[i].id)) continue;
      var o = document.createElement("option"); o.value = list[i].id; o.text = (owned[list[i].id] ? "★ " : "") + list[i].id + (list[i].name ? " (" + list[i].name + ")" : ""); sel.appendChild(o); n++;
    }
    if (!n) sel.innerHTML = '<option value="">' + (all ? "Every service is already listed" : "All your services are listed; tick Show all to add others") + '</option>';
  }
  function addSupplyService() {
    var id = $("supAdd").value; if (!id || supRowById(id)) return;
    var ce = catalogEntry(id), s = supplyServer();
    state.sup.rows.push({ id: id, name: ce ? ce.name : "", url: (stackOf(s, state.net) || {}).url || "", rpc: rpcTypeFor(id), checked: true, staked: false });
    populateSupplyAdd(); renderSupplyServices();
  }
  function supRow(i, field, value) {
    var r = state.sup.rows[i]; if (!r) return;
    if (field === "checked") r.checked = !!value; else r[field] = value;
    if (field === "checked") renderSupplyServices();
    state.supPlanOk = false; $("btnSupply").disabled = true;
  }
  function renderSupplyServices() {
    var rows = state.sup ? state.sup.rows : [], box = $("supServices");
    if (!rows.length) { box.innerHTML = '<div class="hint">No services yet. Register one, or tick Show all and add one from the catalog.</div>'; return; }
    var h = '<table class="services"><tr><th></th><th>Service</th><th>Protocol</th><th>Endpoint URL</th><th>Now</th></tr>';
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i], rpcs = ["REST", "JSON_RPC", "WEBSOCKET", "GRPC", "COMET_BFT"], opts = "";
      for (var k = 0; k < rpcs.length; k++) opts += '<option value="' + rpcs[k] + '"' + (rpcs[k] === r.rpc ? " selected" : "") + '>' + rpcs[k] + '</option>';
      var now = r.staked ? (r.checked ? '<span class="badge ok">staked</span>' : '<span class="badge bad">will be dropped</span>') : (r.checked ? '<span class="badge info">to add</span>' : '<span class="badge muted">not served</span>');
      h += '<tr><td><input type="checkbox"' + (r.checked ? " checked" : "") + ' onclick="PSM.supRow(' + i + ',\'checked\',this.checked)"></td><td class="svcid">' + esc(r.id) + (r.name ? '<div class="hint">' + esc(r.name) + '</div>' : "") + '</td>' +
        '<td><select onchange="PSM.supRow(' + i + ',\'rpc\',this.value)"' + (r.checked ? "" : " disabled") + '>' + opts + '</select></td>' +
        '<td><input type="text" value="' + esc(r.url) + '" onchange="PSM.supRow(' + i + ',\'url\',this.value)"' + (r.checked ? "" : " disabled") + '></td><td>' + now + '</td></tr>';
    }
    box.innerHTML = h + "</table>";
  }

  function readManifestFor(id) {
    var folder = folderForId(id); if (!folder) return null;
    try { var t = readUtf8(manifestPath(folder)); return t ? JSON.parse(t) : {}; } catch (e) { return null; }
  }
  function recordManifestFor(folder, field, value) {
    if (!folder) return;
    var m = {}; try { var t = readUtf8(manifestPath(folder)); if (t) m = JSON.parse(t); } catch (e) { m = {}; }
    m.networks = m.networks || {}; m.networks[state.net] = m.networks[state.net] || {};
    m.networks[state.net][field] = value;
    writeUtf8(manifestPath(folder), JSON.stringify(m, null, 2));
  }

  function operatorBalance(op) { return balanceOf(op); }

  // Shows the operator's liquid balance and suggests a top-up that covers the stake plus gas.
  function refreshOperatorBalance() {
    var op = trim($("supOperator").value);
    if (!/^pokt1[0-9a-z]{38}$/.test(op)) { $("supOpBal").innerHTML = "?"; $("supOpBalHint").innerHTML = "Enter the operator address to see its balance."; return null; }
    var bal = operatorBalance(op);
    state.opBalance = bal;
    $("supOpBal").innerHTML = bal === null ? "?" : fmtPokt(bal) + ' <small>POKT</small>';
    var pokt = parseFloat($("supAmount").value), stake = pokt > 0 ? Math.round(pokt * POKT) : 0;
    var existing = supplierRecord(op), current = existing.rec ? Number(existing.rec.stake.amount) : 0;
    var need = Math.max(0, stake - current) + 5 * POKT;
    if (bal === null) $("supOpBalHint").innerHTML = "Could not read the operator balance.";
    else if (bal >= need) $("supOpBalHint").innerHTML = "Enough for " + (stake > current ? fmtPokt(stake - current) + " POKT of stake plus" : "") + " gas. Keep a few POKT here for claims and proofs.";
    else { $("supOpBalHint").innerHTML = "Needs about " + fmtPokt(need - bal) + " POKT more to cover " + (stake > current ? fmtPokt(stake - current) + " POKT of stake plus" : "") + " gas."; if (!trim($("supFundAmount").value)) $("supFundAmount").value = Math.ceil((need - bal) / POKT); }
    return bal;
  }

  function fundOperator() {
    if (state.busy) return;
    var op = trim($("supOperator").value), pokt = parseFloat($("supFundAmount").value);
    if (!/^pokt1[0-9a-z]{38}$/.test(op)) { status("supFundStatus", "Enter a valid operator address first.", "err"); return; }
    if (!(pokt > 0)) { status("supFundStatus", "Enter an amount in POKT.", "err"); return; }
    if (!state.imported || !dockerReady()) { status("supFundStatus", "Wallet and Docker must be ready.", "err"); return; }
    var upokt = Math.round(pokt * POKT);
    refreshBalance();
    if (state.balance !== null && state.balance < upokt + 1 * POKT) { status("supFundStatus", "The owner wallet holds " + fmtPokt(state.balance) + " POKT; not enough for " + fmtPokt(upokt) + " plus gas.", "err"); return; }
    var go = function () {
      state.busy = true; status("supFundStatus", "Sending " + fmtPokt(upokt) + " POKT to the operator", "busy");
      run("tx-fund-operator", { network: state.net, to: op, amount_upokt: upokt }, function (r) {
        if (!r.ok) { state.busy = false; status("supFundStatus", esc(r.error) + " " + esc(r.detail || ""), "err"); return; }
        status("supFundStatus", "Broadcast, waiting for the block (" + esc(r.txhash.substring(0, 10)) + ")", "busy");
        pollTx(r.txhash, function (t) {
          state.busy = false;
          if (!t.ok) { status("supFundStatus", esc(t.error), "err"); return; }
          refreshBalance(); refreshOperatorBalance(); loadHistory();
          status("supFundStatus", "Sent " + fmtPokt(upokt) + " POKT to the operator in block " + fmtInt(t.height) + ".", "ok");
          $("supFundAmount").value = "";
        });
      });
    };
    if (state.net === "main") {
      modal("Confirm MainNet transfer",
        '<div class="dangerbox">This sends <b>' + fmtPokt(upokt) + ' POKT</b> of real funds from the owner wallet to the operator <b>' + esc(op) + '</b>. Transfers cannot be reversed.</div><p>Type <b>SEND</b> to confirm.</p><input type="text" id="mainConfirm" autocomplete="off">',
        [{ label: "Cancel", onClick: closeModal }, { label: "Send on MainNet", cls: "danger solid", onClick: function () { if (trim($("mainConfirm").value) !== "SEND") return; closeModal(); go(); } }]);
    } else if (confirm("Send " + fmtPokt(upokt) + " POKT from the owner wallet to the operator " + op + " on Beta TestNet?")) go();
  }

  function nextSessionBoundary() {
    var p = state.params;
    if (!p.blocksPerSession || !p.height) return null;
    var h = Number(p.height), n = p.blocksPerSession, a = p.sessionAnchor || 0;
    var next = a + Math.ceil((h - a + 1) / n) * n;
    return { height: next, blocks: next - h };
  }

  function preflightSupply(rechecked) {
    if (state.busy || !state.sup) return;
    var op = trim($("supOperator").value), pokt = parseFloat($("supAmount").value), items = [];
    var srv = supplyServer(), sshPath = srv ? ((stackOf(srv, state.net) || {}).dir || "") : "";
    $("supResults").className = "panel"; $("supPlan").className = "plan hidden"; $("supLog").className = "log hidden"; status("supStatus", "");
    state.supPlanOk = false; $("btnSupply").disabled = true;
    if (!state.imported) items.push({ level: "fail", text: "No wallet imported (it is the owner named in the stake)." });
    if (!srv) items.push({ level: "fail", text: "Choose a server. Servers are configured under Settings." });
    else if (!/^\/[A-Za-z0-9._\/-]+$/.test(sshPath)) items.push({ level: "fail", text: "Server '" + esc(srv.name) + "' has no " + NET[state.net].label + " stack. Provision it under Settings." });
    else if (!fso.FileExists(srv.keyPath)) items.push({ level: "fail", text: "The SSH key file for '" + esc(srv.name) + "' was not found on this PC.", sub: esc(srv.keyPath) });
    if (!/^pokt1[0-9a-z]{38}$/.test(op)) items.push({ level: "fail", text: "Operator address must be a pokt1 address (43 characters)." });
    if (!(pokt > 0)) items.push({ level: "fail", text: "Enter a stake amount in POKT." });
    if (op && state.address && op === state.address) items.push({ level: "fail", text: "The operator must be a different key from the owner wallet (non-custodial). Generate it on the server." });
    var chosen = [], dropped = [];
    for (var ri = 0; ri < state.sup.rows.length; ri++) { var row = state.sup.rows[ri]; if (row.checked) chosen.push(row); else if (row.staked) dropped.push(row.id); }
    if (!chosen.length) items.push({ level: "fail", text: "Tick at least one service for this supplier to serve." });
    for (var ci = 0; ci < chosen.length; ci++) {
      if (!/^https:\/\/[^\s]+$/.test(trim(chosen[ci].url))) items.push({ level: "fail", text: "Endpoint URL for '" + esc(chosen[ci].id) + "' must start with https://." });
      if (!catalogEntry(chosen[ci].id)) items.push({ level: "fail", text: "Service '" + esc(chosen[ci].id) + "' is not registered on " + NET[state.net].label + "." });
    }
    if (hasFail(items)) { checks("supChecks", items); return; }

    refreshNetwork(); refreshBalance();
    var p = state.params, upokt = Math.round(pokt * POKT);
    if (p.supMinStake === undefined) items.push({ level: "fail", text: "Could not read the supplier minimum stake." });
    else if (upokt < p.supMinStake) items.push({ level: "fail", text: "Stake " + fmtPokt(upokt) + " POKT is below the minimum " + fmtPokt(p.supMinStake) + " POKT." });
    else if (upokt === p.supMinStake) items.push({ level: "warn", text: "Stake equals the live minimum of " + fmtPokt(p.supMinStake) + " POKT with no margin.", sub: "A stake that drops below the minimum (a slash, or a raised minimum) is auto-unstaked. Add a few hundred POKT of margin." });
    else items.push({ level: "ok", text: "Stake " + fmtPokt(upokt) + " POKT is above the live minimum of " + fmtPokt(p.supMinStake) + " POKT." });
    items.push({ level: "ok", text: "Serving " + chosen.length + " service" + (chosen.length === 1 ? "" : "s") + ": " + esc(chosen.map(function (x) { return x.id + " (" + x.rpc + ")"; }).join(", ")) + "." });
    if (dropped.length) items.push({ level: "warn", text: "Unticked services will stop being served by this supplier: " + esc(dropped.join(", ")) + ".", sub: "The stake list on chain is replaced by the ticked services." });

    // Operator account: must exist with its public key on chain, and hold gas money for claims and proofs.
    var acct = lcd("/cosmos/auth/v1beta1/accounts/" + op);
    if (acct.status === 200 && acct.json && acct.json.account) {
      if (acct.json.account.pub_key) items.push({ level: "ok", text: "Operator account exists and its public key is on chain." });
      else items.push({ level: "fail", text: "Operator account exists but has never signed a transaction, so its public key is not on chain.", sub: "Send any transaction from the operator once (for example 1 uPOKT to itself), then run preflight again." });
    } else items.push({ level: "fail", text: "Operator account does not exist on " + NET[state.net].label + " yet.", sub: "Fund it with a little POKT and send one transaction from it so its public key is published." });
    var opBal = operatorBalance(op) || 0;

    var existing = supplierRecord(op), current = 0, isUpdate = false;
    if (existing.rec) {
      isUpdate = true; current = Number(existing.rec.stake.amount);
      if (existing.rec.owner_address !== state.address) items.push({ level: "fail", text: "This operator already belongs to a supplier owned by " + esc(existing.rec.owner_address) + ", not the owner wallet." });
      items.push({ level: "info", text: "Supplier already staked with " + fmtPokt(current) + " POKT for " + esc(supplierServiceIds(existing.rec).join(", ") || "no services") + ". This is an update.", sub: "The new amount must be at least the current stake." });
      if (upokt < current) items.push({ level: "fail", text: "New stake must be at least the current " + fmtPokt(current) + " POKT." });
    } else if (existing.status === 404) items.push({ level: "ok", text: "No supplier exists for this operator yet; this creates one." });
    else items.push({ level: "fail", text: "Could not read the supplier record (HTTP " + existing.status + ")." });

    var delta = Math.max(0, upokt - current), need = delta + 1 * POKT;
    if (opBal < need) { items.push({ level: "fail", text: "Operator holds " + fmtPokt(opBal) + " POKT but needs " + fmtPokt(delta) + " POKT of stake plus gas. Fund it from the owner wallet using the box above.", sub: "Suggested: " + fmtPokt(need - opBal + 4 * POKT) + " POKT." }); if (!trim($("supFundAmount").value)) $("supFundAmount").value = Math.ceil((need - opBal + 4 * POKT) / POKT); }
    else if (opBal - delta < 2 * POKT) items.push({ level: "warn", text: "After staking, the operator would keep only " + fmtPokt(opBal - delta) + " POKT for claim and proof gas. Consider topping it up." });
    else items.push({ level: "ok", text: "Operator holds " + fmtPokt(opBal) + " POKT: covers " + fmtPokt(delta) + " POKT of stake plus gas, leaving " + fmtPokt(opBal - delta) + " POKT for claims and proofs." });

    var urls = {}; for (var ui = 0; ui < chosen.length; ui++) urls[trim(chosen[ui].url)] = true;
    for (var u in urls) if (urls.hasOwnProperty(u)) { var reach; try { reach = httpGet(u); } catch (e) { reach = null; } items.push(reach && reach.status ? { level: "ok", text: esc(u) + " answered (HTTP " + reach.status + ")." } : { level: "warn", text: "Could not reach " + esc(u) + " from this PC. Gateways will not be able to either unless it is a temporary outage." }); }

    var ns = nextSessionBoundary();
    if (ns) items.push({ level: "info", text: "The stake takes effect at the next session boundary: height " + fmtInt(ns.height) + ", about " + ns.blocks + " block" + (ns.blocks === 1 ? "" : "s") + (p.blockTime ? " (~" + fmtDuration(ns.blocks * p.blockTime) + ")" : "") + " from now." });
    if (p.supplierUnbondingSessions) items.push({ level: "info", text: "Unstaking later takes " + fmtInt(p.supplierUnbondingSessions) + " sessions" + (p.blockTime && p.blocksPerSession ? ", about " + fmtDuration(p.supplierUnbondingSessions * p.blocksPerSession * p.blockTime) + "," : "") + " before the POKT returns to the owner wallet." });

    if (hasFail(items)) { checks("supChecks", items); status("supStatus", "Fix the red items and run preflight again.", "err"); return; }
    checks("supChecks", items); status("supStatus", "Building the plan", "busy");
    var services = chosen.map(function (x) { return { service_id: x.id, url: trim(x.url), rpc_type: x.rpc }; });
    var conn = { host: srv.host, port: srv.port, user: srv.user, key_path: srv.keyPath, path: sshPath };
    run("remote-stake-supplier", { network: state.net, host: conn.host, port: conn.port, user: conn.user, key_path: conn.key_path, path: conn.path, owner_address: state.address, operator_address: op, stake_upokt: upokt, services: services, dry: true }, function (r) {
      if (!r.ok) { items.push({ level: "fail", text: "The signer refused the plan.", sub: esc(r.error) + " " + esc(r.detail) }); checks("supChecks", items); status("supStatus", "", "err"); return; }
      $("supPlan").className = "plan"; $("supPlanCmd").innerHTML = esc(r.command) + "\n\n# supplier_stake.yaml (copied to the server)\n" + esc(r.config);
      state.supPlanOk = true; state.supForm = { op: op, upokt: upokt, services: services, isUpdate: isUpdate, server: srv.name, conn: conn, key: JSON.stringify(services) };
      $("btnSupply").disabled = false;
      status("supStatus", "Preflight passed. Review the plan, then press " + $("btnSupply").innerHTML + ".", "ok");
    });
  }

  function executeSupply() {
    if (!state.supPlanOk || state.busy) return;
    var f = state.supForm, chosenNow = [];
    for (var ri = 0; ri < state.sup.rows.length; ri++) if (state.sup.rows[ri].checked) chosenNow.push({ service_id: state.sup.rows[ri].id, url: trim(state.sup.rows[ri].url), rpc_type: state.sup.rows[ri].rpc });
    if (f.server !== $("supServer").value || f.op !== trim($("supOperator").value) || f.upokt !== Math.round(parseFloat($("supAmount").value) * POKT) || f.key !== JSON.stringify(chosenNow)) { status("supStatus", "The form changed since preflight. Run preflight again.", "err"); $("btnSupply").disabled = true; state.supPlanOk = false; return; }
    var ids = f.services.map(function (x) { return x.service_id; });
    var go = function () {
      state.busy = true; $("btnSupply").disabled = true;
      $("supLog").className = "log"; $("supLog").innerHTML = "";
      logTo("supLog", "Copying the stake config to " + esc(f.server) + " and signing with the operator key there, " + fmtPokt(f.upokt) + " POKT for " + esc(ids.join(", ")) + " on " + NET[state.net].label);
      status("supStatus", "Waiting for the server (simulating gas, signing, broadcasting)", "busy");
      run("remote-stake-supplier", { network: state.net, host: f.conn.host, port: f.conn.port, user: f.conn.user, key_path: f.conn.key_path, path: f.conn.path, owner_address: state.address, operator_address: f.op, stake_upokt: f.upokt, services: f.services }, function (r) {
        if (!r.ok) { state.busy = false; logTo("supLog", esc(r.error) + " " + esc(r.detail || r.raw_log), "err"); status("supStatus", "Supplier stake failed.", "err"); return; }
        logTo("supLog", "Accepted into the mempool. Tx " + txLink(r.txhash) + (r.gas ? " (gas estimate " + fmtInt(r.gas) + ")" : ""));
        status("supStatus", "Waiting for the transaction to be included in a block", "busy");
        pollTx(r.txhash, function (t) {
          if (!t.ok) { state.busy = false; logTo("supLog", esc(t.error), "err"); status("supStatus", "The transaction did not succeed.", "err"); return; }
          logTo("supLog", "Included in block " + fmtInt(t.height) + ".", "ok");
          // A supplier's service list changes at the next session boundary, not at
          // inclusion: the record's `services` is the active set and
          // `service_config_history` holds the scheduled one (deactivation_height 0).
          var v = supplierRecord(f.op), okv = false, pendingAt = 0, pending = [];
          if (v.rec) {
            var got = supplierServiceIds(v.rec), hist = v.rec.service_config_history || [], scheduled = {};
            for (var hi = 0; hi < hist.length; hi++) { var he = hist[hi]; if (he.service && Number(he.deactivation_height || 0) === 0) scheduled[he.service.service_id] = Number(he.activation_height || 0); }
            okv = Number(v.rec.stake.amount) >= f.upokt;
            for (var i = 0; i < ids.length; i++) {
              if (got.indexOf(ids[i]) >= 0) continue;
              if (scheduled[ids[i]] !== undefined) { pending.push(ids[i]); pendingAt = Math.max(pendingAt, scheduled[ids[i]]); } else okv = false;
            }
            logTo("supLog", "On chain: supplier " + esc(f.op) + " staked " + fmtPokt(v.rec.stake.amount) + " POKT; active for " + esc(got.join(", ") || "nothing yet") + (pending.length ? "; " + esc(pending.join(", ")) + " scheduled from height " + fmtInt(pendingAt) : "") + ".", okv ? "ok" : "err");
          }
          var ns = nextSessionBoundary();
          status("supStatus", okv ? "Supplier staked on " + NET[state.net].label + " for " + esc(ids.join(", ")) + "." + (pending.length ? " New services start serving at height " + fmtInt(pendingAt) + " (the next session boundary)." : "") : "Transaction succeeded but the supplier record does not list every service; check the Activity list.", okv ? "ok" : "err");
          if (okv) {
            for (var j = 0; j < f.services.length; j++) {
              var folder = folderForId(f.services[j].service_id);
              if (!folder) continue;
              recordManifestFor(folder, "supplier_stake_tx", r.txhash); recordManifestFor(folder, "supplier_operator", f.op); recordManifestFor(folder, "supplier_url", f.services[j].url); recordManifestFor(folder, "deploy_host", f.server); recordManifestFor(folder, "deploy_path", f.conn.path);
            }
          }
          state.busy = false; state.supPlanOk = false; refreshBalance(); refreshOperatorBalance(); loadHistory();
          loadSupplierServices(); renderServices();
        });
      });
    };
    if (state.net === "main") {
      modal("Confirm MainNet supplier stake",
        '<div class="dangerbox">This locks <b>' + fmtPokt(f.upokt) + ' POKT</b> of real funds as a supplier stake for operator <b>' + esc(f.op) + '</b>, serving <b>' + esc(ids.join(", ")) + '</b>. Unstaking takes ' + (state.params.supplierUnbondingSessions || "many") + ' sessions.</div>' +
        '<p>Type the server name (<b>' + esc(f.server) + '</b>) to confirm.</p><input type="text" id="mainConfirm" autocomplete="off">',
        [{ label: "Cancel", onClick: closeModal }, { label: "Stake supplier on MainNet", cls: "danger solid", onClick: function () { if (trim($("mainConfirm").value) !== f.server) return; closeModal(); go(); } }]);
    } else if (confirm("Stake " + fmtPokt(f.upokt) + " POKT as the supplier on '" + f.server + "' for " + ids.join(", ") + " on Beta TestNet now?")) go();
  }

  // From My services: open the default supplier with that service ticked.
  function svcSupply(id) {
    var sv = servers(), name = loadSettings().supplierServer;
    if (!sv.length) { tab("settings"); foot("Add a server first; a supplier lives on a server."); return; }
    if (!serverByName(name)) name = sv[0].name;
    openSupplier(name, id);
  }

  // -------------------------------------------------------- provision ----
  // Turns a configured server into a supplier for one network, step by step over
  // SSH through the signer: ship the stack, create the operator key there, fund it
  // from the owner wallet if needed, publish its public key, start the stack.

  function connOf(s, net) { var st = stackOf(s, net || state.net) || {}; return { host: s.host, port: s.port, user: s.user, key_path: s.keyPath, path: st.dir || "" }; }
  // Loopback ports each network's stack publishes on the server (health, relayer metrics, miner metrics).
  function stackPorts(net) { return net === "main" ? { health: 8082, relayer_metrics: 9091, miner_metrics: 9093 } : { health: 8081, relayer_metrics: 9090, miner_metrics: 9092 }; }
  function hostOfUrl(u) { var m = /^https?:\/\/([^\/:]+)/.exec(String(u || "")); return m ? m[1] : ""; }
  function updateServer(name, patch) {
    var list = servers().slice();
    for (var i = 0; i < list.length; i++) if (list[i].name === name) { for (var k in patch) if (patch.hasOwnProperty(k)) list[i][k] = patch[k]; }
    if (state.serversOverride) { state.serversOverride = list; return; }
    saveSettings({ servers: list });
  }
  function openProvision(name, net) {
    var s = serverByName(name); if (!s) return;
    state.provServer = name; populateProvServers();
    $("provNet").value = net || state.net; onProvNetChange();
    $("provChecks").innerHTML = ""; $("provLog").className = "log hidden"; $("provLog").innerHTML = ""; status("provStatus", "");
    try { $("provPanel").scrollIntoView(true); } catch (e) { $("content").scrollTop = $("content").scrollHeight; }
  }
  function closeProvision() { $("provChecks").innerHTML = ""; $("provLog").className = "log hidden"; status("provStatus", ""); }
  function onProvNetChange() {
    var s = serverByName($("provServer").value || state.provServer), net = $("provNet").value, st = s ? stackOf(s, net) : null;
    $("provDir").value = (st && st.dir) || stackDirDefault(net);
    $("provHost").value = st ? hostOfUrl(st.url) : "";
    var ss = stackState(st);
    $("provDirHint").innerHTML = ss === "ready" ? "This server already has a " + esc(NET[net].label) + " stack there; its operator key and relayer config are kept." : ss === "pending" ? "Provisioning of this stack was interrupted after its operator key was created. Start provisioning resumes it; finished steps are not repeated." : "A new stack for " + esc(NET[net].label) + "; a new operator key is created on the server.";
    $("btnProv").innerHTML = ss === "pending" ? "Continue provisioning" : ss === "ready" ? "Re-provision" : "Start provisioning";
  }
  // From the Suppliers screen or a server row: switch the app to the network (it is
  // where the operator is funded and published), then open Provision for it.
  function provisionOn(name, net) {
    if (net !== state.net) { setNetwork(net); if (state.net !== net) return; }
    tab("settings"); openProvision(name, net);
  }

  function runProvision() {
    if (state.busy) return;
    var s = serverByName($("provServer").value), net = $("provNet").value, host = trim($("provHost").value), topup = parseFloat($("provFund").value), dir = trim($("provDir").value);
    if (!s) { status("provStatus", "Choose a server.", "err"); return; }
    if (!/^\/[A-Za-z0-9._\/-]+$/.test(dir)) { status("provStatus", "The stack directory must be an absolute Linux path.", "err"); return; }
    for (var on in (s.suppliers || {})) if (s.suppliers.hasOwnProperty(on) && on !== net && s.suppliers[on].dir === dir) { status("provStatus", "That directory already holds the " + NET[on].label + " stack. Each network needs its own directory.", "err"); return; }
    var existing = stackOf(s, net) || {}, project = existing.project || stackProjectDefault(net), ports = stackPorts(net);
    if (!/^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(host)) { status("provStatus", "Enter the public hostname (a DNS name pointing at the server).", "err"); return; }
    if (!state.imported || !dockerReady()) { status("provStatus", "Owner wallet and Docker must be ready.", "err"); return; }
    if (net !== state.net) { status("provStatus", "Switch the app to " + NET[net].label + " first; the operator is funded and published on the network being provisioned.", "err"); return; }
    var conn = { host: s.host, port: s.port, user: s.user, key_path: s.keyPath, path: dir }, results = [], operator = existing.operator || "";
    state.busy = true; $("btnProv").disabled = true;
    $("provLog").className = "log"; $("provLog").innerHTML = ""; $("provChecks").innerHTML = ""; status("provStatus", "Provisioning", "busy");
    function mark(label, ok, note) { results.push({ level: ok ? "ok" : "fail", text: label, sub: note || "" }); checks("provChecks", results); }
    function fail(msg) { logTo("provLog", esc(msg), "err"); status("provStatus", "Provisioning stopped. Fix the problem and start again; finished steps are kept.", "err"); state.busy = false; $("btnProv").disabled = false; }
    function done() {
      setStack(s.name, net, { dir: dir, project: project, url: "https://" + host, operator: operator, provisioned_at: new Date().toISOString() });
      logTo("provLog", "Server " + esc(s.name) + " now has a " + esc(NET[net].label) + " supplier stack at " + esc(dir) + ". Deploy a service to it next (Services, Deploy service).", "ok");
      status("provStatus", "Provisioned. Operator " + esc(operator) + ".", "ok");
      state.busy = false; $("btnProv").disabled = false; renderServers(); populateSupplyServers(); loadHistory();
    }
    logTo("provLog", "Checking the SSH connection to " + esc(s.user + "@" + s.host) + " on port " + esc(String(s.port)));
    run("ssh-test", { host: conn.host, port: conn.port, user: conn.user, key_path: conn.key_path }, function (r) {
      if (!r.ok) { mark("SSH connection", false, esc(r.error) + " " + esc(r.detail || "")); return fail("Could not connect."); }
      if (!r.docker) { mark("Docker on the server", false, "Docker Compose was not found on the server."); return fail("Install Docker on the server first."); }
      mark("SSH connection and Docker", true, esc(r.hostname) + ", " + esc(r.docker));
      logTo("provLog", "Shipping the " + esc(NET[net].label) + " RelayMiner stack to " + esc(dir) + " (project " + esc(project) + ") with hostname " + esc(host) + ", and the shared Caddy to " + esc(CADDY_DIR));
      run("supplier-ship", { host: conn.host, port: conn.port, user: conn.user, key_path: conn.key_path, path: conn.path, network: net, hostname: host, project: project, caddy_dir: CADDY_DIR, health_port: ports.health, relayer_metrics_port: ports.relayer_metrics, miner_metrics_port: ports.miner_metrics, block_time: Math.round(state.params.blockTime || 0) }, function (r2) {
        if (!r2.ok) { mark("Ship the stack", false, esc(r2.error) + " " + esc(r2.detail || "")); return fail("Shipping failed."); }
        mark("Ship the stack", true, "Copied " + esc(r2.files.join(", ")) + (r2.relayer_kept ? "; the existing relayer config with its services was kept" : ""));
        // Remember the stack from here on, so an interrupted run resumes with the same directory and hostname.
        setStack(s.name, net, { dir: dir, project: project, url: "https://" + host });
        logTo("provLog", "Creating the operator key on the server (kept if it already exists). It never leaves the server.");
        run("supplier-run", { host: conn.host, port: conn.port, user: conn.user, key_path: conn.key_path, path: conn.path, step: "operator" }, function (r3) {
          if (!r3.ok || !r3.address) { mark("Operator key", false, esc(r3.err || r3.error || "no address returned")); return fail("Operator key step failed."); }
          operator = r3.address; setStack(s.name, net, { dir: dir, project: project, operator: operator, url: "https://" + host });
          mark("Operator key", true, esc(r3.lines.join(" | ")));
          logTo("provLog", "Writing the RelayMiner's key file from the operator keyring (mode 400).");
          run("supplier-run", { host: conn.host, port: conn.port, user: conn.user, key_path: conn.key_path, path: conn.path, step: "keys" }, function (r4) {
            if (!r4.ok) { mark("RelayMiner key file", false, esc(r4.err || r4.error)); return fail("Key file step failed."); }
            mark("RelayMiner key file", true, "supplier-keys.yaml written");
            var bal = balanceOf(operator) || 0;
            logTo("provLog", "Operator " + esc(operator) + " holds " + fmtPokt(bal) + " POKT on " + esc(NET[net].label) + ".");
            function afterFunding() {
              var acct = lcd("/cosmos/auth/v1beta1/accounts/" + operator);
              var published = acct.status === 200 && acct.json && acct.json.account && acct.json.account.pub_key;
              function afterPublish() {
                logTo("provLog", "Starting the server's shared Caddy, then Redis and the miner. The relayer starts with the first deployed service.");
                run("supplier-run", { host: conn.host, port: conn.port, user: conn.user, key_path: conn.key_path, path: conn.path, step: "start" }, function (r6) {
                  if (!r6.ok) { mark("Start the stack", false, esc(r6.err || r6.error)); return fail("Start failed."); }
                  mark("Start the stack", true, esc(r6.lines.slice(-3).join(" | ")));
                  run("supplier-run", { host: conn.host, port: conn.port, user: conn.user, key_path: conn.key_path, path: conn.path, step: "status" }, function (r7) {
                    if (r7.ok) mark("Status", true, esc(r7.lines.join(" | ")));
                    done();
                  }, { timeoutMs: 120000 });
                }, { timeoutMs: 300000 });
              }
              if (published) { mark("Operator public key on chain", true, "already published"); afterPublish(); return; }
              logTo("provLog", "Publishing the operator's public key with a 1 uPOKT self-transfer signed on the server.");
              run("supplier-run", { host: conn.host, port: conn.port, user: conn.user, key_path: conn.key_path, path: conn.path, step: "publish", network: net }, function (r5) {
                if (!r5.ok) { mark("Operator public key on chain", false, esc(r5.err || r5.error)); return fail("Publishing failed. Is the operator funded?"); }
                mark("Operator public key on chain", true, esc(r5.lines.join(" | ")));
                afterPublish();
              }, { timeoutMs: 420000 });
            }
            if (bal >= 5 * POKT) { mark("Operator gas", true, fmtPokt(bal) + " POKT available"); afterFunding(); return; }
            if (!(topup > 0)) { mark("Operator gas", false, "The operator needs POKT for gas and no top-up amount was given."); return fail("Enter a top-up amount."); }
            logTo("provLog", "Sending " + fmtPokt(Math.round(topup * POKT)) + " POKT from the owner wallet to the operator for gas.");
            $("supOperator").value = operator; $("supFundAmount").value = String(topup);
            var upokt = Math.round(topup * POKT);
            var go = function () {
              run("tx-fund-operator", { network: net, to: operator, amount_upokt: upokt }, function (rf) {
                if (!rf.ok) { mark("Operator gas", false, esc(rf.error) + " " + esc(rf.detail || "")); return fail("Funding failed."); }
                pollTx(rf.txhash, function (t) {
                  if (!t.ok) { mark("Operator gas", false, esc(t.error)); return fail("Funding transaction failed."); }
                  mark("Operator gas", true, "Sent " + fmtPokt(upokt) + " POKT in block " + fmtInt(t.height));
                  refreshBalance(); afterFunding();
                });
              });
            };
            if (net === "main") {
              modal("Confirm MainNet transfer", '<div class="dangerbox">This sends <b>' + fmtPokt(upokt) + ' POKT</b> of real funds from the owner wallet to the new operator <b>' + esc(operator) + '</b>.</div><p>Type <b>SEND</b> to confirm.</p><input type="text" id="mainConfirm" autocomplete="off">',
                [{ label: "Cancel", onClick: function () { closeModal(); fail("Funding cancelled."); } }, { label: "Send on MainNet", cls: "danger solid", onClick: function () { if (trim($("mainConfirm").value) !== "SEND") return; closeModal(); go(); } }]);
            } else if (confirm("Send " + fmtPokt(upokt) + " POKT from the owner wallet to the operator " + operator + " on Beta TestNet?")) go(); else fail("Funding cancelled.");
          }, { timeoutMs: 120000 });
        }, { timeoutMs: 120000 });
      }, { timeoutMs: 180000 });
    }, { timeoutMs: 60000 });
  }

  // ----------------------------------------------------------- deploy ----
  // Ships a service's backend to a provisioned server, starts it on the supplier
  // network, and adds it to the relayer. Then the supplier can be staked for it.

  function deployableServices() {
    var out = [], local = localServices();
    for (var i = 0; i < local.length; i++) if (fso.FileExists(join(state.servicesRoot, local[i].folder, "backend", "Dockerfile"))) out.push(local[i]);
    return out;
  }
  function provisionedServers() {
    var out = [], sv = servers();
    for (var i = 0; i < sv.length; i++) { var st = stackOf(sv[i], state.net); if (stackState(st) === "ready" && st.dir) out.push(sv[i]); }
    return out;
  }
  function svcDeploy(id) { tab("deploy"); $("depId").value = id; onDeployServiceChange(); }
  function openDeploy() {
    $("depNetBadge").innerHTML = NET[state.net].label; $("depNetBadge").className = "badge " + (state.net === "main" ? "bad" : "info");
    var sel = $("depId"), cur = sel.value, list = deployableServices();
    sel.innerHTML = "";
    if (!list.length) sel.innerHTML = '<option value="">No deployable services</option>';
    for (var i = 0; i < list.length; i++) { var o = document.createElement("option"); o.value = list[i].id; o.text = list[i].id + (list[i].name ? " (" + list[i].name + ")" : ""); sel.appendChild(o); }
    sel.value = cur; if (!sel.value && list.length) sel.selectedIndex = 0;
    var ss = $("depServer"), curS = ss.value || loadSettings().supplierServer, ps = provisionedServers();
    ss.innerHTML = "";
    if (!ps.length) { ss.innerHTML = '<option value="">No provisioned servers</option>'; $("depServerHint").innerHTML = 'No server is provisioned for ' + esc(NET[state.net].label) + '. <a href="#" onclick="PSM.tab(\'settings\');return false;">Provision one under Settings.</a>'; }
    else { for (var j = 0; j < ps.length; j++) { var o2 = document.createElement("option"); o2.value = ps[j].name; o2.text = ps[j].name + " (" + ps[j].user + "@" + ps[j].host + ")"; ss.appendChild(o2); } ss.value = curS; if (!ss.value) ss.selectedIndex = 0; $("depServerHint").innerHTML = "Provisioned servers on " + esc(NET[state.net].label) + "."; }
    $("btnDeployStake").className = "btn hidden"; $("btnDeployTest").className = "btn hidden";
    onDeployServiceChange();
  }
  function onDeployServiceChange() {
    var id = $("depId").value, m = readManifestFor(id), folder = folderForId(id);
    var own = folder && fso.FileExists(join(state.servicesRoot, folder, "deploy", "docker-compose.yaml"));
    $("depIdHint").innerHTML = id ? ("Builds <span class=\"mono\">" + esc(folder) + "\\backend</span>" + (own ? " with the service's own deploy compose file." : " with the standard backend-only compose file.") + (m && m.networks && m.networks[state.net] && m.networks[state.net].deploy_host ? " Last deployed to " + esc(m.networks[state.net].deploy_host) + "." : "")) : "";
  }
  function readinessPath(id) {
    var p = testProbes(id).steps;
    for (var i = 0; i < p.length; i++) if (p[i].label.indexOf("Readiness") === 0) return p[i].path;
    return "/healthz";
  }
  function runDeploy() {
    if (state.busy) return;
    var id = $("depId").value, s = serverByName($("depServer").value), folder = folderForId(id);
    if (!id || !folder) { status("depStatus", "Choose a service.", "err"); return; }
    if (!s) { status("depStatus", "Choose a provisioned server.", "err"); return; }
    if (!fso.FileExists(s.keyPath)) { status("depStatus", "The SSH key file for " + esc(s.name) + " was not found on this PC.", "err"); return; }
    var conn = connOf(s), root = s.deployRoot || "/opt/pocket/services", hp = readinessPath(id), results = [];
    state.busy = true; $("btnDeploy").disabled = true; $("btnDeployStake").className = "btn hidden"; $("btnDeployTest").className = "btn hidden";
    $("depLog").className = "log"; $("depLog").innerHTML = ""; $("depChecks").innerHTML = ""; status("depStatus", "Deploying", "busy");
    function mark(label, ok, note) { results.push({ level: ok ? "ok" : "fail", text: label, sub: note || "" }); checks("depChecks", results); }
    function fail(msg) { logTo("depLog", esc(msg), "err"); status("depStatus", "Deployment stopped.", "err"); state.busy = false; $("btnDeploy").disabled = false; }
    logTo("depLog", "Deploying <b>" + esc(id) + "</b> to <b>" + esc(s.name) + "</b> (" + esc(s.user + "@" + s.host) + ") for " + esc(NET[state.net].label) + ": backend at " + esc(root + "/" + id) + ", relayer in " + esc(conn.path));
    run("ssh-test", { host: conn.host, port: conn.port, user: conn.user, key_path: conn.key_path, path: conn.path }, function (r) {
      if (!r.ok) { mark("SSH connection", false, esc(r.error) + " " + esc(r.detail || "")); return fail("Could not connect."); }
      if (!r.keyring) { mark("Supplier on the server", false, "No operator keyring in " + esc(conn.path) + ". Provision the server first."); return fail("Server is not provisioned."); }
      mark("SSH connection and supplier", true, esc(r.hostname));
      logTo("depLog", "Packing the backend (without node_modules) and its compose file, and copying them to the server.");
      run("deploy-ship", { host: conn.host, port: conn.port, user: conn.user, key_path: conn.key_path, deploy_root: root, service_id: id, folder: join(state.servicesRoot, folder) }, function (r2) {
        if (!r2.ok) { mark("Ship the backend", false, esc(r2.error) + " " + esc(r2.detail || "")); return fail("Shipping failed."); }
        mark("Ship the backend", true, fmtInt(r2.bytes) + " bytes, " + esc(r2.files) + " files, compose from " + esc(r2.compose_from));
        logTo("depLog", "Building the image and starting <span class=\"mono\">" + esc(id) + "-backend</span> on the supplier network; waiting for " + esc(hp) + " to answer.");
        run("supplier-run", { host: conn.host, port: conn.port, user: conn.user, key_path: conn.key_path, path: conn.path, step: "deploy", service_id: id, deploy_root: root, health_path: hp }, function (r3) {
          if (!r3.ok) { mark("Build and start the backend", false, esc(r3.err || r3.error) + " " + esc(r3.lines.slice(-5).join(" | "))); return fail("The backend did not start."); }
          mark("Build and start the backend", true, esc(r3.lines.slice(-2).join(" | ")));
          logTo("depLog", "Adding the service to the RelayMiner and recreating the relayer.");
          run("supplier-run", { host: conn.host, port: conn.port, user: conn.user, key_path: conn.key_path, path: conn.path, step: "add-service", service_id: id, backend_url: "http://" + id + "-backend:8080", health_path: hp }, function (r4) {
            if (!r4.ok) { mark("Connect to the RelayMiner", false, esc(r4.err || r4.error) + " " + esc(r4.lines.slice(-3).join(" | "))); return fail("The relayer did not come up."); }
            mark("Connect to the RelayMiner", true, esc(r4.lines.join(" | ")));
            recordManifestFor(folder, "deploy_host", s.name); recordManifestFor(folder, "deploy_path", conn.path); recordManifestFor(folder, "deployed_at", new Date().toISOString());
            refreshNetwork();
            var sp = supplyStatusMap()[id], served = !!(sp && sp.state === "active"), pendingSp = !!(sp && sp.state === "pending");
            logTo("depLog", served ? "The supplier on " + esc(NET[state.net].label) + " is active for " + esc(id) + ": relays can flow now." : pendingSp ? "The supplier is staked for " + esc(id) + " and serves it from " + activationNote(sp.activation_height) + "." : "The supplier is not yet staked for " + esc(id) + " on " + esc(NET[state.net].label) + ". Stake it next, then test.", "ok");
            status("depStatus", "Deployed on " + esc(NET[state.net].label) + ". " + (served ? "Active now: test it." : pendingSp ? "Pending: active from " + activationNote(sp.activation_height) + "." : "Now stake the supplier for it."), "ok");
            state.deployed = { id: id, server: s.name };
            $("btnDeployStake").className = served ? "btn hidden" : "btn primary"; $("btnDeployTest").className = served ? "btn primary" : "btn";
            state.busy = false; $("btnDeploy").disabled = false; loadHistory();
          }, { timeoutMs: 240000 });
        }, { timeoutMs: 600000 });
      }, { timeoutMs: 600000 });
    }, { timeoutMs: 60000 });
  }
  function deployThenStake() { if (state.deployed) openSupplier(state.deployed.server, state.deployed.id); }
  function deployThenTest() { if (state.deployed) svcTest(state.deployed.id); }

  // ------------------------------------------------------------- test ----
  // Sends a service's card probes through the protocol with pocket-ap in a
  // container, signed by an application wallet the signer reads from the keyring.
  // Every run is appended to relay-tests.log (JSON lines) in the state dir.

  function testLogPath() { return join(state.stateDir, "relay-tests.log"); }
  function svcTest(id) { tab("test"); $("tstId").value = id; onTestServiceChange(); }

  function openTest() {
    $("tstNetBadge").innerHTML = NET[state.net].label; $("tstNetBadge").className = "badge " + (state.net === "main" ? "bad" : "info");
    var sel = $("tstId"), cur = sel.value, ids = [], seen = {}, owned = ownedServices(), local = localServices();
    for (var i = 0; i < owned.length; i++) if (!seen[owned[i].id]) { seen[owned[i].id] = true; ids.push([owned[i].id, owned[i].name]); }
    for (var j = 0; j < local.length; j++) if (!seen[local[j].id]) { seen[local[j].id] = true; ids.push([local[j].id, local[j].name]); }
    sel.innerHTML = "";
    if (!ids.length) sel.innerHTML = '<option value="">No services</option>';
    for (var k = 0; k < ids.length; k++) { var o = document.createElement("option"); o.value = ids[k][0]; o.text = ids[k][0] + (ids[k][1] ? " (" + ids[k][1] + ")" : ""); sel.appendChild(o); }
    sel.value = cur; if (!sel.value) sel.selectedIndex = 0;
    $("tstClient").innerHTML = (state.docker && state.docker.ok) ? (state.docker.pocketap ? '<span class="badge ok">pocket-ap ready</span>' : 'pocket-ap image not downloaded <button class="btn small" onclick="PSM.pullPocketAp()">Download pocket-ap</button>') : '<span class="badge bad">Docker is not running</span>';
    onTestServiceChange();
  }
  function pullPocketAp() {
    $("tstClient").innerHTML = '<span class="status busy">Downloading the pocket-ap image</span>';
    run("pocketap-pull", {}, function (r) {
      if (!r.ok) { $("tstClient").innerHTML = '<span class="badge bad">download failed</span> ' + esc(r.error); return; }
      state.docker.pocketap = true; $("tstClient").innerHTML = '<span class="badge ok">' + esc(r.version || "pocket-ap ready") + '</span>';
    }, { timeoutMs: 900000 });
  }
  function onTestServiceChange() {
    var id = $("tstId").value, sel = $("tstWallet"), cur = sel.value;
    sel.innerHTML = "";
    var holders = [{ name: PARENT, address: state.address, parent: true }].concat(state.wallets), pick = "", n = 0;
    for (var i = 0; i < holders.length; i++) {
      var hld = holders[i]; if (!hld.address) continue;
      var a = appRecordOf(hld.address), ids = appServiceIds(a), staked = ids.indexOf(id) >= 0;
      var o = document.createElement("option"); o.value = hld.name; o.text = hld.name + (a ? " (staked for " + ids.join(", ") + ")" : " (no application stake)"); sel.appendChild(o); n++;
      if (staked && !pick) pick = hld.name;
    }
    if (!n) sel.innerHTML = '<option value="">No wallets</option>';
    sel.value = cur; if (pick) sel.value = pick; if (!sel.value && n) sel.selectedIndex = 0;
    $("tstWalletHint").innerHTML = pick ? esc(pick) + " is staked for " + esc(id) + "." : '<span style="color:#8a5a00">No wallet is staked for ' + esc(id) + ' on ' + esc(NET[state.net].label) + '. Stake one first (Stake application).</span>';
    var probes = testProbes(id), mf = readManifestFor(id), nm = (mf && mf.networks && mf.networks[state.net]) || {};
    $("tstIdHint").innerHTML = (probes.fromCard ? probes.steps.length + " probes from the card." : "No card found; using the default probes (" + probes.steps.length + ").") +
      (nm.deployed_at ? "" : ' <span style="color:#8a5a00">Not deployed on ' + esc(NET[state.net].label) + ' from this machine yet: the supplier has no relayer for it until Deploy service runs, so relays will fail.</span>');
  }

  // Probe list for a service: the card's serving.healthcheck entries plus a
  // bad-input probe against the functional path, or two defaults without a card.
  function testProbes(id) {
    var m = readManifestFor(id), card = null, folder = folderForId(id);
    if (m && folder) { try { card = JSON.parse(readUtf8(join(state.servicesRoot, folder, m.card || "card.json"))); } catch (e) { card = null; } }
    var steps = [], hc = (card && card.serving && card.serving.healthcheck) || [];
    for (var i = 0; i < hc.length; i++) {
      var h = hc[i], rq = h.request || {}, ex = h.expect || {};
      if (!rq.path) continue;
      var note = String(h.notes || "").toLowerCase(), label = note.indexOf("identity") >= 0 ? "Identity probe" : (note.indexOf("readiness") >= 0 ? "Readiness probe" : "Functional probe");
      steps.push({ label: label + " " + (rq.method || "GET") + " " + rq.path, method: rq.method || "GET", path: rq.path, body: rq.body ? JSON.stringify(rq.body) : "", jsonPath: ex.json_path, matches: ex.matches, expectStatus: 200 });
      if ((rq.method || "GET") === "POST" && rq.body) steps.push({ label: "Bad input POST " + rq.path, method: "POST", path: rq.path, body: "{}", expectStatus: 400, badInput: true });
    }
    if (!steps.length) {
      steps.push({ label: "Identity probe GET /v1/version", method: "GET", path: "/v1/version", body: "", jsonPath: "$.service", matches: "^" + id + "$", expectStatus: 200 });
      steps.push({ label: "Readiness probe GET /healthz", method: "GET", path: "/healthz", body: "", jsonPath: "$.status", matches: "^ok$", expectStatus: 200 });
    }
    return { steps: steps, fromCard: hc.length > 0 };
  }

  // Minimal JSONPath: $.a.b[0].c
  function jsonPathGet(obj, path) {
    if (!path || path.charAt(0) !== "$") return undefined;
    var cur = obj, parts = path.substring(1).replace(/\[(\d+)\]/g, ".$1").split(".");
    for (var i = 0; i < parts.length; i++) { if (parts[i] === "") continue; if (cur === null || cur === undefined) return undefined; cur = cur[parts[i]]; }
    return cur;
  }

  function gradeStep(step, r) {
    // pocket-ap: body verbatim on stdout, diagnostics on stderr, non-zero exit on failure; upstream 4xx/5xx reported in diagnostics.
    var body = String(r.body || ""), first = trim(body).charAt(0), out = { ok: false, note: "" };
    var status = r.http || 0;
    if (r.exit_code !== 0 && !status) { out.note = "relay failed: " + trim(String(r.diagnostics || "")).split("\n").pop(); return out; }
    if (first !== "{" && first !== "[") { out.note = "response is not a JSON object (starts with '" + esc(first) + "'); gateways penalize this"; return out; }
    var json = null; try { json = JSON.parse(body); } catch (e) { out.note = "response is not valid JSON"; return out; }
    if (step.badInput) {
      if (status >= 400 && status < 500 && json && json.error) { out.ok = true; out.note = "HTTP " + status + " with a JSON error object, as required"; }
      else out.note = "expected a 4xx JSON error, got HTTP " + (status || 200);
      return out;
    }
    if (status && status !== 200) { out.note = "HTTP " + status; return out; }
    if (step.jsonPath) {
      var v = jsonPathGet(json, step.jsonPath), sv = v === undefined ? "" : (typeof v === "object" ? JSON.stringify(v) : String(v));
      var re; try { re = new RegExp(step.matches || ""); } catch (e2) { re = null; }
      if (v === undefined) { out.note = step.jsonPath + " is missing from the response"; return out; }
      if (re && !re.test(sv)) { out.note = step.jsonPath + " = " + esc(sv.substring(0, 60)) + " does not match " + esc(step.matches); return out; }
      out.ok = true; out.note = step.jsonPath + " = " + esc(sv.substring(0, 60));
      return out;
    }
    out.ok = true; out.note = "JSON object returned"; return out;
  }

  function runTest() {
    if (state.busy) return;
    var id = $("tstId").value, wallet = $("tstWallet").value;
    if (!id) { status("tstStatus", "Choose a service.", "err"); return; }
    if (!wallet) { status("tstStatus", "Choose an application wallet.", "err"); return; }
    if (!dockerReady()) { status("tstStatus", "Docker Desktop must be running with the pocketd image downloaded.", "err"); return; }
    if (!state.docker.pocketap) { status("tstStatus", "Download the pocket-ap image first (button above).", "err"); return; }
    var probes = testProbes(id), steps = probes.steps, results = [], i = 0;
    state.busy = true; $("btnTest").disabled = true;
    $("tstLogPanel").className = "panel hidden";
    $("tstLog").className = "log"; $("tstLog").innerHTML = ""; $("tstChecks").innerHTML = ""; status("tstStatus", "Running " + steps.length + " probes", "busy");
    logTo("tstLog", "Testing <b>" + esc(id) + "</b> on " + esc(NET[state.net].label) + " as <b>" + esc(wallet) + "</b>. Each relay looks up the current session, picks a supplier, signs the request, and verifies the supplier's signature on the answer.");
    var t0 = now();
    function finish() {
      var passed = 0; for (var k = 0; k < results.length; k++) if (results[k].ok) passed++;
      var entry = { time: new Date().toISOString(), network: state.net, service: id, wallet: wallet, passed: passed, total: results.length, ms: now() - t0, steps: results };
      try { var f = fso.OpenTextFile(testLogPath(), 8, true); f.WriteLine(JSON.stringify(entry)); f.Close(); } catch (e) { logTo("tstLog", "Could not write the log file: " + esc(e.message), "err"); }
      logTo("tstLog", passed + " of " + results.length + " probes passed in " + fmtDuration((now() - t0) / 1000) + ". Logged.", passed === results.length ? "ok" : "err");
      status("tstStatus", passed === results.length ? "All probes passed. The service answers through the protocol." : (passed + " of " + results.length + " probes passed."), passed === results.length ? "ok" : "err");
      state.busy = false; $("btnTest").disabled = false; loadHistory();
    }
    function next() {
      if (i >= steps.length) { finish(); return; }
      var s = steps[i];
      logTo("tstLog", "Probe " + (i + 1) + " of " + steps.length + ": " + esc(s.label) + (s.body ? " with body " + esc(s.body.substring(0, 120)) : "") + (s.badInput ? " (expecting a 4xx JSON error)" : (s.jsonPath ? " (expecting " + esc(s.jsonPath) + " to match " + esc(s.matches) + ")" : "")));
      run("relay-call", { network: state.net, wallet: wallet, service_id: id, method: s.method, path: s.path, body: s.body }, function (r) {
        var res = { label: s.label, ok: false, ms: r.ms || 0, http: r.http || 0, note: "" };
        if (!r.ok && r.error) { res.note = r.error + (r.detail ? " " + r.detail : ""); }
        else {
          var diag = String(r.diagnostics || ""), sess = /session:\s*([0-9a-f]{8})/.exec(diag), att = /attempt \d+: (pokt1[0-9a-z]+) in (\d+ms) via (\S+) -> (\w+)/.exec(diag);
          if (att) logTo("tstLog", "Supplier " + esc(att[1].substring(0, 14)) + "&hellip; answered in " + esc(att[2]) + " via " + esc(att[3]) + " (" + esc(att[4]) + ")" + (sess ? ", session " + esc(sess[1]) + "&hellip;" : "") + ".");
          var g = gradeStep(s, r); res.ok = g.ok; res.note = g.note;
          var preview = trim(String(r.body || "")).replace(/\s+/g, " ").substring(0, 160);
          logTo("tstLog", (res.ok ? "Passed: " : "Failed: ") + res.note + (preview ? ' <span class="hint mono">' + esc(preview) + (preview.length >= 160 ? "&hellip;" : "") + "</span>" : ""), res.ok ? "ok" : "err");
        }
        if (!res.ok && !r.ok && r.error) logTo("tstLog", "Failed: " + esc(res.note), "err");
        results.push(res);
        var items = []; for (var k = 0; k < results.length; k++) items.push({ level: results[k].ok ? "ok" : "fail", text: esc(results[k].label) + (results[k].ms ? " (" + results[k].ms + " ms)" : ""), sub: results[k].note });
        checks("tstChecks", items);
        i++; next();
      }, { timeoutMs: 120000 });
    }
    next();
  }

  function viewTestLog() {
    var t = readUtf8(testLogPath()), lines = t ? t.split(/\r?\n/) : [], rows = [];
    for (var i = lines.length - 1; i >= 0; i--) { if (!trim(lines[i])) continue; try { rows.push(JSON.parse(lines[i])); } catch (e) {} }
    var h;
    if (!rows.length) h = '<div class="hint">No tests logged yet.</div>';
    else {
      h = '<table class="hist"><tr><th>Time (UTC)</th><th>Network</th><th>Service</th><th>Wallet</th><th>Result</th><th>Probes</th></tr>';
      for (var j = 0; j < rows.length; j++) {
        var e = rows[j], det = "";
        for (var k = 0; k < (e.steps || []).length; k++) det += '<div class="' + (e.steps[k].ok ? "ok" : "err") + '">' + (e.steps[k].ok ? "&#10003; " : "&#10007; ") + esc(e.steps[k].label) + (e.steps[k].ms ? " (" + e.steps[k].ms + " ms)" : "") + (e.steps[k].note ? ' <span class="hint">' + e.steps[k].note + "</span>" : "") + "</div>";
        h += "<tr><td>" + esc(String(e.time || "").substring(0, 19).replace("T", " ")) + "</td><td>" + esc(e.network) + "</td><td>" + esc(e.service) + "</td><td>" + esc(e.wallet) + "</td><td>" + (e.passed === e.total ? '<span class="badge ok">' : '<span class="badge bad">') + e.passed + "/" + e.total + "</span>" + (e.ms ? '<div class="hint">' + fmtDuration(e.ms / 1000) + "</div>" : "") + "</td><td>" + det + "</td></tr>";
      }
      h += "</table>";
    }
    $("tstLogTable").innerHTML = h; $("tstLogPanel").className = "panel";
  }
  function clearTestLog() {
    if (!confirm("Delete every logged test result on this machine?")) return;
    try { if (fso.FileExists(testLogPath())) fso.DeleteFile(testLogPath(), true); } catch (e) { alert("Could not delete the log: " + e.message); return; }
    $("tstLogTable").innerHTML = '<div class="hint">Log cleared.</div>'; $("tstLogPanel").className = "panel";
  }

  // ---------------------------------------------------------- tx utils ----

  function txLink(hash) { return '<a href="#" onclick="PSM.openUrl(\'' + NET[state.net].lcd + '/cosmos/tx/v1beta1/txs/' + hash + '\');return false;" class="mono">' + esc(hash) + "</a>"; }
  function openUrl(u) { sh.Run('"' + u + '"', 1, false); }
  function pollTx(hash, cb) {
    var t0 = now();
    function tick() {
      var r = lcd("/cosmos/tx/v1beta1/txs/" + hash);
      if (r.status === 200 && r.json && r.json.tx_response) {
        var tr = r.json.tx_response;
        if (Number(tr.code) === 0) cb({ ok: true, height: tr.height });
        else cb({ ok: false, error: "Failed in block " + tr.height + " with code " + tr.code + ": " + (tr.raw_log || "") });
        return;
      }
      if (now() - t0 > 180000) { cb({ ok: false, error: "Not seen in a block after 3 minutes. Check the Activity tab later; the tx hash is " + hash + "." }); return; }
      setTimeout(tick, 3000);
    }
    setTimeout(tick, 3000);
  }

  // -------------------------------------------------------- dashboard ----
  // Counts and stakes, the chain figures that gate when things take effect,
  // the health of every supplier on a configured server, and recent activity.

  function renderDashboard(refresh) {
    if (refresh) { refreshNetwork(); refreshBalance(); }
    $("dashNetBadge").innerHTML = NET[state.net].label; $("dashNetBadge").className = "badge " + (state.net === "main" ? "bad" : "info");
    var owned = ownedServices();
    var appStaked = 0, appCount = state.wallets.length;
    for (var w = 0; w < state.wallets.length; w++) { var a = appRecordOf(state.wallets[w].address); if (a) appStaked += Number(a.stake.amount); }
    var rows = supplierRows(), staked = 0, supStaked = 0, withOp = 0;
    for (var s = 0; s < rows.length; s++) { if (rows[s].state === "ready") withOp++; if (rows[s].rec) { staked++; supStaked += Number(rows[s].rec.stake.amount); } }
    var h = '<div class="stat" onclick="PSM.tab(\'services\')"><div class="n">' + (state.imported ? owned.length : "?") + '</div><div class="l">Services owned on ' + esc(NET[state.net].label) + '</div></div>';
    h += '<div class="stat" onclick="PSM.tab(\'supply\')"><div class="n">' + staked + '<small>of ' + withOp + ' server' + (withOp === 1 ? "" : "s") + '</small></div><div class="l">Suppliers staked</div>' + (supStaked ? '<div class="s">' + fmtPokt(supStaked) + " POKT staked</div>" : "") + '</div>';
    h += '<div class="stat" onclick="PSM.tab(\'wallets\')"><div class="n">' + appCount + '</div><div class="l">App wallets</div>' + (appStaked ? '<div class="s">' + fmtPokt(appStaked) + " POKT in application stakes</div>" : "") + '</div>';
    $("dashStats").innerHTML = h;
    renderChain();
    renderServicesDir();
    renderDashboardServices();
    if (!rows.length) {
      $("dashSuppliers").innerHTML = '<span class="hint">No server is configured. <a href="#" onclick="PSM.tab(\'settings\');return false;">Add one under Settings.</a></span>';
    } else {
      var t = '<table class="services"><tr><th>Server</th><th>Status</th><th>Services</th><th>Operator gas</th><th>URL</th></tr>';
      for (var i = 0; i < rows.length; i++) {
        var x = rows[i], srv = x.server, st = x.stack || {}, ids = supplierServiceIds(x.rec);
        t += '<tr class="link" onclick="PSM.' + (x.state === "ready" ? 'openSupplier' : 'tab') + '(\'' + (x.state === "ready" ? esc(srv.name) : 'supply') + '\')"><td class="svcid">' + esc(srv.name) + '<div class="hint mono">' + (st.operator ? shortAddr(st.operator) : "no " + esc(NET[state.net].label) + " stack") + '</div></td><td>' + supplierStatusCell(x) + '</td><td>' + (ids.length ? esc(ids.join(", ")) : '<span class="hint">none</span>') + '</td><td>' + (x.gas === null ? "?" : (x.gas < 2 * POKT ? '<span class="badge warn">' + fmtPokt(x.gas) + ' POKT</span>' : fmtPokt(x.gas) + " POKT")) + '</td><td>' + (st.url ? (x.answers ? '<span class="badge ok">answers</span>' : '<span class="badge bad">no answer</span>') : '<span class="hint">none</span>') + '</td></tr>';
      }
      $("dashSuppliers").innerHTML = t + "</table>";
    }
    loadHistory();
  }

  // --------------------------------------------------------- settings ----
  // The services folder and the server list live in settings.json (state dir).
  // A server entry is an SSH connection (host, port, user, key file, deploy root);
  // the server itself knows nothing about networks. Its supplier stacks are per
  // network under `suppliers`: { beta: {dir, project, url, operator, provisioned_at},
  // main: {...} }. Each stack is its own RelayMiner with its own operator key in its
  // own directory; the server's Caddy is shared. Entries written by earlier versions
  // carried one stack's fields at the top level and are migrated on first read.

  function servers() {
    if (state.serversOverride) return state.serversOverride;
    var s = loadSettings(), list = (s.servers && s.servers.length) ? s.servers : [], changed = false;
    for (var i = 0; i < list.length; i++) if (migrateServer(list[i])) changed = true;
    if (changed) saveSettings({ servers: list });
    return list;
  }
  function migrateServer(s) {
    if (s.suppliers) return false;
    s.suppliers = {};
    if (s.supplierDir || s.operator || s.url) {
      var net = s.network === "main" ? "main" : "beta";
      // The first layout ran one stack per server under the compose project "pocket-supplier"; keep that name so the running containers and volumes are reused.
      s.suppliers[net] = { dir: s.supplierDir || "", project: "pocket-supplier", url: s.url || "", operator: s.operator || "", provisioned_at: s.provisioned_at || "" };
    }
    delete s.supplierDir; delete s.operator; delete s.url; delete s.network; delete s.provisioned_at;
    return true;
  }
  function stackOf(s, net) { return (s && s.suppliers && s.suppliers[net || state.net]) || null; }
  // none: no stack for that network. pending: provisioning created the operator key
  // but did not finish (the stack is not started). ready: provisioning completed.
  function stackState(st) { if (!st || !(st.operator || st.dir)) return "none"; return st.provisioned_at ? "ready" : "pending"; }
  function stackDirDefault(net) { return "/opt/pocket/supplier-" + net; }
  function stackProjectDefault(net) { return "pocket-supplier-" + net; }
  function setStack(name, net, patch) {
    var list = servers().slice();
    for (var i = 0; i < list.length; i++) if (list[i].name === name) {
      if (!list[i].suppliers) list[i].suppliers = {};
      var st = list[i].suppliers[net] || {};
      for (var k in patch) if (patch.hasOwnProperty(k)) st[k] = patch[k];
      list[i].suppliers[net] = st;
    }
    if (state.serversOverride) { state.serversOverride = list; return; }
    saveSettings({ servers: list });
  }
  function serverByName(name) { var sv = servers(); for (var i = 0; i < sv.length; i++) if (sv[i].name === name) return sv[i]; return null; }
  function saveServicesRoot() {
    var p = trim($("setRoot").value);
    if (!p || !fso.FolderExists(p)) { status("setRootStatus", "That folder does not exist.", "err"); return; }
    state.servicesRoot = p; saveSettings({ servicesRoot: p }); loadServiceFolders();
    status("setRootStatus", "Using " + esc(p) + ".", "ok");
  }
  function resetServicesRoot() {
    state.servicesRoot = state.defaultServicesRoot; $("setRoot").value = state.servicesRoot; saveSettings({ servicesRoot: "" }); loadServiceFolders();
    status("setRootStatus", "Back to the repository's services folder.", "ok");
  }
  function serverForm() {
    return { name: trim($("srvName").value), host: trim($("srvHost").value), port: parseInt($("srvPort").value, 10) || 22, user: trim($("srvUser").value), keyPath: trim($("srvKey").value),
      deployRoot: trim($("srvRoot").value), suppliers: {} };
  }
  function validateServer(f) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(f.name)) return "Name: letters, digits, dot, hyphen, underscore; up to 40 characters.";
    if (!/^[A-Za-z0-9.-]+$/.test(f.host)) return "Host must be a hostname or IP address.";
    if (!(f.port >= 1 && f.port <= 65535)) return "Port must be 1 to 65535.";
    if (!/^[A-Za-z0-9._-]+$/.test(f.user)) return "User is required.";
    if (!f.keyPath || !fso.FileExists(f.keyPath)) return "SSH key file not found on this PC.";
    if (f.deployRoot && !/^\/[A-Za-z0-9._\/-]*$/.test(f.deployRoot)) return "Deploy root must be an absolute Linux path.";
    return "";
  }
  function saveServer() {
    var f = serverForm(), err = validateServer(f);
    if (err) { status("srvStatus", esc(err), "err"); return; }
    var list = servers().slice(), found = false;
    for (var i = 0; i < list.length; i++) if (list[i].name === f.name) { f.suppliers = list[i].suppliers || {}; list[i] = f; found = true; }
    if (!found) list.push(f);
    saveSettings({ servers: list });
    status("srvStatus", (found ? "Updated" : "Added") + " server " + esc(f.name) + ".", "ok");
    $("srvFormTitle").innerHTML = "Add new server";
    renderServers(); populateSupplyServers();
  }
  function editServer(name) {
    var s = serverByName(name); if (!s) return;
    $("srvName").value = s.name; $("srvHost").value = s.host; $("srvPort").value = s.port; $("srvUser").value = s.user; $("srvKey").value = s.keyPath;
    $("srvRoot").value = s.deployRoot || "";
    $("srvFormTitle").innerHTML = "Edit server " + esc(name);
    status("srvStatus", "Editing " + esc(name) + ". Save to apply.", "");
  }
  function removeServer(name) {
    if (!confirm("Remove server '" + name + "' from this app? Nothing on the server changes.")) return;
    var list = []; var sv = servers(); for (var i = 0; i < sv.length; i++) if (sv[i].name !== name) list.push(sv[i]);
    var patch = { servers: list }; if (loadSettings().supplierServer === name) patch.supplierServer = "";
    saveSettings(patch); renderServers(); populateSupplyServers();
    status("srvStatus", "Removed " + esc(name) + ".", "ok");
  }
  function clearServerForm() {
    $("srvName").value = ""; $("srvHost").value = ""; $("srvPort").value = "22"; $("srvUser").value = ""; $("srvKey").value = ""; $("srvRoot").value = "/opt/pocket/services";
    $("srvFormTitle").innerHTML = "Add new server";
    status("srvStatus", "", "");
  }
  function testServer() {
    var f = serverForm(), err = validateServer(f);
    if (err) { status("srvStatus", esc(err), "err"); return; }
    var stDir = (stackOf(serverByName(f.name), state.net) || {}).dir || "";
    status("srvStatus", "Connecting to " + esc(f.user + "@" + f.host) + " on port " + f.port, "busy");
    run("ssh-test", { host: f.host, port: f.port, user: f.user, key_path: f.keyPath, path: stDir }, function (r) {
      if (!r.ok) { status("srvStatus", esc(r.error) + " " + esc(r.detail || ""), "err"); return; }
      status("srvStatus", "Connected: " + esc(r.hostname) + ", " + esc(r.docker || "docker not found") + (stDir ? (r.keyring ? ", " + NET[state.net].label + " operator keyring found" : ", no pocket-home in " + esc(stDir)) : "") + ".", r.docker && (!stDir || r.keyring) ? "ok" : "err");
    }, { timeoutMs: 60000 });
  }
  function renderServers() {
    var sv = servers(), box = $("srvList");
    if (!sv.length) { box.innerHTML = '<div class="hint">No servers yet. Fill in the form below, then provision the server for a network.</div>'; populateProvServers(); return; }
    var h = '<table class="services"><tr><th>Name</th><th>Connection</th><th>Deploy root</th><th>Beta TestNet</th><th>MainNet</th><th>Actions</th></tr>';
    for (var j = 0; j < sv.length; j++) {
      var s = sv[j];
      h += '<tr><td class="svcid">' + esc(s.name) + '</td><td class="mono">' + esc(s.user + "@" + s.host + ":" + s.port) + '</td><td class="mono">' + esc(s.deployRoot || "/opt/pocket/services") + '</td><td>' + stackCell(s, "beta") + '</td><td>' + stackCell(s, "main") + '</td>' +
        '<td class="actions"><button class="btn small" onclick="PSM.editServer(\'' + esc(s.name) + '\')">Edit</button><button class="btn small danger" onclick="PSM.removeServer(\'' + esc(s.name) + '\')">Remove</button></td></tr>';
    }
    box.innerHTML = h + "</table>";
    populateProvServers(); if (!$("provDir").value) { $("provNet").value = state.net; onProvNetChange(); }
  }
  // One network's stack on a server, for the server table: operator, hostname, directory, and the Provision button.
  function stackCell(s, net) {
    var st = stackOf(s, net), ss = stackState(st);
    if (ss === "none") return '<span class="badge muted">not provisioned</span>';
    return (ss === "ready" ? '<span class="badge ok">provisioned</span>' : '<span class="badge warn">provisioning pending</span>') + '<div class="mono" style="margin-top:4px" title="' + esc(st.operator || "") + '">' + (st.operator ? shortAddr(st.operator) : "") + '</div><div class="hint">' + esc(hostOfUrl(st.url)) + '</div><div class="hint mono">' + esc(st.dir || "") + '</div>' + (st.provisioned_at ? '<div class="hint">' + esc(String(st.provisioned_at).substring(0, 10)) + '</div>' : "");
  }
  // The standing Provision panel under the server list: pick a server, then a network.
  function populateProvServers() {
    var sel = $("provServer"), sv = servers(), cur = state.provServer || sel.value;
    sel.innerHTML = "";
    if (!sv.length) { sel.innerHTML = '<option value="">No servers</option>'; $("provServerHint").innerHTML = "Add a server above first."; state.provServer = ""; return; }
    for (var i = 0; i < sv.length; i++) { var o = document.createElement("option"); o.value = sv[i].name; o.text = sv[i].name; sel.appendChild(o); }
    sel.value = cur; if (!sel.value) sel.selectedIndex = 0;
    state.provServer = sel.value;
    var s = serverByName(state.provServer);
    $("provServerHint").innerHTML = s ? esc(s.user + "@" + s.host + ":" + s.port) : "";
  }
  function onProvServerChange() { state.provServer = $("provServer").value; populateProvServers(); onProvNetChange(); }

  // ---------------------------------------------------------- history ----

  function loadHistory() {
    run("history", {}, function (r) {
      var rows = (r.ok && r.entries) ? r.entries.slice().reverse() : [];
      var h = "<tr><th>Time (UTC)</th><th>Network</th><th>Action</th><th>Service</th><th>Result</th><th>Tx</th></tr>";
      if (!rows.length) h += '<tr><td colspan="6" class="hint">Nothing yet.</td></tr>';
      for (var i = 0; i < rows.length; i++) {
        var e = rows[i];
        var res = e.txhash ? (Number(e.code) === 0 ? '<span class="badge ok">accepted</span>' : '<span class="badge bad">rejected ' + esc(e.code) + "</span>") : "";
        var link = e.txhash ? '<a href="#" onclick="PSM.openUrl(\'' + NET[e.network || state.net].lcd + '/cosmos/tx/v1beta1/txs/' + esc(e.txhash) + '\');return false;" class="mono">' + esc(String(e.txhash).substring(0, 12)) + "&hellip;</a>" : "";
        h += "<tr><td>" + esc((e.time || "").substring(0, 19).replace("T", " ")) + "</td><td>" + esc(e.network || "") + "</td><td>" + esc(e.op) + "</td><td>" + esc(e.service_id || e.address || "") + "</td><td>" + res + "</td><td>" + link + "</td></tr>";
      }
      $("histTable").innerHTML = h;
    });
  }

  // ----------------------------------------------------------- create ----
  // Builds services/<id>/card.json and service.json from the Create tab.
  // The card follows the Skill's templates/card.json and card-authoring.md.

  var crAuto = { apis: true, hint: true, impl: true, idMatch: true };
  function markManual(k) { crAuto[k] = false; }

  function onCreateIdChange() {
    var id = trim($("crId").value), rpc = $("crRpc").value;
    var ok = /^[A-Za-z0-9_-]{1,42}$/.test(id);
    $("crIdHint").innerHTML = !id ? "Permanent once registered. Also becomes the folder name. Lowercase letters, digits, hyphen, underscore." :
      ok ? (id !== id.toLowerCase() ? '<span style="color:#8a5a00">Allowed, but lowercase is the convention.</span>' : "Folder will be services" + SEP + esc(id)) :
      '<span style="color:#b71c1c">Only letters, digits, hyphen, underscore; 1 to 42 characters.</span>';
    if (!ok) return;
    if (crAuto.apis) $("crApis").value = id + "-api";
    if (crAuto.hint) $("crHint").value = id + (rpc === "REST" ? " HTTP server on :8080; mount at /" : " " + rpc + " server on :8080");
    if (crAuto.impl) $("crImpl").value = id + " >= 1.0";
    if (crAuto.idMatch) $("crIdMatch").value = "^" + id + "$";
  }

  function splitList(s) {
    var out = [], parts = String(s || "").split(",");
    for (var i = 0; i < parts.length; i++) { var t = trim(parts[i]); if (t) out.push(t); }
    return out;
  }
  function isUrl(s) { return /^https?:\/\/\S+$/.test(s); }

  function createForm() {
    return {
      id: trim($("crId").value), name: trim($("crName").value), cupr: parseInt($("crCupr").value, 10), desc: trim($("crDesc").value),
      rpc: $("crRpc").value, hint: trim($("crHint").value), endpoints: trim($("crEndpoints").value), apis: splitList($("crApis").value),
      access: $("crAccess").value, results: $("crResults").value, specUrl: trim($("crSpecUrl").value), specKind: $("crSpecKind").value, docs: trim($("crDocs").value),
      backend: trim($("crBackend").value), impl: splitList($("crImpl").value), disk: parseInt($("crDisk").value, 10), ram: parseInt($("crRam").value, 10),
      opDocs: trim($("crOpDocs").value), servingNotes: trim($("crServingNotes").value),
      idPath: trim($("crIdPath").value), idJson: trim($("crIdJson").value), idMatch: trim($("crIdMatch").value),
      rdPath: trim($("crRdPath").value), rdJson: trim($("crRdJson").value), rdMatch: trim($("crRdMatch").value),
      fnPath: trim($("crFnPath").value), fnMethod: $("crFnMethod").value, fnJson: trim($("crFnJson").value), fnMatch: trim($("crFnMatch").value), fnBody: trim($("crFnBody").value)
    };
  }

  function validateCreate(f, items) {
    if (!/^[A-Za-z0-9_-]{1,42}$/.test(f.id)) items.push({ level: "fail", text: "Service ID is invalid." });
    if (!/^[A-Za-z0-9 _-]{1,169}$/.test(f.name)) items.push({ level: "fail", text: "Display name is invalid or empty." });
    if (!(f.cupr >= 1 && f.cupr <= 1048576)) items.push({ level: "fail", text: "Compute units per relay must be 1 to 1,048,576." });
    if (!f.desc) items.push({ level: "fail", text: "Description is empty. It is the only thing a consumer reads before calling you." });
    if (f.desc.length > 2048) items.push({ level: "fail", text: "Description is longer than 2,048 characters." });
    if (f.hint.length > 256) items.push({ level: "fail", text: "Backend hint is longer than 256 characters." });
    if (f.endpoints.length > 512) items.push({ level: "fail", text: "Endpoints line is longer than 512 characters." });
    if (!f.endpoints) items.push({ level: "warn", text: "No endpoints line. Consumers will not know which paths are guaranteed." });
    if (!f.apis.length) items.push({ level: "fail", text: "At least one API contract name is needed." });
    for (var i = 0; i < f.apis.length; i++) if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(f.apis[i]) || f.apis[i].length > 128) items.push({ level: "fail", text: "API contract name '" + esc(f.apis[i]) + "' is not lowercase kebab-case." });
    if (f.specUrl && !isUrl(f.specUrl)) items.push({ level: "fail", text: "API spec URL must start with http:// or https://." });
    if (!f.specUrl) items.push({ level: "warn", text: "No API spec URL. Add one when the OpenAPI document is published; the card can be updated." });
    if (f.docs && !isUrl(f.docs)) items.push({ level: "fail", text: "Docs URL must start with http:// or https://." });
    if (f.opDocs && !isUrl(f.opDocs)) items.push({ level: "fail", text: "Operator docs URL must start with http:// or https://." });
    if (!f.backend) items.push({ level: "warn", text: "No backend description. Suppliers will not know what to deploy." });
    if (f.backend.length > 1024) items.push({ level: "fail", text: "Backend description is longer than 1,024 characters." });
    if (f.servingNotes.length > 2048) items.push({ level: "fail", text: "Operator notes are longer than 2,048 characters." });
    if (!(f.disk >= 0) || !(f.ram >= 0)) items.push({ level: "fail", text: "Disk and RAM must be whole numbers of gigabytes." });
    var probes = [["Identity", f.idPath, f.idJson, f.idMatch], ["Readiness", f.rdPath, f.rdJson, f.rdMatch]];
    for (var p = 0; p < probes.length; p++) {
      var pr = probes[p];
      if (!pr[1]) items.push({ level: "warn", text: pr[0] + " probe has no path, so it is omitted." });
      else { if (pr[1].charAt(0) !== "/") items.push({ level: "fail", text: pr[0] + " probe path must start with /." }); if (!pr[2] || pr[2].charAt(0) !== "$") items.push({ level: "fail", text: pr[0] + " probe JSON path must start with $." }); if (!pr[3]) items.push({ level: "fail", text: pr[0] + " probe needs a regular expression to match." }); }
    }
    if (f.fnPath) {
      if (f.fnPath.charAt(0) !== "/") items.push({ level: "fail", text: "Functional probe path must start with /." });
      if (!f.fnJson || f.fnJson.charAt(0) !== "$") items.push({ level: "fail", text: "Functional probe JSON path must start with $." });
      if (!f.fnMatch) items.push({ level: "fail", text: "Functional probe needs a regular expression to match." });
      if (f.fnMethod === "POST" && f.fnBody) { try { JSON.parse(f.fnBody); } catch (e) { items.push({ level: "fail", text: "Functional probe body is not valid JSON.", sub: esc(e.message) }); } }
    } else items.push({ level: "info", text: "No functional probe. Gateways will only check identity and readiness. Add one once the API is final." });
    return !hasFail(items);
  }

  function probe(rpc, path, method, body, jsonPath, matches, notes) {
    var req = { path: path, method: method };
    if (body) req.body = body;
    return { rpc_type: rpc, request: req, expect: { json_path: jsonPath, matches: matches }, notes: notes };
  }

  function buildCard(f) {
    var d = new Date();
    var card = { schema: "pocket-service-card/v1", description: f.desc };
    var rt = { type: f.rpc, intent: "expected" };
    if (f.hint) rt.backend_hint = f.hint;
    if (f.endpoints) rt.notes = f.endpoints;
    card.rpc_types = [rt];
    card.apis = f.apis;
    if (f.specUrl) card.specs = [{ kind: f.specKind, api: f.apis[0], url: f.specUrl }];
    card.access = f.access;
    card.results = f.results;
    var sv = {};
    if (f.backend) sv.backend = f.backend;
    if (f.impl.length) sv.implementations = f.impl;
    if (f.opDocs) sv.docs = f.opDocs;
    sv.min_disk_gb = f.disk; sv.min_ram_gb = f.ram;
    var hc = [];
    if (f.idPath) hc.push(probe(f.rpc, f.idPath, "GET", null, f.idJson, f.idMatch, "Identity probe: pins the backend to this service so a wrong backend cannot be staked under this id."));
    if (f.rdPath) hc.push(probe(f.rpc, f.rdPath, "GET", null, f.rdJson, f.rdMatch, "Readiness probe."));
    if (f.fnPath) hc.push(probe(f.rpc, f.fnPath, f.fnMethod, (f.fnMethod === "POST" && f.fnBody) ? JSON.parse(f.fnBody) : null, f.fnJson, f.fnMatch, "Functional probe with a deterministic expected value."));
    if (hc.length) sv.healthcheck = hc;
    var gw = "Gateway operators: configure as type passthrough with rpc_types [\"" + f.rpc.toLowerCase() + "\"].";
    sv.notes = f.servingNotes ? f.servingNotes + " " + gw : gw;
    card.serving = sv;
    if (f.docs) card.docs = f.docs;
    card.updated = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
    return card;
  }

  function previewCard() {
    var f = createForm(), items = [];
    var ok = validateCreate(f, items);
    checks("crChecks", items);
    if (!ok) { $("crPreview").className = "plan hidden"; status("crStatus", "Fix the red items first.", "err"); return; }
    var json = JSON.stringify(buildCard(f), null, 2);
    $("crPreviewJson").innerHTML = esc(json); $("crPreview").className = "plan";
    status("crStatus", "Card is " + fmtInt(json.length) + " bytes" + (json.length > 4096 ? " (over the 4 KiB target; trim the text fields)" : " (under the 4 KiB target)") + ".", json.length > 4096 ? "err" : "ok");
  }

  function createService() {
    var f = createForm(), items = [];
    var ok = validateCreate(f, items);
    checks("crChecks", items);
    if (!ok) { status("crStatus", "Fix the red items first.", "err"); return; }
    ensureDir(state.servicesRoot);
    var folder = join(state.servicesRoot, f.id), cardPath = join(folder, "card.json"), manPath = join(folder, "service.json");
    if (fso.FileExists(cardPath) && !confirm("services\\" + f.id + "\\card.json already exists. Overwrite it with this form?")) { status("crStatus", "Left the existing card alone.", ""); return; }
    ensureDir(folder);
    var card = buildCard(f), json = JSON.stringify(card, null, 2);
    writeUtf8(cardPath, json + "\n");
    var m = {}; try { var t = readUtf8(manPath); if (t) m = JSON.parse(t); } catch (e) { m = {}; }
    m.service_id = f.id; m.name = f.name; m.compute_units_per_relay = f.cupr; m.card = "card.json"; m.networks = m.networks || {};
    writeUtf8(manPath, JSON.stringify(m, null, 2) + "\n");
    items.push({ level: "ok", text: "Wrote " + esc(cardPath) + " (" + fmtInt(json.length) + " bytes) and service.json." });
    checks("crChecks", items);
    $("crPreviewJson").innerHTML = esc(json); $("crPreview").className = "plan";
    status("crStatus", "Validating the card with the Skill's validate_card.py", "busy");
    run("validate-card", { card_path: cardPath, script: join(state.skillScripts, "validate_card.py") }, function (r) {
      if (r.skipped) items.push({ level: "info", text: "Schema validation skipped.", sub: esc(r.reason) });
      else items.push({ level: r.ok ? "ok" : "fail", text: r.ok ? "validate_card.py passed." : "validate_card.py reported problems; edit and create again.", sub: "<pre>" + esc(r.output) + "</pre>" });
      checks("crChecks", items);
      loadServiceFolders();
      $("svcFolder").value = f.id; onServiceFolder();
      status("crStatus", r.ok || r.skipped ? "Service folder created. The Register tab is ready with it selected." : "Folder created, but fix the card before registering.", r.ok || r.skipped ? "ok" : "err");
    });
  }

  function loadCreateFromFolder() {
    var folder = $("crFolder").value; if (!folder) return;
    var cardPath = join(state.servicesRoot, folder, "card.json"), manPath = join(state.servicesRoot, folder, "service.json");
    var c = null, m = null;
    try { var t = readUtf8(cardPath); if (t) c = JSON.parse(t); } catch (e) { status("crStatus", "card.json in " + esc(folder) + " is not valid JSON: " + esc(e.message), "err"); }
    try { var t2 = readUtf8(manPath); if (t2) m = JSON.parse(t2); } catch (e2) { m = null; }
    m = m || {}; c = c || {};
    crAuto = { apis: false, hint: false, impl: false, idMatch: false };
    $("crId").value = m.service_id || folder; $("crName").value = m.name || ""; $("crCupr").value = m.compute_units_per_relay || 100;
    $("crDesc").value = c.description || "";
    var rt = (c.rpc_types && c.rpc_types[0]) || {};
    if (rt.type) $("crRpc").value = rt.type;
    $("crHint").value = rt.backend_hint || ""; $("crEndpoints").value = rt.notes || "";
    $("crApis").value = (c.apis || []).join(", ");
    if (c.access) $("crAccess").value = c.access; if (c.results) $("crResults").value = c.results;
    var sp = (c.specs && c.specs[0]) || {}; $("crSpecUrl").value = sp.url || ""; if (sp.kind) $("crSpecKind").value = sp.kind;
    $("crDocs").value = c.docs || "";
    var sv = c.serving || {};
    $("crBackend").value = sv.backend || ""; $("crImpl").value = (sv.implementations || []).join(", ");
    $("crDisk").value = sv.min_disk_gb !== undefined ? sv.min_disk_gb : 1; $("crRam").value = sv.min_ram_gb !== undefined ? sv.min_ram_gb : 1;
    $("crOpDocs").value = sv.docs || "";
    $("crServingNotes").value = String(sv.notes || "").replace(/\s*Gateway operators: configure as type passthrough.*$/, "");
    var hc = sv.healthcheck || [], idp = null, rdp = null, fnp = null;
    for (var i = 0; i < hc.length; i++) {
      var h = hc[i], n = String(h.notes || "").toLowerCase(), method = (h.request && h.request.method) || "GET";
      if (!idp && (n.indexOf("identity") >= 0)) idp = h;
      else if (!rdp && (n.indexOf("readiness") >= 0 || (h.expect && h.expect.matches === "^ok$"))) rdp = h;
      else if (!fnp) fnp = h;
    }
    $("crIdPath").value = idp && idp.request ? idp.request.path : ""; $("crIdJson").value = idp && idp.expect ? idp.expect.json_path : "$.service"; $("crIdMatch").value = idp && idp.expect ? idp.expect.matches : "";
    $("crRdPath").value = rdp && rdp.request ? rdp.request.path : ""; $("crRdJson").value = rdp && rdp.expect ? rdp.expect.json_path : "$.status"; $("crRdMatch").value = rdp && rdp.expect ? rdp.expect.matches : "^ok$";
    $("crFnPath").value = fnp && fnp.request ? fnp.request.path : ""; $("crFnMethod").value = fnp && fnp.request && fnp.request.method ? fnp.request.method : "POST";
    $("crFnJson").value = fnp && fnp.expect ? fnp.expect.json_path : ""; $("crFnMatch").value = fnp && fnp.expect ? fnp.expect.matches : "";
    $("crFnBody").value = fnp && fnp.request && fnp.request.body ? JSON.stringify(fnp.request.body) : "";
    onCreateIdChange();
    status("crStatus", "Loaded " + esc(folder) + ". Edit and press Create to rewrite its card.", "");
  }

  // ------------------------------------------------------------- tabs ----

  function tab(name) {
    var names = ["dashboard", "services", "create", "register", "stake", "deploy", "test", "supply", "wallets", "settings"];
    if (names.indexOf(name) < 0) name = "dashboard";
    for (var i = 0; i < names.length; i++) $("tab-" + names[i]).className = "tabpane" + (names[i] === name ? " on" : "");
    state.screen = name;
    var sec = sectionOf(name); if (sec.screens.length > 1) navOpen[sec.id] = true;
    renderNav();
    $("content").scrollTop = 0;
    if (name === "dashboard") renderDashboard();
    if (name === "services") renderServices();
    if (name === "wallets") renderWallets();
    if (name === "test") openTest();
    if (name === "deploy") openDeploy();
    if (name === "settings") { renderServers(); $("setRoot").value = state.servicesRoot; }
    if (name === "stake") { populateStakeSelect(); populateStakeFrom(); onStakeServiceChange(); renderDelegation(); }
    if (name === "supply") { $("supEditView").className = "hidden"; $("supListView").className = ""; renderSuppliers(); }
  }

  // ----------------------------------------------------- window shell ----
  // The HTA runs frameless (caption="no"), so the title bar is ours: drag to
  // move, double-click or the middle button to maximise, a corner grip to
  // resize. Minimise needs Win32, which minimize.ps1 does for us.

  var win = { dragging: false, resizing: false, dx: 0, dy: 0, w: 0, h: 0, maximized: false, restore: null };
  function dragStart(e) {
    e = e || window.event;
    if (e.button !== undefined && e.button !== 0 && e.button !== 1) return; // IE reports 1 for left in some modes
    if (win.maximized) return;
    win.dragging = true; win.dx = e.screenX - window.screenLeft; win.dy = e.screenY - window.screenTop;
    try { $("titlebar").setCapture(); } catch (ex) {}
    document.onmousemove = function (ev) { ev = ev || window.event; if (win.dragging) window.moveTo(ev.screenX - win.dx, ev.screenY - win.dy); };
    document.onmouseup = endWinOp;
  }
  function resizeStart(e) {
    e = e || window.event;
    if (win.maximized) return;
    win.resizing = true; win.dx = e.screenX; win.dy = e.screenY; win.w = window.outerWidth || document.documentElement.clientWidth; win.h = window.outerHeight || document.documentElement.clientHeight;
    try { $("grip").setCapture(); } catch (ex) {}
    document.onmousemove = function (ev) { ev = ev || window.event; if (win.resizing) window.resizeTo(Math.max(1000, win.w + ev.screenX - win.dx), Math.max(680, win.h + ev.screenY - win.dy)); };
    document.onmouseup = endWinOp;
  }
  function endWinOp() {
    win.dragging = false; win.resizing = false;
    try { document.releaseCapture(); } catch (ex) {}
    document.onmousemove = null; document.onmouseup = null;
  }
  function stopDrag(e) { e = e || window.event; if (e.stopPropagation) e.stopPropagation(); e.cancelBubble = true; }
  function toggleMaximize() {
    if (win.maximized) {
      var r = win.restore || { x: 60, y: 40, w: 1320, h: 900 };
      window.resizeTo(r.w, r.h); window.moveTo(r.x, r.y); win.maximized = false;
    } else {
      win.restore = { x: window.screenLeft, y: window.screenTop, w: window.outerWidth || 1320, h: window.outerHeight || 900 };
      // Fill the work area of the monitor the window is on (screen.availWidth only
      // describes the primary monitor, which is wrong on a multi-monitor desk).
      winshell("maximize"); win.maximized = true;
    }
    $("grip").className = win.maximized ? "hidden" : "";
  }
  function winshell(op) {
    sh.Run('powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + join(state.appDir, "winshell.ps1") + '" -Op ' + op + ' -Title "' + document.title + '"', 0, false);
  }
  function minimize() { winshell("minimize"); }
  // mshta ignores the hta:application caption/border attributes in IE11 document
  // mode, so the native frame is stripped with Win32 right after the window exists.
  function goFrameless() { winshell("frameless"); }

  // --------------------------------------------------------- selftest ----
  // Launched with "--selftest": exercises the read paths and writes a report
  // to %LOCALAPPDATA%\PocketServiceManager\selftest.txt, then closes.

  function selftest() {
    state.noSave = true;
    var out = [];
    function L(k, v) { out.push(k + "=" + v); }
    L("appDir", state.appDir); L("servicesRoot", state.servicesRoot); L("skillScripts", state.skillScripts);
    L("net", state.net);
    refreshNetwork();
    L("chainId", state.params.chainId); L("fee", state.params.addServiceFee); L("appMin", state.params.appMinStake); L("catalog", state.catalog ? state.catalog.length : "null");
    var ex = lcd("/pokt-network/poktroll/service/service/does-not-exist-psm"); L("missingServiceStatus", ex.status);
    run("docker-check", {}, function (r) {
      L("docker", JSON.stringify(r));
      run("wallet-status", {}, function (w) {
        L("wallet", JSON.stringify(w));
        run("wallet-list", {}, function (wl) {
        L("walletList", JSON.stringify(wl).substring(0, 600));
        state.wallets = (wl.ok && wl.wallets) ? wl.wallets : [];
        run("history", {}, function (hh) {
          L("historyOk", hh.ok + " entries=" + (hh.entries ? hh.entries.length : "?"));
          run("nope", {}, function (bad) {
            L("unknownOp", JSON.stringify(bad));
            // Drive the register and stake preflights with test values. Both are expected
            // to stop at the red items (no wallet in the test context); the point is that
            // the code paths run without script errors and render their checklists.
            state.docker = r; state.imported = !!w.imported; state.address = w.address || "";
            if (!state.imported) {
              // Pretend a wallet exists so the checks past the wallet gate run. This is a
              // real Beta TestNet application address read from the catalog; nothing is signed.
              state.imported = true; state.address = "pokt1q5zs2pg9q5zs2pg9q5zs2pg9q5zs2pg97pl2aw"; refreshBalance();
            }
            $("svcId").value = "psm-selftest-x"; $("svcName").value = "PSM Selftest"; $("svcCupr").value = "7";
            $("svcCard").value = fso.GetAbsolutePathName(join(state.appDir, "..", "..", "skills", "pocket-service-builder", "templates", "card.json"));
            preflightRegister();
            var so = document.createElement("option"); so.value = "pnf-anvil"; so.text = "pnf-anvil"; $("stkId").appendChild(so);
            $("stkId").value = "pnf-anvil"; $("stkAmount").value = "1000";
            populateStakeFrom(); onStakeServiceChange();
            L("stkFromOptions", $("stkFrom").options.length + " value=" + $("stkFrom").value + " hint=" + $("stkFromHint").innerText.substring(0, 80));
            preflightStake();
            renderServices();
            L("svcListRows", ($("svcList").innerHTML.match(/<tr/gi) || []).length + " tr; empty=" + ($("svcList").innerHTML.indexOf("empty") >= 0));
            renderWallets();
            L("walListRows", ($("walList").innerHTML.match(/<tr/gi) || []).length + " tr");
            // Supplier preflight against the real Beta test service and the Cherry operator (dry run only; nothing is signed).
            state.serversOverride = [{ name: "selftest-server", host: "203.0.113.10", port: 22, user: "REPLACE-user", keyPath: join(sh.ExpandEnvironmentStrings("%USERPROFILE%"), ".ssh", "id_supplier"), deployRoot: "/opt/pocket/services", suppliers: { beta: { dir: "/opt/pocket/supplier", project: "pocket-supplier", operator: "pokt1qgpqyqszqgpqyqszqgpqyqszqgpqyqsz73c06j", url: "https://services-beta.agentdata.network" } } }];
            renderSuppliers();
            L("supList", $("supList").innerText.replace(/\s+/g, " ").substring(0, 200));
            openSupplier("selftest-server", "pretty-charts");
            L("supRows", JSON.stringify(state.sup.rows.map(function (x) { return x.id + ":" + (x.checked ? "on" : "off") + ":" + (x.staked ? "staked" : "new"); })) + " amount=" + $("supAmount").value + " add=" + $("supAdd").options.length);
            $("supAmount").value = "59500";
            preflightSupply();
            renderDashboard();
            L("dashStats", $("dashStats").innerText.replace(/\s+/g, " ").substring(0, 200));
            tab("test"); $("tstId").value = "pretty-charts"; onTestServiceChange();
            L("test", "wallet=" + $("tstWallet").value + " | " + $("tstIdHint").innerText + " | " + $("tstWalletHint").innerText.substring(0, 80) + " | probes=" + JSON.stringify(testProbes("pretty-charts").steps.map(function (s) { return s.method + " " + s.path; })));
            L("jsonPath", jsonPathGet({ a: { b: [{ c: 5 }] }, service: "x" }, "$.a.b[0].c") + " " + jsonPathGet({ service: "x" }, "$.service"));
            tab("deploy"); $("depId").value = "pretty-charts"; onDeployServiceChange();
            L("deploy", "service=" + $("depId").value + " server=" + $("depServer").value + " | " + $("depIdHint").innerText.substring(0, 100) + " | readiness=" + readinessPath("pretty-charts") + " | deployable=" + deployableServices().length);
            openProvision("selftest-server");
            L("provision", "net=" + $("provNet").value + " host=" + $("provHost").value + " panel=" + $("provPanel").className);
            closeProvision();
            L("dashSuppliers", $("dashSuppliers").innerText.replace(/\s+/g, " ").substring(0, 200));
            L("dashChain", $("dHeight").innerText + " | " + $("dBlockTime").innerText + " | " + $("dSession").innerText + " | " + $("dNext").innerText);
            renderServers(); L("srvList", $("srvList").innerText.replace(/\s+/g, " ").substring(0, 160));
            L("nav", $("nav").innerText.replace(/\s+/g, " "));
            L("supOpBal", $("supOpBal").innerText + " | " + $("supOpBalHint").innerText);
            toggleTheme(); L("themeAfterToggle", document.body.className + " title=" + $("themeBtn").title + " svg=" + ($("themeBtn").innerHTML.indexOf("svg") >= 0)); toggleTheme();
            // Create flow into a scratch services root so the real services/ folder stays clean.
            state.servicesRoot = join(state.stateDir, "selftest-services"); ensureDir(state.servicesRoot);
            $("crId").value = "psm-selftest"; onCreateIdChange();
            $("crName").value = "PSM Selftest"; $("crDesc").value = "Selftest service. POST JSON to /v1/echo, returns a JSON object.";
            $("crEndpoints").value = "Only POST /v1/echo, GET /v1/version and GET /healthz are expected.";
            $("crBackend").value = "The psm-selftest container behind a RelayMiner."; $("crSpecUrl").value = "https://example.com/openapi.json";
            $("crFnPath").value = "/v1/echo"; $("crFnJson").value = "$.ok"; $("crFnMatch").value = "^true$"; $("crFnBody").value = '{"ping": 1}';
            previewCard();
            L("crPreviewStatus", $("crStatus").innerText);
            createService();
            setTimeout(function () {
              L("crChecks", $("crChecks").innerText.replace(/\s+/g, " "));
              L("crStatus", $("crStatus").innerText);
              L("crCardExists", fso.FileExists(join(state.servicesRoot, "psm-selftest", "card.json")));
              L("crManifest", readUtf8(join(state.servicesRoot, "psm-selftest", "service.json")).replace(/\s+/g, " "));
              L("svcFolderAfterCreate", $("svcFolder").value + " card=" + $("svcCard").value);
              $("crFolder").value = "psm-selftest"; loadCreateFromFolder();
              L("reloadRoundtrip", $("crDesc").value === "Selftest service. POST JSON to /v1/echo, returns a JSON object." && $("crFnBody").value === '{"ping":1}' && $("crIdMatch").value === "^psm-selftest$");
            }, 6000);
            setTimeout(function () {
              L("regChecks", $("regChecks").innerText.replace(/\s+/g, " "));
              L("regStatus", $("regStatus").innerText);
              L("stkChecks", $("stkChecks").innerText.replace(/\s+/g, " "));
              L("stkStatus", $("stkStatus").innerText);
              L("supChecks", $("supChecks").innerText.replace(/\s+/g, " "));
              L("supStatus", $("supStatus").innerText);
              L("supPlan", $("supPlanCmd").innerText.replace(/\s+/g, " ").substring(0, 500));
              L("cuprHint", $("cuprHint").innerText);
              // pollTx against the most recent real tx in history: the callback must fire exactly once.
              var last = null;
              for (var hi = 0; hi < (hh.entries || []).length; hi++) if (hh.entries[hi].txhash) last = hh.entries[hi];
              if (!last) { L("pollTxCalls", "no tx in history"); writeUtf8(join(state.stateDir, "selftest.txt"), out.join("\r\n")); window.close(); return; }
              var calls = 0; var saveNet = state.net; state.net = last.network || state.net;
              pollTx(last.txhash, function (t) { calls++; L("pollTxResult" + calls, JSON.stringify(t)); });
              // Then the real executeRegister flow with the signer stubbed to return that tx hash,
              // so the post-broadcast path (poll, verify, record, refresh) runs exactly as in use.
              var realRun = run, realConfirm = window.confirm;
              run = function (op, payload, cb2, opts) {
                if (op === "tx-add-service" && !payload.dry) { setTimeout(function () { cb2({ ok: true, txhash: last.txhash, gas: "1" }); }, 100); return; }
                realRun(op, payload, cb2, opts);
              };
              window.confirm = function () { return true; };
              $("svcId").value = last.service_id || "psm-selftest"; $("svcName").value = "X"; $("svcCupr").value = "1"; $("svcCard").value = "";
              state.regPlanOk = true; state.regForm = regForm(); state.regUpdate = true; state.busy = false;
              executeRegister();
              setTimeout(function () {
                window.confirm = realConfirm; run = realRun; state.net = saveNet;
                L("pollTxCalls", calls);
                var logText = $("regLog").innerText || "";
                L("includedLines", (logText.match(/Included in block/g) || []).length);
                L("regLogTail", logText.replace(/\s+/g, " ").substring(0, 600));
                writeUtf8(join(state.stateDir, "selftest.txt"), out.join("\r\n"));
                window.close();
              }, 15000);
            }, 9000);
          });
        });
        });
      });
    });
  }

  return {
    init: init, state: state, setNetwork: setNetwork, refreshNetwork: refreshNetwork, refreshBalance: refreshBalance,
    importDialog: importDialog, revokeDialog: revokeDialog, copy: copy, startDocker: startDocker, pullImage: pullImage, recheckDocker: recheckDocker,
    loadServiceFolders: loadServiceFolders, onServiceFolder: onServiceFolder, saveManifest: saveManifest, openServicesFolder: openServicesFolder, onCardBrowse: onCardBrowse,
    onIdChange: onIdChange, onCuprChange: onCuprChange, validateCardOnly: validateCardOnly,
    preflightRegister: preflightRegister, executeRegister: executeRegister, preflightStake: preflightStake, executeStake: executeStake,
    loadHistory: loadHistory, tab: tab, openUrl: openUrl,
    onCreateIdChange: onCreateIdChange, markManual: markManual, previewCard: previewCard, createService: createService, loadCreateFromFolder: loadCreateFromFolder,
    toggleTheme: toggleTheme, renderServices: renderServices, svcUpdate: svcUpdate, svcRegister: svcRegister, svcStake: svcStake, svcEdit: svcEdit,
    dragStart: dragStart, resizeStart: resizeStart, stopDrag: stopDrag, toggleMaximize: toggleMaximize, minimize: minimize,
    preflightSupply: preflightSupply, executeSupply: executeSupply, svcSupply: svcSupply, fundOperator: fundOperator, refreshOperatorBalance: refreshOperatorBalance,
    renderSuppliers: renderSuppliers, openSupplier: openSupplier, closeSupplier: closeSupplier, unstakeSupplierDialog: unstakeSupplierDialog, populateSupplyAdd: populateSupplyAdd, addSupplyService: addSupplyService, supRow: supRow,
    svcTest: svcTest, onTestServiceChange: onTestServiceChange, runTest: runTest, viewTestLog: viewTestLog, clearTestLog: clearTestLog, pullPocketAp: pullPocketAp,
    openProvision: openProvision, closeProvision: closeProvision, runProvision: runProvision, onProvNetChange: onProvNetChange, onProvServerChange: onProvServerChange, provisionOn: provisionOn, svcDeploy: svcDeploy, onDeployServiceChange: onDeployServiceChange, runDeploy: runDeploy, deployThenStake: deployThenStake, deployThenTest: deployThenTest,
    loadWallets: loadWallets, renderWallets: renderWallets, newWalletDialog: newWalletDialog, onNewWalletService: onNewWalletService, recoverWalletDialog: recoverWalletDialog, importAppWalletDialog: importAppWalletDialog,
    exportWalletDialog: exportWalletDialog, removeWalletDialog: removeWalletDialog, fundWalletDialog: fundWalletDialog, svcStakeAs: svcStakeAs,
    onStakeServiceChange: onStakeServiceChange, onStakeFromChange: onStakeFromChange, fundStakeWallet: fundStakeWallet, onDelegateFromChange: onDelegateFromChange, delegateGateway: delegateGateway, undelegateGateway: undelegateGateway,
    navToggle: navToggle, renderDashboard: renderDashboard, showWelcome: showWelcome, saveServicesRoot: saveServicesRoot, resetServicesRoot: resetServicesRoot,
    saveServer: saveServer, editServer: editServer, removeServer: removeServer, clearServerForm: clearServerForm, testServer: testServer, onSupplyServerChange: onSupplyServerChange
  };
})();
