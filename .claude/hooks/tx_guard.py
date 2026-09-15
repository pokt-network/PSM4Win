"""PreToolUse guard for Claude Code sessions in this repo.

Blocks shell commands that could expose the Service Manager wallet key or
bypass the signer. The app's main-process signer (src/main/signer) and, during
the transition, the HTA in reference/hta-app are the only sanctioned paths to
the keyring; Claude sessions must never export the key, read the sealed
passphrase (the HTA's DPAPI file or this app's safeStorage file), touch the
keyring volume directly, or move funds.

Exit 2 with a message on stderr blocks the tool call. Exit 0 allows it.
Standard library only.
"""
import json
import re
import sys

BLOCKED = [
    (r"keys\s+export", "exports a private key from a pocketd keyring"),
    (r"--unarmored-hex", "exports a raw private key"),
    (r"--unsafe\b", "enables unsafe pocketd key operations"),
    (r"import-hex", "imports a private key; only the Service Manager app may do this"),
    (r"PSM_IMPORT_KEY", "carries the wallet private key"),
    (r"wallet-export|wallet-delete|wallet-import|wallet-create|wallet-recover|wallet-remove|tx-fund-wallet|relay-call", "is a signer wallet operation reserved for the Service Manager app"),
    (r"PSM_IMPORT_MNEMONIC|PSM_STDIN", "carries a secret into the signer's child process"),
    (r"keyring\.pass", "reads or writes the sealed keyring passphrase"),
    (r"pocket-service-manager-keyring", "touches the keyring Docker volume directly"),
    (r"ConvertTo-SecureString", "unseals DPAPI secrets"),
    (r"safeStorage\.decrypt", "unseals the app's keyring passphrase outside the signer"),
    (r"ProtectedData\]?::Unprotect", "unseals DPAPI secrets"),
    (r"\bmnemonic\b", "handles a seed phrase"),
    (r"tx\s+bank\s+send", "moves funds"),
    (r"keys\s+show\b", "reads keyring entries; use the Service Manager app instead"),
]


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        return 0
    tool_input = data.get("tool_input") or {}
    cmd = tool_input.get("command") or ""
    for pattern, why in BLOCKED:
        if re.search(pattern, cmd, re.IGNORECASE):
            sys.stderr.write(
                "Blocked by .claude/hooks/tx_guard.py: this command %s. "
                "Wallet key operations and transactions go through the Pocket Service Manager app's "
                "signer (src/main/signer), never through a Claude session.\n" % why
            )
            return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
