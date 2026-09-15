"""Shared helpers for the pocket-service-builder scripts. Standard library only."""
import json
import sys
import urllib.request
import urllib.error

LCD = {
    "beta": "https://sauron-api.beta.infra.pocket.network",
    "main": "https://sauron-api.infra.pocket.network",
}
CHAIN_ID = {"beta": "pocket-lego-testnet", "main": "pocket"}
EXPLORER = {
    "beta": "https://explorer.pocket.network/beta",
    "main": "https://explorer.pocket.network",
}


def lcd_base(network):
    if network not in LCD:
        die(f"unknown network {network!r}; use 'beta' or 'main'")
    return LCD[network]


def get(url, timeout=30):
    """GET a URL and parse JSON. Returns (data, None) or (None, error_string)."""
    try:
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8")), None
    except urllib.error.HTTPError as e:
        return None, f"HTTP {e.code} for {url}"
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        return None, f"{type(e).__name__}: {e} for {url}"
    except json.JSONDecodeError as e:
        return None, f"bad JSON from {url}: {e}"


def get_all_services(network, timeout=60):
    """Return the full service list (with metadata) for a network, or exit on error."""
    url = f"{lcd_base(network)}/pokt-network/poktroll/service/service?pagination.limit=2000"
    data, err = get(url, timeout)
    if err:
        die(f"could not read the service catalog: {err}")
    return data.get("service", [])


def params(network, module):
    """Fetch one module's params block, or exit on error."""
    url = f"{lcd_base(network)}/pokt-network/poktroll/{module}/params"
    data, err = get(url)
    if err:
        die(f"could not read {module} params: {err}")
    return data.get("params", {})


def upokt_to_pokt(amount):
    return int(amount) / 1_000_000


def die(msg, code=1):
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(code)


def note_live_values():
    return (
        "Values above were fetched live just now. They are governance parameters "
        "and change; re-run before relying on them."
    )
