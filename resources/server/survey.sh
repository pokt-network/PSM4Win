#!/usr/bin/env bash
# Pocket Service Manager: a read-only survey of a server whose supplier was set up by
# hand, run over SSH before importing it (server-survey). It changes nothing and prints
# no secret: names, paths, addresses, and backend URLs (credentials stripped), one fact
# per line, for the app to read.
#
#   survey.sh [<operator address>]
#
# With an operator address, every keyring and keys file found is marked match=yes or
# match=no for it. A keyring is matched by the <hex>.address files it keeps, so no key is
# read. A keys file is matched by deriving each key's address in Python on this server:
# the file reaches Python through a pipe, and only the address is printed.
set -u
OP="${1:-}"
S=""
sudo -n true >/dev/null 2>&1 && S="sudo -n"
DK="docker"
if command -v docker >/dev/null 2>&1 && ! docker ps >/dev/null 2>&1 && [ -n "$S" ]; then DK="$S docker"; fi
say() { printf '%s\n' "$*"; }
# Reads a file as this user, or with sudo when only root may.
rd() { if [ -r "$1" ]; then cat -- "$1"; elif [ -n "$S" ]; then $S cat -- "$1"; fi; }
PY=""
command -v python3 >/dev/null 2>&1 && PY="python3"

say "survey: 1"
say "host: $(hostname 2>/dev/null)"
say "os: $(. /etc/os-release 2>/dev/null && printf '%s' "${PRETTY_NAME:-unknown}")"
say "sudo: $([ -n "$S" ] && echo yes || echo no)"
say "python3: $([ -n "$PY" ] && echo yes || echo no)"
say "memory_mb: $(awk '/^MemTotal:/ {print int($2/1024)}' /proc/meminfo 2>/dev/null)"
if ! command -v docker >/dev/null 2>&1; then
  say "docker: none"
elif ! $DK ps >/dev/null 2>&1; then
  say "docker: unreachable"
else
  say "docker: $($DK version --format '{{.Server.Version}}' 2>/dev/null)"
fi

CONFIGS=$(mktemp)
KEYDIRS=$(mktemp)
KEYFILES=$(mktemp)
trap 'rm -f "$CONFIGS" "$KEYDIRS" "$KEYFILES"' EXIT

# ---- containers ----
if $DK ps >/dev/null 2>&1; then
  $DK ps --format '{{.ID}}' | while read -r id; do
    info=$($DK inspect --format '{{.Name}}|{{.Config.Image}}|{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$id" 2>/dev/null) || continue
    name=${info%%|*}; name=${name#/}; rest=${info#*|}
    image=${rest%%|*}; rest=${rest#*|}; project=${rest%%|*}; wd=${rest#*|}
    args=$($DK inspect --format '{{join .Config.Entrypoint " "}} {{join .Config.Cmd " "}}' "$id" 2>/dev/null)
    ports=$($DK port "$id" 2>/dev/null | sed 's/ -> /->/' | tr '\n' ',' | sed 's/,$//')
    role=other
    case "$image $args" in
      *pocket-relay-miner*relayer*|*relay-miner*" relayer"*) role=relayer ;;
      *pocket-relay-miner*miner*) role=miner ;;
      *pocket-relay-miner*) role=relayminer ;;
      *pocketd*relayminer*) role=legacy-relayminer ;;
      *caddy*) role=caddy ;;
      *nginx*) role=nginx ;;
      *traefik*) role=traefik ;;
      *haproxy*) role=haproxy ;;
      *redis*) role=redis ;;
    esac
    say "container: name=$name role=$role image=$image project=$project dir=$wd ports=$ports"
    case "$role" in
      relayer|miner|relayminer|legacy-relayminer)
        # The --config path inside the container, mapped back to the file on this server.
        cfg=$(printf '%s\n' "$args" | tr ' ' '\n' | grep -A1 -x -e '--config' | tail -1)
        [ -n "$cfg" ] || cfg=$(printf '%s\n' "$args" | tr ' ' '\n' | sed -n 's/^--config=//p' | head -1)
        mounts=$($DK inspect --format '{{range .Mounts}}{{.Source}}|{{.Destination}}{{"\n"}}{{end}}' "$id" 2>/dev/null)
        host=""
        while IFS='|' read -r src dst; do
          [ -n "$dst" ] || continue
          case "$cfg" in "$dst") host="$src" ;; "$dst"/*) host="$src${cfg#"$dst"}" ;; esac
          # Keys files and keyrings mounted into the container.
          case "$dst" in
            *.yaml|*.yml|*.json) case "$dst" in *key*) printf '%s\n' "$src" >>"$KEYFILES" ;; esac ;;
            *key*|*.pocket*|*home*) printf '%s\n' "$src" >>"$KEYDIRS" ;;
          esac
        done <<<"$mounts"
        [ -n "$host" ] && printf '%s|%s|%s\n' "$role" "$host" "$name" >>"$CONFIGS"
        say "config: from=container:$name role=$role path=${host:-unmapped:$cfg}"
        ;;
      caddy|nginx|traefik|haproxy)
        $DK inspect --format '{{range .Mounts}}{{.Source}}|{{.Destination}}{{"\n"}}{{end}}' "$id" 2>/dev/null |
          while IFS='|' read -r src dst; do
            case "$dst" in /etc/caddy*|/etc/nginx*) say "proxyconf: proxy=$role where=container:$name path=$src" ;; esac
          done
        ;;
    esac
  done
fi

# ---- processes and services outside Docker ----
ps -eo pid=,user=,args= 2>/dev/null | grep -E 'pocket-relay-miner|pocketd[^ ]* .*relayminer' | grep -v -e grep -e 'docker ' |
  while read -r pid user args; do
    # A process inside a container shows here too; the containers are reported above.
    grep -qE 'docker|containerd|kubepods|libpod' "/proc/$pid/cgroup" 2>/dev/null && continue
    say "process: pid=$pid user=$user args=$(printf '%s' "$args" | cut -c1-200)"
    cfg=$(printf '%s\n' "$args" | tr ' ' '\n' | grep -A1 -x -e '--config' | tail -1)
    role=legacy-relayminer
    case "$args" in *pocket-relay-miner*relayer*) role=relayer ;; *pocket-relay-miner*miner*) role=miner ;; esac
    [ -n "$cfg" ] && printf '%s|%s|%s\n' "$role" "$cfg" "pid:$pid" >>"$CONFIGS" && say "config: from=process:$pid role=$role path=$cfg"
    home=$(printf '%s\n' "$args" | tr ' ' '\n' | grep -A1 -x -e '--home' | tail -1)
    [ -n "$home" ] && printf '%s\n' "$home" >>"$KEYDIRS"
  done
if command -v systemctl >/dev/null 2>&1; then
  systemctl list-units --type=service --all --no-legend --plain 2>/dev/null | awk '{print $1, $3, $4}' |
    grep -Ei 'relay|pocket|pokt' | while read -r unit load active; do
      say "unit: name=$unit active=$active exec=$(systemctl show -p ExecStart --value "$unit" 2>/dev/null | sed -n 's/.*argv\[\]=\([^;]*\).*/\1/p' | head -1 | cut -c1-200)"
    done
fi

# ---- who holds the web ports ----
if command -v ss >/dev/null 2>&1; then
  $S ss -ltnpH 2>/dev/null | awk '{print $4, $6}' | while read -r addr proc; do
    port=${addr##*:}
    case "$port" in 80|443|8080|8443|8445) say "listen: port=$port process=$(printf '%s' "$proc" | sed -n 's/.*(("\([^"]*\)".*/\1/p')" ;; esac
  done | sort -u
fi
for f in /etc/caddy/Caddyfile /etc/nginx/nginx.conf; do [ -e "$f" ] && say "proxyconf: proxy=$(basename "$(dirname "$f")") where=host path=$f"; done

# ---- keyrings and keys files in the usual places ----
for d in /root/.pocket /home/*/.pocket /opt/*/pocket-home /opt/*/*/pocket-home /var/lib/*/.pocket; do
  printf '%s\n' "$d" >>"$KEYDIRS"
done
for f in /opt/*/supplier-keys.yaml /opt/*/*/supplier-keys.yaml /root/*/supplier-keys.yaml /home/*/*/supplier-keys.yaml /home/*/supplier-keys.yaml; do
  printf '%s\n' "$f" >>"$KEYFILES"
done

[ -n "$PY" ] || { say "done: partial (no python3 to read configs and keys)"; exit 0; }

# The configs name their keys file or keyring and list each service's backend. The
# program goes in a file so the config itself can reach Python on stdin.
CFG_PY=$(mktemp)
trap 'rm -f "$CONFIGS" "$KEYDIRS" "$KEYFILES" "$CFG_PY"' EXIT
cat >"$CFG_PY" <<'PY'
import re, sys
role, path, frm = sys.argv[1:4]
t = sys.stdin.read()
def clean(u):
    return re.sub(r'//[^/@\s]*@', '//', u.strip().strip('"\''))
for m in re.finditer(r'^\s*keys_file:\s*"?([^"\s#]+)', t, re.M):
    print('keysource: kind=file path=%s config=%s' % (m.group(1), path))
for m in re.finditer(r'^\s*(?:keyring_dir|home|keyring_home):\s*"?([^"\s#]+)', t, re.M):
    print('keysource: kind=keyring dir=%s config=%s' % (m.group(1), path))
for m in re.finditer(r'^\s*signing_key_names?:\s*\[?\s*"?([^"\s\]#]+)', t, re.M):
    print('keysource: kind=keyname name=%s config=%s' % (m.group(1), path))
# HA relayer: services: <id>: ... url: <backend>
sv = re.search(r'^services:\s*\n((?:[ \t]+.*\n|\s*\n)*)', t, re.M)
if sv:
    for m in re.finditer(r'^  ([A-Za-z0-9_-]+):\s*\n((?:    .*\n|\s*\n)*)', sv.group(1), re.M):
        u = re.search(r'^\s+url:\s*(\S+)', m.group(2), re.M)
        print('service: id=%s backend=%s config=%s' % (m.group(1), clean(u.group(1)) if u else '', path))
# Legacy relayminer: suppliers: - service_id: <id> ... backend_url: <backend>
for m in re.finditer(r'service_id:\s*"?([A-Za-z0-9_-]+)"?((?:(?!service_id:)[\s\S])*?)backend_url:\s*(\S+)', t):
    print('service: id=%s backend=%s config=%s' % (m.group(1), clean(m.group(3)), path))
for m in re.finditer(r'^\s*(listen_addr|listen_url|query_node_grpc_url|query_node_rpc_url|chain_id):\s*"?([^"\s#]+)', t, re.M):
    print('setting: %s=%s config=%s' % (m.group(1), m.group(2), path))
PY
sort -u "$CONFIGS" | while IFS='|' read -r role path from; do
  rd "$path" | $PY "$CFG_PY" "$role" "$path" "$from" 2>/dev/null
done

# Keyrings: each <hex>.address file names an address the keyring holds. No key is read.
sort -u "$KEYDIRS" | while read -r d; do
  [ -n "$d" ] || continue
  for kd in "$d" "$d"/keyring-*; do
    [ -d "$kd" ] || { [ -n "$S" ] && $S test -d "$kd"; } || continue
    case "$kd" in */keyring-*) ;; *) continue ;; esac
    backend=${kd##*/keyring-}
    { ls -1 "$kd" 2>/dev/null || $S ls -1 "$kd" 2>/dev/null; } | sed -n 's/^\([0-9a-fA-F]\{40\}\)\.address$/\1/p' |
      $PY -c '
import sys
CH = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
def pm(v):
    g = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]; c = 1
    for x in v:
        b = c >> 25; c = ((c & 0x1ffffff) << 5) ^ x
        for i in range(5): c ^= g[i] if ((b >> i) & 1) else 0
    return c
def enc(raw, hrp="pokt"):
    acc, bits, out = 0, 0, []
    for b in raw:
        acc = (acc << 8) | b; bits += 8
        while bits >= 5: bits -= 5; out.append((acc >> bits) & 31)
    if bits: out.append((acc << (5 - bits)) & 31)
    hx = [ord(c) >> 5 for c in hrp] + [0] + [ord(c) & 31 for c in hrp]
    p = pm(hx + out + [0] * 6) ^ 1
    return hrp + "1" + "".join(CH[d] for d in out + [(p >> 5 * (5 - i)) & 31 for i in range(6)])
op, kd, be = sys.argv[1:4]
for line in sys.stdin:
    a = enc(bytes.fromhex(line.strip()))
    print("keyring: dir=%s backend=%s address=%s match=%s" % (kd, be, a, ("yes" if a == op else "no") if op else "-"))
' "$OP" "$kd" "$backend"
  done
done

# Keys files: the address of each key, derived here. The file goes to Python through a
# pipe; the key is never printed, written, or passed as an argument.
ADDR_PY=$(mktemp)
trap 'rm -f "$CONFIGS" "$KEYDIRS" "$KEYFILES" "$CFG_PY" "$ADDR_PY"' EXIT
cat >"$ADDR_PY" <<'PY'
@@ADDRESS_PY@@
PY
{
  sort -u "$KEYFILES"
  sort -u "$CONFIGS" | while IFS='|' read -r _ path _; do
    rd "$path" | sed -n 's/^[[:space:]]*keys_file:[[:space:]]*"\{0,1\}\([^"[:space:]#]*\).*/\1/p'
  done
} | sort -u | while read -r f; do
  [ -n "$f" ] || continue
  [ -e "$f" ] || { [ -n "$S" ] && $S test -e "$f"; } || continue
  rd "$f" | $PY "$ADDR_PY" keysfile "$f" "$OP"
done
say "done"
