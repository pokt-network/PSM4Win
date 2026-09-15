# Pocket Service Manager

A Windows desktop app for registering, staking, supplying, deploying, and testing HTTP services on Pocket Network's Shannon protocol, without typing `pocketd` commands. It performs every transaction and every signature; the assistant-side tooling (the Pocket Service Builder MCP server and Claude Skill) is read-only and hands the work to this app.

## Install

Docker Desktop is required: [download](https://www.docker.com/products/docker-desktop/) or `winget install Docker.DockerDesktop`.

```powershell
irm get.scoop.sh | iex                                        # once, if Scoop is not installed
scoop bucket add pocket https://github.com/<org>/<repo>       # once
scoop install pocket-service-manager
scoop update pocket-service-manager                           # every later version
```

An installer is also on the releases page for anyone who prefers it. Unsigned builds show a SmartScreen warning when downloaded from a browser and not when installed through Scoop.

## Status

Phase 1 (platform layer) is built: the main-process signer with the same named operations as the original HTML Application, typed IPC, the Docker and SSH drivers, the same-PC importer, the installer configuration, and CI. Phase 2 (the React screens) is built and awaits the screen-by-screen parity check against the HTA on the same keyring. See `CLAUDE.md` for the plan.

## Development

```powershell
npm install
npm run dev            # electron-vite with hot reload
npm test               # vitest, src/core
npm run typecheck
npm run selftest:beta  # the phase 1 exit check against Beta TestNet (needs Docker Desktop)
npm run build:win      # NSIS installer and portable zip under release/
```
