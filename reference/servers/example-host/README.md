# example-host: the supplier host

The Service Manager provisions and updates this layout itself (Settings, Provision; Services, Deploy). The live helper on the server is `supplier.sh`, shipped from `tools/service-manager/server/` into each stack directory; the files here are the reference copy of what runs on the example host and the record of the migrations.

A server is network-agnostic: an SSH connection, Docker, a deploy root for backends, and one shared Caddy. What is per network is the supplier stack: a RelayMiner (redis + miner + relayer) in its own directory with its own operator key, compose project, loopback ports, and public hostname, because the chain ID, node URLs, and stake are per network. Services are backends that join the shared `pocket-supplier` network once and are served by whichever relayers list them.

| On the server | What |
|---|---|
| `/opt/pocket/supplier/` | The **Beta TestNet** stack (compose project `pocket-supplier`, kept from the first layout so its containers and Redis volume were reused): `docker-compose.yaml`, `stack.env`, `relayer-config.yaml`, `miner-config.yaml`, the operator keyring in `pocket-home/`, the operator key backup, and `supplier-keys.yaml` for the RelayMiner. Public hostname `services-beta.example.org`. |
| `/opt/pocket/supplier-main/` | The **MainNet** stack (project `pocket-supplier-main`, ports 8082/9091/9093), same layout, its own operator key. Public hostname `services.example.org`. |
| `/opt/pocket/caddy/` | The shared Caddy (project `pocket-caddy`): `docker-compose.yaml`, a `Caddyfile` that imports `sites/*.caddy`, and one site file per network mapping its hostname to that stack's relayer container. Certificates live in the `pocket-caddy_data` volume. |
| `/opt/pocket/services/<id>/` | One folder per service: `backend/` and `deploy/docker-compose.yaml`, which starts only the backend container on the `pocket-supplier` network. |

Redis and the miner of each stack sit on that stack's private network (`<project>_internal`), so two stacks never see each other's Redis; only the relayer joins the shared network, where Caddy reaches it by container name and it reaches the backends.

## Files here

| File | Role |
|---|---|
| `supplier-beta/docker-compose.yaml`, `stack.env` | The Beta stack as rendered by the app. |
| `supplier-beta/relayer-config.yaml` | One `services:` entry per service, pointing at `http://<id>-backend:8080`. |
| `supplier-beta/miner-config.yaml` | Claim and proof submission; Beta block time 30 s. |
| `caddy/docker-compose.yaml`, `caddy/Caddyfile`, `caddy/sites/*.caddy` | The shared Caddy and its site files. |
| `provision-operator.sh`, `provision-ha-keys.sh`, `fund-operator.sh`, `migrate-from-service-folder.sh` | The hand-run scripts from before the app did this; kept as history. |

Secrets never leave the server: `pocket-home/`, `operator-key.json`, and `supplier-keys.yaml` are in `.gitignore`.

## Migrations

- **2026-09-14, one stack per server:** the first service's per-service stack was moved to `/opt/pocket/supplier/` (`migrate-from-service-folder.sh`). Old volumes `example-builder-test_*` were kept for rollback.
- **2026-09-14, one stack per network:** Caddy moved out of the Beta stack into `/opt/pocket/caddy/` (certificates copied from `pocket-supplier_caddy_data`), the stack's Redis moved to a private network, and the Beta hostname became `services-beta.example.org` so that `services.example.org` could become MainNet's. Until the Beta restake with the new URL activated, `sites/legacy-services.caddy` aliased the old hostname to the Beta relayer; provisioning MainNet retires that file.

## Adding a service to a supplier here

Use the app: Deploy service (ships and starts the backend once, adds it to the current network's relayer), then Suppliers, Manage (re-stakes that network's supplier with the service in its list). By hand the same three steps are: `docker compose -p <id> -f /opt/pocket/services/<id>/deploy/docker-compose.yaml up -d --build`; add a `services:` entry to that stack's `relayer-config.yaml` and `docker compose -p <project> up -d --force-recreate relayer` in the stack directory; re-stake with `supplier_stake.yaml` signed by that stack's operator key.

## The Service Manager's server entry

Name `example-host`, host `<server IP>`, port 22, user `<ssh user>`, key `~/.ssh/<key file>`, deploy root `/opt/pocket/services`. Beta stack: directory `/opt/pocket/supplier`, project `pocket-supplier`, operator `pokt1qgpqyqszqgpqyqszqgpqyqszqgpqyqsz73c06j`, URL `https://services-beta.example.org`. MainNet stack: directory `/opt/pocket/supplier-main`, URL `https://services.example.org`, operator created by Provision.
(Connection details removed from this public copy.)
