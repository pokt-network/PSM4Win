<#
Pocket Service Manager signer.

The only code path that touches pocketd, the encrypted keyring, or the sealed
keyring passphrase. PocketServiceManager.hta calls it through runner.cmd with a
request JSON file and reads one JSON object back from stdout.

Security model (see README.md):
  * Every key lives in one pocketd "file" keyring on a Docker named volume: the
    owner wallet ($KeyName, imported once; owns services and funds the rest) and
    any number of application wallets created here (one per service, because an
    application stakes for exactly one service).
  * The keyring passphrase is random, generated here once, and sealed with Windows
    DPAPI to the current Windows user. For one command it is unsealed in memory and
    handed to pocketd inside the container through the container's environment
    (printf pipes it to pocketd's stdin). It is never written to a request, a log,
    a file, or the command line. Feeding docker's own stdin from PowerShell proved
    unreliable (lines arrive mangled), which is why the container pipes it itself.
  * Secrets enter and leave only through these operations: wallet-import and
    wallet-import-app (hex key via PSM_IMPORT_KEY), wallet-recover (phrase via
    PSM_IMPORT_MNEMONIC), wallet-create (returns the new phrase once), and
    wallet-export (returns a hex key on explicit request). Nothing here logs them.
  * Only the operations listed in the switch below exist. There is no generic
    "run this pocketd command" path. The only transfers are tx-fund-operator (to a
    supplier operator address the user names) and tx-fund-wallet (to one of the
    application wallets listed in wallets.json).
#>
param([Parameter(Mandatory = $true)][string]$Request)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

$Image      = 'ghcr.io/pokt-network/pocketd:latest'
$ApImage    = 'ghcr.io/pokt-network/pocket-ap:latest'   # relay client used by the in-app service test
$Volume     = 'pocket-service-manager-keyring'
$KeyName    = 'service-manager'
$HomeInBox  = '/home/pocket/.pocket'
$StateDir   = Join-Path $env:LOCALAPPDATA 'PocketServiceManager'
$PassFile   = Join-Path $StateDir 'keyring.pass.dpapi'
$WalletFile = Join-Path $StateDir 'wallet.json'
$WalletsFile = Join-Path $StateDir 'wallets.json'
$WorkRoot   = Join-Path $StateDir 'work'
$HistoryFile = Join-Path $StateDir 'history.jsonl'
$GasArgs    = @('--gas', 'auto', '--gas-prices', '1upokt', '--gas-adjustment', '1.5')
$Networks   = @('beta', 'main')
$DockerDesktop = 'C:\Program Files\Docker\Docker\Docker Desktop.exe'

# ---------------------------------------------------------------- output ----

function Emit($obj) {
    [Console]::Out.Write(($obj | ConvertTo-Json -Depth 10 -Compress))
    exit 0
}

function Fail([string]$msg, [string]$detail = '') {
    Emit @{ ok = $false; error = $msg; detail = $detail }
}

# --------------------------------------------------------- process helpers ----

function Quote-Arg([string]$a) {
    if ($a -eq '' -or $a -match '[\s"]') { return '"' + ($a -replace '(\\*)"', '$1$1\"') + '"' }
    return $a
}

# Single-quotes a value for the POSIX shell inside the container.
function Sh-Quote([string]$a) { return "'" + ($a -replace "'", "'\''") + "'" }

function Invoke-Native([string]$exe, [string[]]$argv, [string]$stdin = $null, [hashtable]$envExtra = $null) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $exe
    $psi.Arguments = (($argv | ForEach-Object { Quote-Arg $_ }) -join ' ')
    $psi.UseShellExecute = $false
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    if ($envExtra) { foreach ($k in $envExtra.Keys) { $psi.EnvironmentVariables[$k] = [string]$envExtra[$k] } }
    $p = [System.Diagnostics.Process]::Start($psi)
    $outTask = $p.StandardOutput.ReadToEndAsync()
    $errTask = $p.StandardError.ReadToEndAsync()
    if ($stdin) { $p.StandardInput.Write($stdin) }
    $p.StandardInput.Close()
    $p.WaitForExit()
    return @{ code = $p.ExitCode; out = $outTask.Result; err = $errTask.Result }
}

function Docker([string[]]$argv, [string]$stdin = $null, [hashtable]$envExtra = $null) {
    return Invoke-Native 'docker' $argv $stdin $envExtra
}

# Runs a shell command line inside the pocketd image with the keyring volume
# mounted. $stdinText, when given, travels in the container's environment
# (PSM_STDIN) and is piped into the command by printf, so pocketd's prompts read
# exactly the lines we intend. Extra env values ($envExtra) are passed the same way.
function Invoke-InBox([string]$shcmd, [string]$stdinText = $null, [string[]]$mounts = @(), [hashtable]$envExtra = $null, [switch]$Root) {
    $d = @('run', '--rm', '-v', "${Volume}:${HomeInBox}")
    if ($Root) { $d += @('--user', 'root') }
    foreach ($m in $mounts) { $d += @('-v', $m) }
    $env2 = @{}
    if ($envExtra) { foreach ($k in $envExtra.Keys) { $env2[$k] = $envExtra[$k] } }
    if ($stdinText) { $env2['PSM_STDIN'] = $stdinText; $shcmd = 'printf "%s" "$PSM_STDIN" | ' + $shcmd }
    foreach ($k in $env2.Keys) { $d += @('-e', $k) }
    $d += @('--entrypoint', 'sh', $Image, '-c', $shcmd)
    return Docker $d $null $env2
}

# Run one pocketd command. $pass, when given, is fed twice: a fresh keyring asks
# for the passphrase and a confirmation, an existing one reads only the first line.
# $prefixLines go before the passphrase (a "y" confirmation, a recovery phrase).
function Pocketd([string[]]$argv, [string]$pass = $null, [string[]]$mounts = @(), [hashtable]$envExtra = $null, [switch]$Root, [string]$prefixLines = '') {
    $shcmd = 'pocketd ' + (($argv | ForEach-Object { Sh-Quote $_ }) -join ' ')
    $stdin = $null
    if ($pass) { $stdin = "$prefixLines$pass`n$pass`n" }
    elseif ($prefixLines) { $stdin = $prefixLines }
    return Invoke-InBox $shcmd $stdin $mounts $envExtra -Root:$Root
}

function First-Line([string]$s) {
    if (-not $s) { return '' }
    return (($s.Trim() -split "`r?`n")[0])
}

# pocketd's stderr mixes the real message with Go stack frames and, for some
# subcommands, the full usage text. Keep only the lines a person can act on.
function Clean-Err([string]$err) {
    if (-not $err) { return '' }
    $keep = @()
    $inUsage = $false
    foreach ($raw in ($err -split "`r?`n")) {
        $l = $raw.TrimEnd()
        $t = $l.Trim()
        if ($t -eq '') { continue }
        if ($t -match '^(Usage:|Flags:|Global Flags:|Examples?:)') { $inUsage = $true; continue }
        if ($inUsage -and ($t -match '^(-{1,2}[A-Za-z]|pocketd |\$ )' -or $l -match '^\s{2,}')) { continue }
        $inUsage = $false
        if ($t -match '\.go:\d+$') { continue }
        if ($t -match '^(github\.com/|net/http|reflect\.|runtime\.|main\.|golang\.org|google\.golang\.org|created by )') { continue }
        $keep += $l
    }
    $s = ($keep -join "`n").Trim()
    if ($s.Length -gt 3000) { $s = $s.Substring($s.Length - 3000) }
    return $s
}

function Summarize-Err([string]$err) {
    $clean = Clean-Err $err
    if ($clean -match '(?s)(card does not match the service card schema:.*?)(\n\s*Re-run|$)') { return ($Matches[1].Trim()) }
    if ($clean -match 'code = NotFound.*?account (pokt1[0-9a-z]+) not found') { return "The account $($Matches[1]) does not exist on this network yet. It is created by its first deposit, so send it some POKT first." }
    if ($clean -match 'insufficient funds') { return 'The wallet does not hold enough POKT for this transaction plus gas.' }
    if ($clean -match 'account sequence mismatch') { return 'Another transaction from this wallet is still pending. Wait a block and try again.' }
    if ($clean -match 'out of gas') { return 'The transaction ran out of gas. Try again; the gas simulation was too low.' }
    if ($clean -match 'too many failed passphrase attempts') { return 'The keyring did not accept the sealed passphrase. If this persists, revoke and import the wallet again.' }
    if ($clean -match 'duplicated address created') { return 'A key with this address is already in the keyring under another name.' }
    if ($clean -match 'invalid mnemonic') { return 'That is not a valid recovery phrase. Check the words and their order.' }
    $lines = @(($clean -split "`n") | Where-Object { $_.Trim() -ne '' })
    if ($lines.Count -eq 0) { return 'pocketd failed without a message.' }
    $last = $lines[$lines.Count - 1].Trim()
    if ($last -match '^rpc error: code = \w+ desc = (.*)$') { $last = $Matches[1].Trim() }
    return $last
}

# Finds the first JSON object in pocketd's stdout or stderr (keys add prints on stdout).
function Parse-FirstJson($r) {
    foreach ($txt in @("$($r.out)", "$($r.err)")) {
        $i = $txt.IndexOf('{')
        if ($i -ge 0) { try { return ($txt.Substring($i) | ConvertFrom-Json) } catch {} }
    }
    return $null
}

# ------------------------------------------------------------ state files ----

function Ensure-Dirs {
    foreach ($d in @($StateDir, $WorkRoot)) { if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d | Out-Null } }
}

function New-WorkDir {
    Ensure-Dirs
    $w = Join-Path $WorkRoot ([guid]::NewGuid().ToString('n').Substring(0, 12))
    New-Item -ItemType Directory -Path $w | Out-Null
    return $w
}

function Read-Wallet {
    if (-not (Test-Path $WalletFile)) { return $null }
    return (Get-Content $WalletFile -Raw | ConvertFrom-Json)
}

# Application wallets created or imported here: name, address, service, when, how.
# Nothing secret; the keys themselves are only in the keyring.
function Read-Wallets {
    if (-not (Test-Path $WalletsFile)) { return @() }
    try {
        $j = Get-Content $WalletsFile -Raw | ConvertFrom-Json
        if ($j -and $j.wallets) { return @($j.wallets) }
    } catch {}
    return @()
}

function Save-Wallets($list) {
    Ensure-Dirs
    @{ wallets = @($list) } | ConvertTo-Json -Depth 5 | Set-Content -Path $WalletsFile -Encoding utf8
}

function Find-Wallet([string]$name) {
    foreach ($w in (Read-Wallets)) { if ("$($w.name)" -eq $name) { return $w } }
    return $null
}

function Validate-WalletName([string]$name) {
    if ($name -notmatch '^[a-z0-9][a-z0-9_-]{0,39}$') { Fail 'Wallet name must be 1 to 40 characters: lowercase letters, digits, hyphen, underscore.' }
    if ($name -eq $KeyName) { Fail "'$KeyName' is the owner wallet's name." }
}

function Add-History([hashtable]$entry) {
    Ensure-Dirs
    $entry['time'] = (Get-Date).ToUniversalTime().ToString('o')
    Add-Content -Path $HistoryFile -Value ($entry | ConvertTo-Json -Compress) -Encoding utf8
}

# ------------------------------------------------------------- passphrase ----

function New-Passphrase {
    $b = New-Object byte[] 32
    (New-Object System.Security.Cryptography.RNGCryptoServiceProvider).GetBytes($b)
    return [Convert]::ToBase64String($b)
}

function Seal-Passphrase([string]$plain) {
    Ensure-Dirs
    $sec = ConvertTo-SecureString $plain -AsPlainText -Force
    $sec | ConvertFrom-SecureString | Set-Content -Path $PassFile -Encoding ascii
}

function Unseal-Passphrase {
    if (-not (Test-Path $PassFile)) { return $null }
    $blob = (Get-Content $PassFile -Raw).Trim()
    $sec = $blob | ConvertTo-SecureString
    $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}

function Require-Passphrase {
    $pass = Unseal-Passphrase
    if (-not $pass) { Fail 'No sealed passphrase exists on this machine, so the keyring cannot be opened. Import the owner wallet first.' }
    return $pass
}

# ----------------------------------------------------------------- docker ----

function Docker-Check {
    try { $r = Docker @('version', '--format', '{{.Server.Version}}') }
    catch { return @{ ok = $false; running = $false; error = 'The docker command was not found. Install Docker Desktop.'; detail = $_.Exception.Message } }
    if ($r.code -ne 0) { return @{ ok = $false; running = $false; error = 'Docker Desktop is not running.'; detail = (First-Line $r.err) } }
    $img = Docker @('image', 'inspect', $Image, '--format', '{{.Id}}')
    $ap = Docker @('image', 'inspect', $ApImage, '--format', '{{.Id}}')
    $res = @{ ok = $true; running = $true; docker = $r.out.Trim(); image = ($img.code -eq 0); pocketap = ($ap.code -eq 0); pocketd = '' }
    if ($img.code -eq 0) {
        $v = Docker @('run', '--rm', $Image, 'version')
        if ($v.code -eq 0) { $res['pocketd'] = $v.out.Trim() }
    }
    return $res
}

function Require-Docker {
    $c = Docker-Check
    if (-not $c.ok) { Fail $c.error $c.detail }
    if (-not $c.image) { Fail 'The pocketd image is not downloaded yet. Use "Download pocketd" first.' }
}

function Ensure-Volume {
    $r = Docker @('volume', 'inspect', $Volume)
    if ($r.code -ne 0) {
        $c = Docker @('volume', 'create', $Volume)
        if ($c.code -ne 0) { throw "Could not create the keyring volume: $(First-Line $c.err)" }
    }
    $p = Invoke-InBox "chown pocket:pocket $HomeInBox" $null @() $null -Root
    if ($p.code -ne 0) { throw "Could not initialise the keyring volume: $(First-Line $p.err)" }
}

function Volume-Exists { return ((Docker @('volume', 'inspect', $Volume)).code -eq 0) }

# Names and addresses in the keyring, as pocketd reports them.
function Keyring-List([string]$pass) {
    $r = Pocketd @('keys', 'list', '--keyring-backend', 'file', '--output', 'json') $pass
    if ($r.code -ne 0) { return $null }
    $txt = "$($r.out)".Trim()
    if (-not $txt -or $txt -eq 'null') { return @() }
    try { return @($txt | ConvertFrom-Json) } catch { return $null }
}

function Keyring-Address([string]$name, [string]$pass) {
    $r = Pocketd @('keys', 'show', $name, '-a', '--keyring-backend', 'file') $pass
    if ($r.code -ne 0) { return $null }
    $a = "$($r.out)".Trim()
    if ($a -match '^pokt1[0-9a-z]{38}$') { return $a }
    return $null
}

# The address a hex private key derives to, computed in a throwaway keyring inside
# the container (the container's own /tmp, gone when it exits). The real keyring
# is not touched, so a key whose address is already present can be refused before
# import: pocketd accepts such a duplicate and the two names then share one
# address file, which breaks removal.
function Probe-HexAddress([string]$hex) {
    $cmd = 'pocketd keys import-hex probe "$PSM_IMPORT_KEY" --keyring-backend test --home /tmp/psm-probe >/dev/null 2>&1 && pocketd keys show probe -a --keyring-backend test --home /tmp/psm-probe'
    $r = Invoke-InBox $cmd $null @() @{ PSM_IMPORT_KEY = $hex }
    $a = "$($r.out)".Trim()
    if ($r.code -eq 0 -and $a -match '^pokt1[0-9a-z]{38}$') { return $a }
    return $null
}

# The managed wallet (parent included) that already holds an address, or $null.
function Wallet-Holding([string]$address) {
    $p = Read-Wallet
    if ($p -and "$($p.address)" -eq $address) { return $KeyName }
    foreach ($w in (Read-Wallets)) { if ("$($w.address)" -eq $address) { return "$($w.name)" } }
    return $null
}

# -------------------------------------------------------------- tx helpers ----

function Require-Network($n) {
    $n = "$n"
    if ($Networks -notcontains $n) { Fail "Unknown network '$n'. Use beta or main." }
    return $n
}

function Parse-TxOutput($r) {
    $json = $null
    $txt = "$($r.out)".Trim()
    if ($txt) {
        try { $json = $txt | ConvertFrom-Json } catch {
            $i = $txt.IndexOf('{')
            if ($i -ge 0) { try { $json = $txt.Substring($i) | ConvertFrom-Json } catch { $json = $null } }
        }
    }
    $gas = ''
    if ("$($r.err)" -match 'gas estimate:\s*(\d+)') { $gas = $Matches[1] }
    return @{ json = $json; gas = $gas }
}

function Emit-Tx($r, [string]$net, [string]$op, [string]$serviceId, [string]$extra = '') {
    $p = Parse-TxOutput $r
    if (-not $p.json -or -not $p.json.txhash) {
        Fail (Summarize-Err $r.err) ((Clean-Err $r.err) + "`n" + "$($r.out)".Trim()).Trim()
    }
    $code = [int]$p.json.code
    $entry = @{ network = $net; op = $op; service_id = $serviceId; txhash = $p.json.txhash; code = $code; extra = $extra }
    Add-History $entry
    Emit @{
        ok       = ($code -eq 0)
        txhash   = $p.json.txhash
        code     = $code
        raw_log  = "$($p.json.raw_log)"
        gas      = $p.gas
        error    = $(if ($code -ne 0) { "The node rejected the transaction (code $code)." } else { '' })
        detail   = $(if ($code -ne 0) { "$($p.json.raw_log)" } else { '' })
    }
}

function Validate-ServiceId([string]$id) {
    if ($id -notmatch '^[A-Za-z0-9_-]{1,42}$') { Fail 'Service ID must be 1 to 42 characters of letters, digits, hyphen, or underscore.' }
}

# An explicit SSH connection from a server entry (Settings): host, port, user, and
# a private key file on this PC. Nothing depends on ~/.ssh/config. Returns the
# argument lists for ssh and scp plus the user@host target.
function Resolve-Ssh($req) {
    $sshHost = "$($req.host)"; $user = "$($req.user)"; $key = "$($req.key_path)"
    $port = 22; if ("$($req.port)" -ne '') { $port = [int]$req.port }
    if ($sshHost -notmatch '^[A-Za-z0-9.-]+$') { Fail 'Server host must be a hostname or IP address.' }
    if ($user -notmatch '^[A-Za-z0-9._-]+$') { Fail 'Server user is required.' }
    if ($port -lt 1 -or $port -gt 65535) { Fail 'Server port must be 1 to 65535.' }
    if ($key -match '^~') { $key = Join-Path $env:USERPROFILE $key.Substring(1).TrimStart('\', '/') }
    if (-not $key -or -not (Test-Path $key)) { Fail 'The SSH key file for this server was not found on this PC.' $key }
    $common = @('-i', $key, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-o', 'StrictHostKeyChecking=accept-new')
    return @{ ssh = ($common + @('-p', "$port")); scp = ($common + @('-P', "$port")); target = "$user@$sshHost" }
}

# The key name a transaction signs with: the owner wallet by default, or one of
# the application wallets recorded in wallets.json. Never an arbitrary name.
function Resolve-Signer([string]$from) {
    if (-not $from -or $from -eq $KeyName) {
        if (-not (Read-Wallet)) { Fail 'No wallet is imported.' }
        return $KeyName
    }
    if (-not (Find-Wallet $from)) { Fail "'$from' is not a wallet this app manages." }
    return $from
}

# Records a new application wallet after pocketd confirmed it, and returns the entry.
function Register-Wallet([string]$name, [string]$address, [string]$serviceId, [string]$source) {
    $list = @(Read-Wallets | Where-Object { "$($_.name)" -ne $name })
    $entry = @{ name = $name; address = $address; service_id = $serviceId; created_at = (Get-Date).ToUniversalTime().ToString('o'); source = $source }
    $list += $entry
    Save-Wallets $list
    Add-History @{ op = "wallet-$source"; address = $address; service_id = $serviceId; extra = "name=$name" }
    return $entry
}

# ================================================================== main ====

try {
    if (-not (Test-Path $Request)) { Fail "Request file not found: $Request" }
    $req = Get-Content $Request -Raw | ConvertFrom-Json
    $op = "$($req.op)"

    switch ($op) {

        'docker-check' {
            Emit (Docker-Check)
        }

        'docker-start' {
            if (-not (Test-Path $DockerDesktop)) { Fail 'Docker Desktop is not installed at the expected location.' $DockerDesktop }
            Start-Process -FilePath $DockerDesktop | Out-Null
            Emit @{ ok = $true }
        }

        'image-pull' {
            $r = Docker @('pull', $Image)
            if ($r.code -ne 0) { Fail 'Could not download the pocketd image.' (First-Line $r.err) }
            $v = Docker @('run', '--rm', $Image, 'version')
            Emit @{ ok = $true; pocketd = $v.out.Trim() }
        }

        'pocketap-pull' {
            $r = Docker @('pull', $ApImage)
            if ($r.code -ne 0) { Fail 'Could not download the pocket-ap image.' (First-Line $r.err) }
            $v = Docker @('run', '--rm', $ApImage, 'version')
            Emit @{ ok = $true; version = (First-Line $v.out) }
        }

        'relay-call' {
            # One relay through the protocol, signed by an application wallet from the
            # keyring, sent with pocket-ap in a container. The key is exported in memory
            # and reaches the container only through its environment; it is never
            # written anywhere or returned. The response body comes back verbatim.
            Require-Docker
            $net = Require-Network $req.network
            $sid = "$($req.service_id)"; $method = "$($req.method)".ToUpper(); $path = "$($req.path)"; $body = "$($req.body)"
            Validate-ServiceId $sid
            if ($method -notin @('GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'PATCH')) { Fail "Unsupported HTTP method '$method'." }
            if ($path -notmatch '^/[^\s]*$') { Fail 'Path must start with /.' }
            $from = Resolve-Signer "$($req.wallet)"
            $ap = Docker @('image', 'inspect', $ApImage, '--format', '{{.Id}}')
            if ($ap.code -ne 0) { Fail 'The pocket-ap image is not downloaded yet. Use "Download pocket-ap" first.' }
            $pass = Require-Passphrase
            $x = Pocketd @('keys', 'export', $from, '--unarmored-hex', '--unsafe', '--keyring-backend', 'file') $pass -prefixLines "y`n"
            if ($x.code -ne 0) { Fail 'The wallet key could not be read from the keyring.' (Clean-Err $x.err) }
            $hex = "$($x.out)".Trim(); $x = $null
            if ($hex -notmatch '^[0-9a-fA-F]{64}$') { $hex = $null; Fail 'The keyring returned something that is not a key.' }
            $work = New-WorkDir
            $cfg = "network: $net`nlisteners:`n  - addr: 127.0.0.1:8550`n    service_id: $sid`n    rpc_type: rest`napps: []`n"
            [IO.File]::WriteAllText((Join-Path $work 'pocket-ap.yaml'), $cfg, (New-Object System.Text.UTF8Encoding($false)))
            $argv = @('run', '--rm', '-e', 'POCKET_APP_PRIVATE_KEY', '-v', "${work}:/work:ro", $ApImage, 'call', '--config', '/work/pocket-ap.yaml', '--service', $sid, '--rpc-type', 'rest', '-X', $method, '--path', $path, '-v', '--timeout', '30s')
            if ($body -ne '') {
                [IO.File]::WriteAllText((Join-Path $work 'body.json'), $body, (New-Object System.Text.UTF8Encoding($false)))
                $argv += @('--data', '@/work/body.json')
            }
            $sw = [Diagnostics.Stopwatch]::StartNew()
            $r = Docker $argv $null @{ POCKET_APP_PRIVATE_KEY = $hex }
            $hex = $null
            $sw.Stop()
            Remove-Item $work -Recurse -Force
            $out = "$($r.out)"; if ($out.Length -gt 200000) { $out = $out.Substring(0, 200000) }
            $errTxt = "$($r.err)"; if ($errTxt.Length -gt 20000) { $errTxt = $errTxt.Substring($errTxt.Length - 20000) }
            $status = 0
            if ($errTxt -match 'upstream returned HTTP (\d{3})') { $status = [int]$Matches[1] }
            elseif ($r.code -eq 0) { $status = 200 }
            Add-History @{ op = 'relay-test'; network = $net; service_id = $sid; extra = "wallet=$from $method $path code=$($r.code) http=$status ms=$($sw.ElapsedMilliseconds)" }
            Emit @{ ok = ($r.code -eq 0 -or $status -ge 400); exit_code = $r.code; http = $status; ms = $sw.ElapsedMilliseconds; body = $out; diagnostics = $errTxt; wallet = $from }
        }

        'wallet-status' {
            $w = Read-Wallet
            $hasPass = Test-Path $PassFile
            $vol = $false
            $dc = Docker-Check
            if ($dc.ok) { $vol = Volume-Exists }
            $apps = @(Read-Wallets)
            if (-not $dc.ok) {
                # Docker is down; report what the state files say without verifying.
                if ($w -and $hasPass) { Emit @{ ok = $true; imported = $true; verified = $false; address = "$($w.address)"; name = $KeyName; imported_at = "$($w.imported_at)"; app_wallets = $apps.Count } }
                Emit @{ ok = $true; imported = $false; verified = $false; app_wallets = $apps.Count }
            }
            if (-not ($w -and $hasPass -and $vol)) {
                Emit @{ ok = $true; imported = $false; verified = $true; partial = [bool]($w -or $hasPass -or $vol); app_wallets = $apps.Count }
            }
            $pass = Unseal-Passphrase
            $addr = Keyring-Address $KeyName $pass
            if (-not $addr) { Emit @{ ok = $true; imported = $false; verified = $true; partial = $true; app_wallets = $apps.Count; error = 'The parent key could not be read from the keyring.' } }
            Emit @{ ok = $true; imported = $true; verified = $true; address = $addr; name = $KeyName; imported_at = "$($w.imported_at)"; app_wallets = $apps.Count }
        }

        'wallet-import' {
            # The owner wallet. Creates the sealed passphrase and the keyring if needed.
            Require-Docker
            $hex = "$env:PSM_IMPORT_KEY".Trim()
            if (-not $hex) { Fail 'No private key was provided.' }
            if ($hex -match '^0[xX]') { $hex = $hex.Substring(2) }
            if ($hex -notmatch '^[0-9a-fA-F]{64}$') { Fail 'The private key must be 64 hexadecimal characters (32 bytes), optionally prefixed with 0x.' }
            if (Read-Wallet) { Fail 'A wallet is already imported. Revoke it before importing another.' }
            Ensure-Dirs
            $pass = Unseal-Passphrase
            if (-not $pass) {
                # No usable passphrase means any leftover keyring is unreadable; start clean.
                if (Volume-Exists) { Docker @('volume', 'rm', '-f', $Volume) | Out-Null }
                if (Test-Path $WalletsFile) { Remove-Item $WalletsFile -Force }
                $pass = New-Passphrase
                Seal-Passphrase $pass
            }
            Ensure-Volume
            if (Keyring-Address $KeyName $pass) { Pocketd @('keys', 'delete', $KeyName, '-y', '--keyring-backend', 'file') $pass | Out-Null }
            $r = Invoke-InBox ('pocketd keys import-hex ' + (Sh-Quote $KeyName) + ' "$PSM_IMPORT_KEY" --keyring-backend file') "$pass`n$pass`n" @() @{ PSM_IMPORT_KEY = $hex }
            $hex = $null
            if ($r.code -ne 0) { Fail 'pocketd could not import the key.' (Clean-Err $r.err) }
            $addr = Keyring-Address $KeyName $pass
            if (-not $addr) { Fail 'The key was imported but cannot be read back.' }
            @{ name = $KeyName; address = $addr; imported_at = (Get-Date).ToUniversalTime().ToString('o'); volume = $Volume } | ConvertTo-Json | Set-Content -Path $WalletFile -Encoding utf8
            Add-History @{ op = 'wallet-import'; address = $addr }
            Emit @{ ok = $true; address = $addr; name = $KeyName }
        }

        'wallet-export' {
            # Shows a private key on explicit request: the parent (revoke flow) or an
            # application wallet (to drive a client such as pocket-ap). The app asks
            # for typed confirmation before calling this.
            Require-Docker
            $name = $(if ("$($req.name)" -ne '') { "$($req.name)" } else { $KeyName })
            if ($name -ne $KeyName -and -not (Find-Wallet $name)) { Fail "'$name' is not a wallet this app manages." }
            $pass = Require-Passphrase
            # pocketd asks "continue? [y/N]" for --unsafe, then the keyring passphrase.
            $r = Pocketd @('keys', 'export', $name, '--unarmored-hex', '--unsafe', '--keyring-backend', 'file') $pass -prefixLines "y`n"
            if ($r.code -ne 0) { Fail 'pocketd could not export the key.' (Clean-Err $r.err) }
            $hex = "$($r.out)".Trim()
            if ($hex -notmatch '^[0-9a-fA-F]{64}$') { Fail 'pocketd returned something that is not a 64-character hex key.' (Clean-Err $r.err) }
            Add-History @{ op = 'wallet-export'; extra = "name=$name" }
            Emit @{ ok = $true; hex = $hex; name = $name }
        }

        'wallet-delete' {
            # Revoke: removes the whole keyring, so every application wallet in it goes too.
            $apps = @(Read-Wallets)
            if ($apps.Count -gt 0 -and -not $req.force) { Fail "The keyring still holds $($apps.Count) application wallet(s). Export or remove them first, or confirm that they may be deleted with it." }
            $dc = Docker-Check
            if ($dc.ok -and (Volume-Exists)) {
                $r = Docker @('volume', 'rm', '-f', $Volume)
                if ($r.code -ne 0) { Fail 'Could not delete the keyring volume.' (First-Line $r.err) }
            } elseif (-not $dc.ok) {
                Fail 'Docker Desktop must be running to delete the keyring volume.' $dc.detail
            }
            $w = Read-Wallet
            if (Test-Path $PassFile) { Remove-Item $PassFile -Force }
            if (Test-Path $WalletFile) { Remove-Item $WalletFile -Force }
            if (Test-Path $WalletsFile) { Remove-Item $WalletsFile -Force }
            Add-History @{ op = 'wallet-delete'; address = "$($w.address)" }
            Emit @{ ok = $true }
        }

        # ------------------------------------------------ application wallets ----

        'wallet-list' {
            # Every wallet this app manages, checked against the keyring when Docker is up.
            $parent = Read-Wallet
            $apps = @(Read-Wallets)
            $dc = Docker-Check
            $verified = $false
            $inRing = @{}
            if ($dc.ok -and $dc.image -and (Volume-Exists) -and (Test-Path $PassFile)) {
                $pass = Unseal-Passphrase
                $lst = Keyring-List $pass
                if ($lst -ne $null) { $verified = $true; foreach ($k in $lst) { $inRing["$($k.name)"] = "$($k.address)" } }
            }
            $out = @()
            foreach ($a in $apps) {
                $o = @{ name = "$($a.name)"; address = "$($a.address)"; service_id = "$($a.service_id)"; created_at = "$($a.created_at)"; source = "$($a.source)" }
                if ($verified) { $o['present'] = $inRing.ContainsKey("$($a.name)") } else { $o['present'] = $null }
                $out += $o
            }
            $p = $null
            if ($parent) { $p = @{ name = $KeyName; address = "$($parent.address)"; present = $(if ($verified) { $inRing.ContainsKey($KeyName) } else { $null }) } }
            Emit @{ ok = $true; verified = $verified; parent = $p; wallets = $out }
        }

        'wallet-create' {
            # New application wallet. The recovery phrase is returned once and never stored.
            Require-Docker
            $name = "$($req.name)"; $sid = "$($req.service_id)"
            Validate-WalletName $name
            if ($sid) { Validate-ServiceId $sid }
            if (-not (Read-Wallet)) { Fail 'Import the owner wallet first; it creates the keyring the application wallets live in.' }
            if (Find-Wallet $name) { Fail "A wallet named '$name' already exists." }
            $pass = Require-Passphrase
            if (Keyring-Address $name $pass) { Fail "The keyring already holds a key named '$name' that this app does not track. Choose another name." }
            $r = Pocketd @('keys', 'add', $name, '--keyring-backend', 'file', '--output', 'json') $pass
            $j = Parse-FirstJson $r
            if ($r.code -ne 0 -or -not $j -or -not $j.address) { Fail 'pocketd could not create the key.' (Clean-Err $r.err) }
            $addr = "$($j.address)"; $phrase = "$($j.mnemonic)"
            $j = $null; $r = $null
            if ($addr -notmatch '^pokt1[0-9a-z]{38}$') { Fail 'pocketd returned an address that is not a pokt1 address.' $addr }
            if (($phrase -split ' ').Count -lt 12) { Fail 'pocketd did not return a recovery phrase; the key was created but cannot be backed up. Remove it and try again.' }
            $entry = Register-Wallet $name $addr $sid 'create'
            Emit @{ ok = $true; name = $name; address = $addr; service_id = $sid; mnemonic = $phrase }
        }

        'wallet-recover' {
            # Application wallet from a recovery phrase passed in PSM_IMPORT_MNEMONIC.
            Require-Docker
            $name = "$($req.name)"; $sid = "$($req.service_id)"
            Validate-WalletName $name
            if ($sid) { Validate-ServiceId $sid }
            if (-not (Read-Wallet)) { Fail 'Import the owner wallet first; it creates the keyring the application wallets live in.' }
            if (Find-Wallet $name) { Fail "A wallet named '$name' already exists." }
            $phrase = ("$env:PSM_IMPORT_MNEMONIC" -replace '\s+', ' ').Trim().ToLower()
            $n = ($phrase -split ' ').Count
            if (-not $phrase) { Fail 'No recovery phrase was provided.' }
            if ($n -notin @(12, 15, 18, 21, 24)) { Fail "A recovery phrase has 12 or 24 words; this one has $n." }
            if ($phrase -notmatch '^[a-z ]+$') { Fail 'A recovery phrase contains only lowercase words separated by spaces.' }
            $pass = Require-Passphrase
            if (Keyring-Address $name $pass) { Fail "The keyring already holds a key named '$name' that this app does not track. Choose another name." }
            # pocketd reads the phrase first, then the keyring passphrase.
            $r = Pocketd @('keys', 'add', $name, '--recover', '--keyring-backend', 'file', '--output', 'json') $pass -prefixLines "$phrase`n"
            $phrase = $null
            $j = Parse-FirstJson $r
            if ($r.code -ne 0 -or -not $j -or -not $j.address) { Fail 'pocketd could not recover the key.' (Summarize-Err $r.err) }
            $addr = "$($j.address)"; $j = $null; $r = $null
            $entry = Register-Wallet $name $addr $sid 'recover'
            Emit @{ ok = $true; name = $name; address = $addr; service_id = $sid }
        }

        'wallet-import-app' {
            # Application wallet from a hex private key passed in PSM_IMPORT_KEY.
            Require-Docker
            $name = "$($req.name)"; $sid = "$($req.service_id)"
            Validate-WalletName $name
            if ($sid) { Validate-ServiceId $sid }
            if (-not (Read-Wallet)) { Fail 'Import the owner wallet first; it creates the keyring the application wallets live in.' }
            if (Find-Wallet $name) { Fail "A wallet named '$name' already exists." }
            $hex = "$env:PSM_IMPORT_KEY".Trim()
            if ($hex -match '^0[xX]') { $hex = $hex.Substring(2) }
            if ($hex -notmatch '^[0-9a-fA-F]{64}$') { Fail 'The private key must be 64 hexadecimal characters (32 bytes), optionally prefixed with 0x.' }
            $pass = Require-Passphrase
            if (Keyring-Address $name $pass) { Fail "The keyring already holds a key named '$name' that this app does not track. Choose another name." }
            $probe = Probe-HexAddress $hex
            if (-not $probe) { Fail 'pocketd could not derive an address from that key.' }
            $holder = Wallet-Holding $probe
            if ($holder) { $hex = $null; Fail "That key is already in the keyring as '$holder' ($probe)." }
            $r = Invoke-InBox ('pocketd keys import-hex ' + (Sh-Quote $name) + ' "$PSM_IMPORT_KEY" --keyring-backend file') "$pass`n$pass`n" @() @{ PSM_IMPORT_KEY = $hex }
            $hex = $null
            if ($r.code -ne 0) { Fail 'pocketd could not import the key.' (Summarize-Err $r.err) }
            $addr = Keyring-Address $name $pass
            if (-not $addr) { Fail 'The key was imported but cannot be read back.' }
            if ($addr -ne $probe) { Fail 'The imported key does not match the address derived beforehand.' "$addr vs $probe" }
            $entry = Register-Wallet $name $addr $sid 'import'
            Emit @{ ok = $true; name = $name; address = $addr; service_id = $sid }
        }

        'wallet-set-service' {
            $name = "$($req.name)"; $sid = "$($req.service_id)"
            if ($sid) { Validate-ServiceId $sid }
            $w = Find-Wallet $name
            if (-not $w) { Fail "'$name' is not a wallet this app manages." }
            $list = @()
            foreach ($x in (Read-Wallets)) { if ("$($x.name)" -eq $name) { $x | Add-Member -NotePropertyName service_id -NotePropertyValue $sid -Force }; $list += $x }
            Save-Wallets $list
            Emit @{ ok = $true }
        }

        'wallet-remove' {
            # Deletes an application wallet's key from the keyring. The app checks the
            # balance and stake first and asks for the name to be typed.
            Require-Docker
            $name = "$($req.name)"
            if ($name -eq $KeyName) { Fail 'The owner wallet is removed with Revoke, not here.' }
            $w = Find-Wallet $name
            if (-not $w) { Fail "'$name' is not a wallet this app manages." }
            if ("$($req.confirm)" -ne $name) { Fail 'The wallet name was not confirmed.' }
            foreach ($x in (Read-Wallets)) { if ("$($x.name)" -ne $name -and "$($x.address)" -eq "$($w.address)") { Fail "'$($x.name)' holds the same key; removing one would break the other. Remove that record first." } }
            $pass = Require-Passphrase
            if (Keyring-Address $name $pass) {
                $r = Pocketd @('keys', 'delete', $name, '-y', '--keyring-backend', 'file') $pass
                # Treat a failed delete as done only if the key really is gone afterwards.
                if ($r.code -ne 0 -and (Keyring-Address $name $pass)) { Fail 'pocketd could not delete the key.' (Clean-Err $r.err) }
            }
            Save-Wallets @(Read-Wallets | Where-Object { "$($_.name)" -ne $name })
            Add-History @{ op = 'wallet-remove'; address = "$($w.address)"; extra = "name=$name" }
            Emit @{ ok = $true }
        }

        'validate-card' {
            $card = "$($req.card_path)"
            $script = "$($req.script)"
            if (-not (Test-Path $card)) { Fail "Card file not found: $card" }
            if (-not (Test-Path $script)) { Emit @{ ok = $true; skipped = $true; reason = 'validate_card.py not found next to this tool.' } }
            try { $r = Invoke-Native 'python' @($script, $card) }
            catch { Emit @{ ok = $true; skipped = $true; reason = 'python is not installed, so only the built-in checks ran.' } }
            Emit @{ ok = ($r.code -eq 0); code = $r.code; output = ("$($r.out)`n$($r.err)").Trim() }
        }

        'tx-add-service' {
            Require-Docker
            $net = Require-Network $req.network
            $id = "$($req.service_id)"; $name = "$($req.name)"; $cupr = [int64]$req.compute_units_per_relay
            Validate-ServiceId $id
            if ($name -notmatch '^[A-Za-z0-9 _-]{1,169}$') { Fail 'Service name must be 1 to 169 characters of letters, digits, spaces, hyphens, or underscores.' }
            if ($cupr -lt 1 -or $cupr -gt 1048576) { Fail 'Compute units per relay must be between 1 and 1,048,576.' }
            if (-not (Read-Wallet)) { Fail 'No wallet is imported.' }
            $argv = @('tx', 'service', 'add-service', $id, $name, "$cupr")
            $mounts = @()
            $work = $null
            if ("$($req.card_path)" -ne '') {
                $cardPath = "$($req.card_path)"
                if (-not (Test-Path $cardPath)) { Fail "Card file not found: $cardPath" }
                if ((Get-Item $cardPath).Length -gt 262144) { Fail 'The card is larger than 256 KiB, the chain limit.' }
                $work = New-WorkDir
                Copy-Item $cardPath (Join-Path $work 'card.json')
                $mounts += "${work}:/work:ro"
                $argv += @('--card-file', '/work/card.json')
            }
            $argv += @('--from', $KeyName, '--keyring-backend', 'file', '--network', $net) + $GasArgs + @('-y', '-o', 'json')
            if ($req.dry) {
                if ($work) { Remove-Item $work -Recurse -Force }
                Emit @{ ok = $true; dry = $true; command = ('pocketd ' + (($argv | ForEach-Object { Quote-Arg $_ }) -join ' ')) }
            }
            $pass = Require-Passphrase
            $r = Pocketd $argv $pass $mounts
            if ($work) { Remove-Item $work -Recurse -Force }
            Emit-Tx $r $net 'add-service' $id "cupr=$cupr"
        }

        'tx-stake-app' {
            # Stakes a wallet as an application for exactly one service. 'from' names
            # the signing wallet: the parent, or one of the application wallets.
            Require-Docker
            $net = Require-Network $req.network
            $id = "$($req.service_id)"; $stake = [int64]$req.stake_upokt
            Validate-ServiceId $id
            if ($stake -le 0) { Fail 'Stake amount must be a positive number of uPOKT.' }
            $from = Resolve-Signer "$($req.from)"
            $work = New-WorkDir
            $yaml = "stake_amount: ${stake}upokt`nservice_ids:`n  - $id`n"
            [IO.File]::WriteAllText((Join-Path $work 'app_stake.yaml'), $yaml, (New-Object System.Text.UTF8Encoding($false)))
            $argv = @('tx', 'application', 'stake-application', '--config', '/work/app_stake.yaml', '--from', $from, '--keyring-backend', 'file', '--network', $net) + $GasArgs + @('-y', '-o', 'json')
            if ($req.dry) {
                Remove-Item $work -Recurse -Force
                Emit @{ ok = $true; dry = $true; command = ('pocketd ' + (($argv | ForEach-Object { Quote-Arg $_ }) -join ' ')); config = $yaml; from = $from }
            }
            $pass = Require-Passphrase
            $r = Pocketd $argv $pass @("${work}:/work:ro")
            Remove-Item $work -Recurse -Force
            if ($from -ne $KeyName -and $id) {
                # Remember which service this wallet now stakes for.
                $list = @(); foreach ($x in (Read-Wallets)) { if ("$($x.name)" -eq $from) { $x | Add-Member -NotePropertyName service_id -NotePropertyValue $id -Force }; $list += $x }; Save-Wallets $list
            }
            Emit-Tx $r $net 'stake-application' $id "stake_upokt=$stake from=$from"
        }

        'tx-fund-operator' {
            # POKT from the owner wallet to a supplier operator, so the operator can
            # pay its own stake and gas.
            Require-Docker
            $net = Require-Network $req.network
            $to = "$($req.to)"; $amt = [int64]$req.amount_upokt
            if ($to -notmatch '^pokt1[0-9a-z]{38}$') { Fail 'Recipient is not a valid pokt1 address.' }
            if ($amt -le 0) { Fail 'Amount must be a positive number of uPOKT.' }
            $w = Read-Wallet
            if (-not $w) { Fail 'No wallet is imported.' }
            if ($to -eq "$($w.address)") { Fail 'The recipient is this wallet itself.' }
            $argv = @('tx', 'bank', 'send', $KeyName, $to, "${amt}upokt", '--keyring-backend', 'file', '--network', $net) + $GasArgs + @('-y', '-o', 'json')
            if ($req.dry) { Emit @{ ok = $true; dry = $true; command = ('pocketd ' + (($argv | ForEach-Object { Quote-Arg $_ }) -join ' ')) } }
            $pass = Require-Passphrase
            $r = Pocketd $argv $pass
            Emit-Tx $r $net 'fund-operator' '' "to=$to amount_upokt=$amt"
        }

        'tx-delegate-gateway' {
            # Delegates an application (the owner wallet or one of the app wallets) to a
            # gateway, which may then sign relays on its behalf. Gas only; no funds move.
            Require-Docker
            $net = Require-Network $req.network
            $gw = "$($req.gateway_address)"
            if ($gw -notmatch '^pokt1[0-9a-z]{38}$') { Fail 'Gateway address is not a valid pokt1 address.' }
            $from = Resolve-Signer "$($req.from)"
            $argv = @('tx', 'application', 'delegate-to-gateway', $gw, '--from', $from, '--keyring-backend', 'file', '--network', $net) + $GasArgs + @('-y', '-o', 'json')
            if ($req.dry) { Emit @{ ok = $true; dry = $true; command = ('pocketd ' + (($argv | ForEach-Object { Quote-Arg $_ }) -join ' ')); from = $from } }
            $pass = Require-Passphrase
            $r = Pocketd $argv $pass
            Emit-Tx $r $net 'delegate-to-gateway' '' "gateway=$gw from=$from"
        }

        'tx-undelegate-gateway' {
            # Removes a delegation; takes effect when the current session ends.
            Require-Docker
            $net = Require-Network $req.network
            $gw = "$($req.gateway_address)"
            if ($gw -notmatch '^pokt1[0-9a-z]{38}$') { Fail 'Gateway address is not a valid pokt1 address.' }
            $from = Resolve-Signer "$($req.from)"
            $argv = @('tx', 'application', 'undelegate-from-gateway', $gw, '--from', $from, '--keyring-backend', 'file', '--network', $net) + $GasArgs + @('-y', '-o', 'json')
            if ($req.dry) { Emit @{ ok = $true; dry = $true; command = ('pocketd ' + (($argv | ForEach-Object { Quote-Arg $_ }) -join ' ')); from = $from } }
            $pass = Require-Passphrase
            $r = Pocketd $argv $pass
            Emit-Tx $r $net 'undelegate-from-gateway' '' "gateway=$gw from=$from"
        }

        'tx-unstake-supplier' {
            # Begins unbonding a supplier, signed by the OWNER wallet (the chain accepts
            # the owner or the operator as signer; the stake always returns to the
            # owner). The supplier keeps serving until the current session ends, then
            # the stake is locked for supplier_unbonding_period_sessions and returned.
            Require-Docker
            $net = Require-Network $req.network
            $op = "$($req.operator_address)"
            if ($op -notmatch '^pokt1[0-9a-z]{38}$') { Fail 'Operator address is not a valid pokt1 address.' }
            $w = Read-Wallet
            if (-not $w) { Fail 'No wallet is imported.' }
            $argv = @('tx', 'supplier', 'unstake-supplier', $op, '--from', $KeyName, '--keyring-backend', 'file', '--network', $net) + $GasArgs + @('-y', '-o', 'json')
            if ($req.dry) { Emit @{ ok = $true; dry = $true; command = ('pocketd ' + (($argv | ForEach-Object { Quote-Arg $_ }) -join ' ')) } }
            $pass = Require-Passphrase
            $r = Pocketd $argv $pass
            Emit-Tx $r $net 'unstake-supplier' '' "operator=$op owner=$($w.address)"
        }

        'tx-fund-wallet' {
            # POKT from the owner wallet to one of the application wallets it manages
            # (for the application stake plus gas). The recipient must be in wallets.json.
            Require-Docker
            $net = Require-Network $req.network
            $name = "$($req.name)"; $amt = [int64]$req.amount_upokt
            $w = Find-Wallet $name
            if (-not $w) { Fail "'$name' is not a wallet this app manages." }
            $to = "$($w.address)"
            if ($to -notmatch '^pokt1[0-9a-z]{38}$') { Fail 'The wallet record has no valid address.' }
            if ($amt -le 0) { Fail 'Amount must be a positive number of uPOKT.' }
            if (-not (Read-Wallet)) { Fail 'No owner wallet is imported.' }
            $argv = @('tx', 'bank', 'send', $KeyName, $to, "${amt}upokt", '--keyring-backend', 'file', '--network', $net) + $GasArgs + @('-y', '-o', 'json')
            if ($req.dry) { Emit @{ ok = $true; dry = $true; command = ('pocketd ' + (($argv | ForEach-Object { Quote-Arg $_ }) -join ' ')) } }
            $pass = Require-Passphrase
            $r = Pocketd $argv $pass
            Emit-Tx $r $net 'fund-wallet' "$($w.service_id)" "to=$to name=$name amount_upokt=$amt"
        }

        'supplier-ship' {
            # Provision step: renders one network's supplier stack for a server from
            # tools/service-manager/server/ and copies it to that stack's directory, plus
            # the server's shared Caddy (one site file per network) to the caddy
            # directory, then runs `supplier.sh prepare` there. An existing relayer
            # config (with services already added) is left alone. No keys are involved.
            $conn = Resolve-Ssh $req
            $net = Require-Network $req.network
            $path = "$($req.path)"; $hostname = "$($req.hostname)"; $project = "$($req.project)"; $caddyDir = "$($req.caddy_dir)"
            if ($path -notmatch '^/[A-Za-z0-9._/-]+$') { Fail 'Stack directory must be an absolute Linux path.' }
            if ($hostname -notmatch '^[A-Za-z0-9.-]+$') { Fail 'Hostname must be a DNS name pointing at the server.' }
            if ($project -eq '') { $project = "pocket-supplier-$net" }
            if ($project -notmatch '^[a-z0-9][a-z0-9-]{0,40}$') { Fail 'Stack project name must be lowercase letters, digits, and hyphens.' }
            if ($caddyDir -eq '') { $caddyDir = '/opt/pocket/caddy' }
            if ($caddyDir -notmatch '^/[A-Za-z0-9._/-]+$') { Fail 'Caddy directory must be an absolute Linux path.' }
            if ($caddyDir -eq $path) { Fail 'The Caddy directory must differ from the stack directory.' }
            $hp = 8081; $rmp = 9090; $mmp = 9092
            try {
                if ("$($req.health_port)" -ne '') { $hp = [int]$req.health_port }
                if ("$($req.relayer_metrics_port)" -ne '') { $rmp = [int]$req.relayer_metrics_port }
                if ("$($req.miner_metrics_port)" -ne '') { $mmp = [int]$req.miner_metrics_port }
            } catch { Fail 'Stack ports must be numbers.' }
            $bt = 0; try { $bt = [int]$req.block_time } catch {}
            if ($bt -le 0) { $bt = $(if ($net -eq 'main') { 60 } else { 30 }) }
            $chain = $(if ($net -eq 'main') { 'pocket' } else { 'pocket-lego-testnet' })
            $rpc = $(if ($net -eq 'main') { 'https://sauron-rpc.infra.pocket.network' } else { 'https://sauron-rpc.beta.infra.pocket.network' })
            $grpc = $(if ($net -eq 'main') { 'sauron-grpc.infra.pocket.network:443' } else { 'sauron-grpc.beta.infra.pocket.network:443' })
            $tpl = Join-Path $PSScriptRoot 'server'
            if (-not (Test-Path (Join-Path $tpl 'supplier.sh'))) { Fail 'The server templates are missing next to signer.ps1.' $tpl }
            $work = New-WorkDir
            $tokens = @{ '{{NETWORK}}' = $net; '{{CHAIN_ID}}' = $chain; '{{RPC_URL}}' = $rpc; '{{GRPC_URL}}' = $grpc; '{{BLOCK_TIME}}' = "$bt"; '{{HOSTNAME}}' = $hostname;
                         '{{PROJECT}}' = $project; '{{HEALTH_PORT}}' = "$hp"; '{{RELAYER_METRICS_PORT}}' = "$rmp"; '{{MINER_METRICS_PORT}}' = "$mmp"; '{{CADDY_DIR}}' = $caddyDir }
            $utf8 = New-Object System.Text.UTF8Encoding($false)
            New-Item -ItemType Directory -Path (Join-Path $work 'caddy\sites') -Force | Out-Null
            foreach ($pair in @(@('miner-config.yaml.tmpl', 'miner-config.yaml'), @('relayer-config.yaml.tmpl', 'relayer-config.yaml'), @('docker-compose.yaml.tmpl', 'docker-compose.yaml'), @('stack.env.tmpl', 'stack.env'), @('site.caddy.tmpl', "caddy\sites\$net.caddy"))) {
                $t = Get-Content (Join-Path $tpl $pair[0]) -Raw
                foreach ($k in $tokens.Keys) { $t = $t.Replace($k, $tokens[$k]) }
                [IO.File]::WriteAllText((Join-Path $work $pair[1]), ($t -replace "`r`n", "`n"), $utf8)
            }
            [IO.File]::WriteAllText((Join-Path $work 'supplier.sh'), ((Get-Content (Join-Path $tpl 'supplier.sh') -Raw) -replace "`r`n", "`n"), $utf8)
            foreach ($f in @('docker-compose.yaml', 'Caddyfile')) { [IO.File]::WriteAllText((Join-Path $work "caddy\$f"), ((Get-Content (Join-Path $tpl "caddy\$f") -Raw) -replace "`r`n", "`n"), $utf8) }
            $mk = Invoke-Native 'ssh' ($conn.ssh + @($conn.target, "mkdir -p '$path' '$caddyDir/sites' && test -f '$path/relayer-config.yaml' && echo PSM_HAVE_RELAYER || true"))
            if ($mk.code -ne 0) { Fail 'Could not create the stack directory over SSH.' (Clean-Err ($mk.err + "`n" + $mk.out)) }
            $keepRelayer = ("$($mk.out)" -match 'PSM_HAVE_RELAYER')
            $files = @('docker-compose.yaml', 'miner-config.yaml', 'stack.env', 'supplier.sh')
            if (-not $keepRelayer) { $files += 'relayer-config.yaml' }
            $srcs = @(); foreach ($f in $files) { $srcs += (Join-Path $work $f) }
            $cp = Invoke-Native 'scp' ($conn.scp + @('-q') + $srcs + @("$($conn.target):$path/"))
            if ($cp.code -ne 0) { Remove-Item $work -Recurse -Force; Fail 'Could not copy the stack files to the server.' (Clean-Err $cp.err) }
            $cp2 = Invoke-Native 'scp' ($conn.scp + @('-q', (Join-Path $work 'caddy\docker-compose.yaml'), (Join-Path $work 'caddy\Caddyfile'), "$($conn.target):$caddyDir/"))
            if ($cp2.code -ne 0) { Remove-Item $work -Recurse -Force; Fail 'Could not copy the Caddy files to the server.' (Clean-Err $cp2.err) }
            $cp3 = Invoke-Native 'scp' ($conn.scp + @('-q', (Join-Path $work "caddy\sites\$net.caddy"), "$($conn.target):$caddyDir/sites/"))
            Remove-Item $work -Recurse -Force
            if ($cp3.code -ne 0) { Fail 'Could not copy the Caddy site file to the server.' (Clean-Err $cp3.err) }
            $r = Invoke-Native 'ssh' ($conn.ssh + @($conn.target, "bash '$path/supplier.sh' prepare"))
            if ($r.code -ne 0) { Fail 'supplier.sh prepare failed on the server.' (Clean-Err ($r.err + "`n" + $r.out)) }
            Add-History @{ op = 'supplier-ship'; network = $net; extra = "host=$($conn.target) path=$path project=$project hostname=$hostname caddy=$caddyDir" }
            $files += @("$caddyDir/docker-compose.yaml", "$caddyDir/Caddyfile", "$caddyDir/sites/$net.caddy")
            Emit @{ ok = $true; files = $files; relayer_kept = $keepRelayer; out = (First-Line $r.out) }
        }

        'supplier-run' {
            # Runs one allow-listed step of supplier.sh on the server. Steps that touch
            # the operator key do so only on the server; only the address comes back.
            $conn = Resolve-Ssh $req
            $path = "$($req.path)"; $step = "$($req.step)"
            if ($path -notmatch '^/[A-Za-z0-9._/-]+$') { Fail 'Stack directory must be an absolute Linux path.' }
            $args = @()
            switch ($step) {
                'operator' { }
                'keys' { }
                'start' { }
                'status' { }
                'publish' { $args += (Require-Network $req.network) }
                'deploy' {
                    $sid = "$($req.service_id)"; Validate-ServiceId $sid
                    $root = "$($req.deploy_root)"; if ($root -notmatch '^/[A-Za-z0-9._/-]+$') { Fail 'Deploy root must be an absolute Linux path.' }
                    $hp = "$($req.health_path)"; if ($hp -eq '') { $hp = '/healthz' }; if ($hp -notmatch '^/[A-Za-z0-9._/-]*$') { Fail 'Health path must start with /.' }
                    $args += @($sid, $root, $hp)
                }
                'add-service' {
                    $sid = "$($req.service_id)"; Validate-ServiceId $sid
                    $url = "$($req.backend_url)"; if ($url -notmatch '^http://[A-Za-z0-9._-]+:[0-9]{2,5}$') { Fail 'Backend URL must be http://<container>:<port>.' }
                    $hp = "$($req.health_path)"; if ($hp -eq '') { $hp = '/healthz' }; if ($hp -notmatch '^/[A-Za-z0-9._/-]*$') { Fail 'Health path must start with /.' }
                    $args += @($sid, $url, $hp)
                }
                'remove-service' { $sid = "$($req.service_id)"; Validate-ServiceId $sid; $args += $sid }
                default { Fail "Unknown supplier step '$step'." }
            }
            $cmd = "bash '$path/supplier.sh' $step" + (($args | ForEach-Object { " '" + $_ + "'" }) -join '')
            $r = Invoke-Native 'ssh' ($conn.ssh + @($conn.target, $cmd))
            $out = "$($r.out)"; if ($out.Length -gt 20000) { $out = $out.Substring($out.Length - 20000) }
            $addr = ''; if ($out -match 'operator:\s*(pokt1[0-9a-z]{38})') { $addr = $Matches[1] }
            $lines = @(($out -split "`r?`n") | Where-Object { $_.Trim() -ne '' })
            $err = ''; foreach ($l in $lines) { if ($l -match '^error:\s*(.*)$') { $err = $Matches[1] } }
            if ($step -notin @('operator', 'keys')) { Add-History @{ op = "supplier-$step"; extra = "host=$($conn.target) " + ($args -join ' ') } }
            Emit @{ ok = ($r.code -eq 0 -and $err -eq ''); step = $step; out = $out; err = $(if ($err) { $err } else { Clean-Err $r.err }); address = $addr; lines = $lines }
        }

        'deploy-ship' {
            # Copies a service's backend (without node_modules) and its deploy compose
            # file to <deploy root>/<service id>/ on the server as one tar archive. When
            # the service folder has no deploy/docker-compose.yaml, the backend-only
            # compose file is rendered from the template.
            $conn = Resolve-Ssh $req
            $sid = "$($req.service_id)"; Validate-ServiceId $sid
            $root = "$($req.deploy_root)"; if ($root -notmatch '^/[A-Za-z0-9._/-]+$') { Fail 'Deploy root must be an absolute Linux path.' }
            $folder = "$($req.folder)"
            if (-not (Test-Path (Join-Path $folder 'backend\Dockerfile'))) { Fail 'The service folder has no backend\Dockerfile to build.' $folder }
            $work = New-WorkDir
            $stage = Join-Path $work 'stage'
            New-Item -ItemType Directory -Path (Join-Path $stage 'deploy') -Force | Out-Null
            $rc = Invoke-Native 'robocopy' @((Join-Path $folder 'backend'), (Join-Path $stage 'backend'), '/E', '/XD', 'node_modules', '.git', '__pycache__', 'test', '/XF', '*.pyc', '/NFL', '/NDL', '/NJH', '/NJS', '/NP')
            if ($rc.code -ge 8) { Remove-Item $work -Recurse -Force; Fail 'Could not stage the backend folder.' "$($rc.out)$($rc.err)" }
            $utf8 = New-Object System.Text.UTF8Encoding($false)
            $own = Join-Path $folder 'deploy\docker-compose.yaml'
            if (Test-Path $own) { [IO.File]::WriteAllText((Join-Path $stage 'deploy\docker-compose.yaml'), ((Get-Content $own -Raw) -replace "`r`n", "`n"), $utf8); $composeFrom = 'the service folder' }
            else {
                $t = (Get-Content (Join-Path $PSScriptRoot 'server\backend-compose.yaml.tmpl') -Raw).Replace('{{SERVICE_ID}}', $sid)
                [IO.File]::WriteAllText((Join-Path $stage 'deploy\docker-compose.yaml'), ($t -replace "`r`n", "`n"), $utf8); $composeFrom = 'the template'
            }
            $tarExe = Join-Path $env:SystemRoot 'System32\tar.exe'
            if (-not (Test-Path $tarExe)) { $tarExe = 'tar' }
            $bundle = Join-Path $work 'bundle.tar'
            $tr = Invoke-Native $tarExe @('-cf', $bundle, '-C', $stage, 'backend', 'deploy')
            if ($tr.code -ne 0) { Remove-Item $work -Recurse -Force; Fail 'Could not build the deployment archive.' (First-Line $tr.err) }
            $size = (Get-Item $bundle).Length
            $dest = "$root/$sid"
            $mk = Invoke-Native 'ssh' ($conn.ssh + @($conn.target, "mkdir -p '$dest'"))
            if ($mk.code -ne 0) { Remove-Item $work -Recurse -Force; Fail 'Could not create the service directory on the server.' (Clean-Err $mk.err) }
            $cp = Invoke-Native 'scp' ($conn.scp + @('-q', $bundle, "$($conn.target):$dest/bundle.tar"))
            Remove-Item $work -Recurse -Force
            if ($cp.code -ne 0) { Fail 'Could not copy the archive to the server.' (Clean-Err $cp.err) }
            $x = Invoke-Native 'ssh' ($conn.ssh + @($conn.target, "cd '$dest' && tar -xf bundle.tar && rm -f bundle.tar && find backend deploy -type f | wc -l"))
            if ($x.code -ne 0) { Fail 'Could not unpack the archive on the server.' (Clean-Err ($x.err + "`n" + $x.out)) }
            Add-History @{ op = 'deploy-ship'; service_id = $sid; extra = "host=$($conn.target) dest=$dest bytes=$size" }
            Emit @{ ok = $true; dest = $dest; bytes = $size; files = (First-Line $x.out); compose_from = $composeFrom }
        }

        'ssh-test' {
            # Checks a server entry from Settings: the connection works, docker is there,
            # and (if a supplier directory is given) the operator keyring exists.
            $conn = Resolve-Ssh $req
            $path = "$($req.path)"
            $probe = 'hostname; docker compose version 2>/dev/null | head -1'
            if ($path -ne '') { if ($path -notmatch '^/[A-Za-z0-9._/-]+$') { Fail 'Supplier directory must be an absolute Linux path.' }; $probe += "; test -d '$path/pocket-home' && echo PSM_KEYRING_OK" }
            $probe += '; true'
            $r = Invoke-Native 'ssh' ($conn.ssh + @($conn.target, $probe))
            # ssh itself exits 255 when it cannot connect or authenticate; the probe always exits 0.
            if ($r.code -ne 0) { Fail 'Could not connect over SSH.' (Clean-Err ($r.err + "`n" + $r.out)) }
            $lines = @(("$($r.out)" -split "`r?`n") | Where-Object { $_.Trim() -ne '' })
            $docker = ''; foreach ($l in $lines) { if ($l -match 'Docker Compose') { $docker = $l.Trim() } }
            Emit @{ ok = $true; hostname = $(if ($lines.Count) { $lines[0].Trim() } else { '' }); docker = $docker; keyring = [bool]("$($r.out)" -match 'PSM_KEYRING_OK') }
        }

        'remote-stake-supplier' {
            # Non-custodial supplier stake, signed by the OPERATOR on the server over SSH.
            # Only the operator may set service configurations and revenue share, and the
            # signer's balance pays the stake, so the app funds the operator first
            # (tx-fund-operator). The YAML lists EVERY service the supplier serves,
            # because stake-supplier replaces the whole list; the app merges the
            # existing record before calling. Nothing here touches the local keyring.
            $net = Require-Network $req.network
            $conn = Resolve-Ssh $req
            $sshHost = $conn.target; $path = "$($req.path)"; $keyName = $(if ("$($req.operator_key_name)" -ne '') { "$($req.operator_key_name)" } else { 'operator' })
            $owner = "$($req.owner_address)"; $operator = "$($req.operator_address)"; $stake = [int64]$req.stake_upokt
            if ($path -notmatch '^/[A-Za-z0-9._/-]+$') { Fail 'Supplier directory must be an absolute Linux path.' }
            if ($keyName -notmatch '^[A-Za-z0-9._-]+$') { Fail 'Operator key name is invalid.' }
            if ($owner -notmatch '^pokt1[0-9a-z]{38}$') { Fail 'Owner address is not a valid pokt1 address.' }
            if ($operator -notmatch '^pokt1[0-9a-z]{38}$') { Fail 'Operator address is not a valid pokt1 address.' }
            if ($stake -le 0) { Fail 'Stake amount must be a positive number of uPOKT.' }
            $svcs = @($req.services)
            if ($svcs.Count -eq 0) { Fail 'At least one service is required.' }
            $yaml = "owner_address: $owner`noperator_address: $operator`nstake_amount: ${stake}upokt`ndefault_rev_share_percent:`n  ${owner}: 100`nservices:`n"
            $ids = @()
            foreach ($s in $svcs) {
                $sid = "$($s.service_id)"; $url = "$($s.url)"; $rpc = "$($s.rpc_type)"
                Validate-ServiceId $sid
                if ($url -notmatch '^https://[^\s]+$') { Fail "Endpoint for $sid must be an https:// URL." }
                if ($rpc -notin @('REST', 'JSON_RPC', 'WEBSOCKET', 'GRPC', 'COMET_BFT')) { Fail "Unknown rpc_type '$rpc' for $sid." }
                $yaml += "  - service_id: $sid`n    endpoints:`n      - publicly_exposed_url: $url`n        rpc_type: $rpc`n"
                $ids += $sid
            }
            $remote = "cd $path && docker run --rm -v $path/pocket-home:/home -v ${path}:/work:ro $Image tx supplier stake-supplier --config /work/supplier_stake.yaml --from $keyName --keyring-backend test --home /home --network $net --gas auto --gas-prices 1upokt --gas-adjustment 1.5 -y -o json"
            if ($req.dry) { Emit @{ ok = $true; dry = $true; command = ('ssh ' + (($conn.ssh + @($sshHost)) -join ' ') + " '" + $remote + "'"); config = $yaml } }
            $work = New-WorkDir
            $local = Join-Path $work 'supplier_stake.yaml'
            [IO.File]::WriteAllText($local, $yaml, (New-Object System.Text.UTF8Encoding($false)))
            $cp = Invoke-Native 'scp' ($conn.scp + @('-q', $local, "${sshHost}:${path}/supplier_stake.yaml"))
            Remove-Item $work -Recurse -Force
            if ($cp.code -ne 0) { Fail "Could not copy the stake config to $sshHost." (Clean-Err $cp.err) }
            $r = Invoke-Native 'ssh' ($conn.ssh + @($sshHost, $remote))
            if ($r.code -ne 0 -and -not ("$($r.out)" -match '"txhash"')) { Fail (Summarize-Err $r.err) (Clean-Err ($r.err + "`n" + $r.out)) }
            Emit-Tx $r $net 'stake-supplier' ($ids -join ',') "operator=$operator via $sshHost"
        }

        'history' {
            if (-not (Test-Path $HistoryFile)) { Emit @{ ok = $true; entries = @() } }
            $lines = Get-Content $HistoryFile | Where-Object { $_.Trim() -ne '' }
            $entries = @($lines | ForEach-Object { try { $_ | ConvertFrom-Json } catch { $null } } | Where-Object { $_ -ne $null })
            Emit @{ ok = $true; entries = $entries }
        }

        default {
            Fail "Unknown operation '$op'."
        }
    }
}
catch {
    Fail 'The signer hit an unexpected error.' ($_.Exception.Message)
}
