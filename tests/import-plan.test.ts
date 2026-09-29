import { describe, it, expect } from 'vitest'
import { parseSurvey } from '@core/survey'
import { planImport, isAppContainer } from '@core/import'

const OP = 'pokt1' + 'a'.repeat(38)
const OTHER = 'pokt1' + 'b'.repeat(38)
const URL = 'https://services.example.org'
const base = (extra: string): string =>
  `survey: 1\nhost: h\nos: Ubuntu 24.04\nsudo: yes\npython3: yes\nmemory_mb: 7900\ndocker: 29.1.3\n${extra}\ndone\n`

// A standard hand-made HA setup: relayer, miner, redis and the backend in one compose
// project, Caddy in front serving only the supplier's hostname, the key in a keys file.
const STANDARD =
  base(`container: name=supplier-relayer-1 role=relayer image=ghcr.io/pokt-network/pocket-relay-miner:v0.1.0 project=supplier dir=/opt/supplier ports=
networks: container=supplier-relayer-1 nets=supplier_default=relayer,abc123;
container: name=supplier-miner-1 role=miner image=ghcr.io/pokt-network/pocket-relay-miner:v0.1.0 project=supplier dir=/opt/supplier ports=
networks: container=supplier-miner-1 nets=supplier_default=miner;
container: name=supplier-redis-1 role=redis image=redis:8.10.1-alpine project=supplier dir=/opt/supplier ports=
container: name=supplier-charts-1 role=other image=charts:1 project=supplier dir=/opt/supplier ports=
networks: container=supplier-charts-1 nets=supplier_default=charts,def456;
container: name=caddy role=caddy image=caddy:2 project=proxy dir=/opt/proxy ports=443/tcp->0.0.0.0:443,80/tcp->0.0.0.0:80
listen: port=443 process=docker-proxy
listen: port=80 process=docker-proxy
site: proxy=caddy host=services.example.org file=/opt/proxy/Caddyfile
service: id=example-charts backend=http://charts:8080 config=/opt/supplier/relayer.yaml
keysfile: path=/opt/supplier/supplier-keys.yaml address=${OP} match=yes
keyring: dir=/root/.pocket/keyring-test backend=test address=${OTHER} match=no`)

describe('import plan', () => {
  it('a standard setup imports: key from the keys file, backend by alias, stop relayer, miner, proxy', () => {
    const p = planImport(parseSurvey(STANDARD), {
      operator: OP,
      stakedUrl: URL,
      hasAppStack: false
    })
    expect(p.blockers).toEqual([])
    expect(p.key).toEqual({ kind: 'keysfile', path: '/opt/supplier/supplier-keys.yaml' })
    expect(p.backends).toEqual([
      {
        service: 'example-charts',
        theirs: 'http://charts:8080',
        container: 'supplier-charts-1',
        url: 'http://supplier-charts-1:8080',
        problem: null
      }
    ])
    expect(p.stop.map((t) => `${t.role}:${t.name}`)).toEqual([
      'relayer:supplier-relayer-1',
      'miner:supplier-miner-1',
      'proxy:caddy'
    ])
  })

  it('refuses when their proxy serves other sites, and leaves it running', () => {
    const p = planImport(
      parseSurvey(
        STANDARD.replace(
          'done\n',
          'site: proxy=caddy host=blog.example.org file=/opt/proxy/Caddyfile\ndone\n'
        )
      ),
      { operator: OP, stakedUrl: URL, hasAppStack: false }
    )
    expect(p.blockers.join(' ')).toMatch(/also serves blog\.example\.org/)
    expect(p.stop.some((t) => t.role === 'proxy')).toBe(false)
  })

  it('a staked port does not count the supplier hostname as another site', () => {
    const p = planImport(
      parseSurvey(STANDARD.replace('host=services.example.org', 'host=services.example.org:8445')),
      { operator: OP, stakedUrl: 'https://services.example.org:8445', hasAppStack: false }
    )
    expect(p.blockers).toEqual([])
  })

  it('does not guess between containers that share an alias', () => {
    const shared = STANDARD.replace(
      'done\n',
      'container: name=supplier-other-1 role=other image=other:1 project=supplier dir=/opt/supplier ports=\nnetworks: container=supplier-other-1 nets=supplier_default=charts;\ndone\n'
    )
    const p = planImport(parseSurvey(shared), { operator: OP, stakedUrl: URL, hasAppStack: false })
    expect(p.backends[0].container).toBeNull()
    expect(p.backends[0].problem).toMatch(/Several containers answer to charts/)
  })

  it('refuses a backend that runs on the server itself', () => {
    const p = planImport(
      parseSurvey(STANDARD.replace('backend=http://charts:8080', 'backend=http://127.0.0.1:3000')),
      { operator: OP, stakedUrl: URL, hasAppStack: false }
    )
    expect(p.backends[0].problem).toMatch(/runs on the server itself/)
    expect(p.blockers.join(' ')).toMatch(/example-charts: .*Put the backend in Docker/)
  })

  it('the legacy relayminer under systemd, behind the server nginx, key in a test keyring', () => {
    const p = planImport(
      parseSurvey(
        base(`process: pid=812 user=pokt args=/usr/local/bin/pocketd relayminer start --config /home/pokt/relayminer.yaml
unit: name=relayminer.service active=active exec=/usr/local/bin/pocketd relayminer start --config /home/pokt/relayminer.yaml
listen: port=443 process=nginx
listen: port=80 process=nginx
site: proxy=nginx host=services.example.org file=/etc/nginx/sites-enabled/supplier
service: id=example-charts backend=http://charts:8080 config=/home/pokt/relayminer.yaml
container: name=charts role=other image=charts:1 project= dir= ports=8080/tcp->127.0.0.1:8080
networks: container=charts nets=bridge=;
keyring: dir=/home/pokt/.pocket/keyring-test backend=test address=${OP} match=yes`)
      ),
      { operator: OP, stakedUrl: URL, hasAppStack: false }
    )
    expect(p.blockers).toEqual([])
    expect(p.key).toEqual({ kind: 'keyring', path: '/home/pokt/.pocket' })
    expect(p.backends[0].container).toBe('charts')
    expect(p.stop).toEqual([
      { kind: 'unit', name: 'relayminer.service', role: 'legacy-relayminer' },
      { kind: 'unit', name: 'nginx.service', role: 'proxy' }
    ])
    expect(p.notes.join(' ')).toMatch(/legacy pocketd relayminer/)
  })

  it('a key in a passphrase keyring, or nowhere, is pasted instead', () => {
    const withFile = STANDARD.replace(/keysfile: .*\n/, '').replace(
      `address=${OTHER} match=no`,
      `address=${OP} match=yes`
    )
    const fileRing = withFile.replace('keyring-test backend=test', 'keyring-file backend=file')
    expect(
      planImport(parseSurvey(fileRing), { operator: OP, stakedUrl: URL, hasAppStack: false }).key
    ).toBeNull()
    const none = STANDARD.replace(/keysfile: .*\n/, '')
    const p = planImport(parseSurvey(none), { operator: OP, stakedUrl: URL, hasAppStack: false })
    expect(p.key).toBeNull()
    expect(p.notes.join(' ')).toMatch(/pasted into the app/)
  })

  it('refuses a RelayMiner started by hand, a server with an app stack, and missing sudo', () => {
    const loose = STANDARD.replace(
      'done\n',
      'process: pid=99 user=root args=/opt/bin/pocket-relay-miner relayer --config /x.yaml\ndone\n'
    ).replace('sudo: yes', 'sudo: no')
    const p = planImport(parseSurvey(loose), { operator: OP, stakedUrl: URL, hasAppStack: true })
    const all = p.blockers.join(' ')
    expect(all).toMatch(/outside Docker and systemd \(process 99\)/)
    expect(all).toMatch(/already has a stack from the app/)
    expect(all).toMatch(/passwordless sudo/)
  })

  it('never stops or attaches the app’s own containers', () => {
    expect(isAppContainer('pocket-supplier-beta-relayer')).toBe(true)
    expect(isAppContainer('pocket-supplier-relayer')).toBe(true)
    expect(isAppContainer('pocket-caddy')).toBe(true)
    expect(isAppContainer('supplier-relayer-1')).toBe(false)
    const withApp = STANDARD.replace(
      'done\n',
      'container: name=pocket-supplier-main-relayer role=relayer image=ghcr.io/pokt-network/pocket-relay-miner:v0.1.0 project=pocket-supplier-main dir=/opt/pocket/supplier-main ports=\ndone\n'
    )
    const p = planImport(parseSurvey(withApp), { operator: OP, stakedUrl: URL, hasAppStack: false })
    expect(p.stop.map((t) => t.name)).not.toContain('pocket-supplier-main-relayer')
  })
})
