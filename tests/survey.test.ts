import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildSurveyScript, parseSurvey, judgeSurvey, SURVEY_ADDRESS_MARK } from '@core/survey'

const dir = join(process.cwd(), 'resources', 'server')
const OP = 'pokt1' + 'a'.repeat(38)
const OTHER = 'pokt1' + 'b'.repeat(38)

// What survey.sh prints on a server running the HA RelayMiner by hand behind Caddy.
const HA = `survey: 1
host: example-host
os: Ubuntu 24.04.3 LTS
sudo: yes
python3: yes
memory_mb: 7940
docker: 29.1.3
container: name=relayer role=relayer image=ghcr.io/pokt-network/pocket-relay-miner:v0.1.0 project=supplier dir=/opt/supplier ports=8080/tcp->0.0.0.0:8080
container: name=miner role=miner image=ghcr.io/pokt-network/pocket-relay-miner:v0.1.0 project=supplier dir=/opt/supplier ports=
container: name=caddy role=caddy image=caddy:2 project=proxy dir=/opt/proxy ports=443/tcp->0.0.0.0:443,80/tcp->0.0.0.0:80
config: from=container:relayer role=relayer path=/opt/supplier/relayer.yaml
proxyconf: proxy=caddy where=container:caddy path=/opt/proxy/Caddyfile
listen: port=443 process=docker-proxy
listen: port=80 process=docker-proxy
keysource: kind=file path=/keys/supplier-keys.yaml config=/opt/supplier/relayer.yaml
service: id=example-charts backend=http://charts:8080 config=/opt/supplier/relayer.yaml
service: id=example-charts backend=http://charts:8080 config=/opt/supplier/miner.yaml
setting: query_node_grpc_url=sauron-grpc.infra.pocket.network:443 config=/opt/supplier/relayer.yaml
keyring: dir=/root/.pocket/keyring-test backend=test address=${OTHER} match=no
keysfile: path=/opt/supplier/supplier-keys.yaml address=${OP} match=yes
done
`

describe('server survey', () => {
  it('assembles the script with the address code in place', () => {
    const sh = readFileSync(join(dir, 'survey.sh'), 'utf8')
    const py = readFileSync(join(dir, 'survey_address.py'), 'utf8')
    expect(sh).toContain(SURVEY_ADDRESS_MARK)
    const s = buildSurveyScript(sh, py)
    expect(s).not.toContain(SURVEY_ADDRESS_MARK)
    expect(s).toContain('def address_from_hex')
    expect(s).not.toContain('\r')
    expect(() => buildSurveyScript('no mark here', py)).toThrow()
    expect(() => buildSurveyScript(SURVEY_ADDRESS_MARK, 'x = 1\nPY\ny = 2')).toThrow()
  })
  it('reads what the script prints', () => {
    const r = parseSurvey(HA)
    expect(r.complete).toBe(true)
    expect(r.partial).toBe(false)
    expect(r.docker).toBe('29.1.3')
    expect(r.memoryMb).toBe(7940)
    expect(r.containers.map((c) => c.role)).toEqual(['relayer', 'miner', 'caddy'])
    expect(r.containers[2].ports).toBe('443/tcp->0.0.0.0:443,80/tcp->0.0.0.0:80')
    expect(r.services).toHaveLength(2)
    expect(r.keysFiles).toEqual([
      { path: '/opt/supplier/supplier-keys.yaml', address: OP, match: true }
    ])
    expect(r.keyrings[0].match).toBe(false)
    expect(r.settings[0]).toEqual({
      key: 'query_node_grpc_url',
      value: 'sauron-grpc.infra.pocket.network:443',
      config: '/opt/supplier/relayer.yaml'
    })
  })
  it('keeps a whole command line in process and unit lines', () => {
    const r = parseSurvey(
      'process: pid=12 user=pokt args=/usr/bin/pocketd relayminer start --config /home/pokt/relayminer.yaml --home /home/pokt/.pocket\nunit: name=relayminer.service active=active exec=/usr/bin/pocketd relayminer start\ndone'
    )
    expect(r.processes[0].args).toBe(
      '/usr/bin/pocketd relayminer start --config /home/pokt/relayminer.yaml --home /home/pokt/.pocket'
    )
    expect(r.units[0]).toEqual({
      name: 'relayminer.service',
      active: 'active',
      exec: '/usr/bin/pocketd relayminer start'
    })
  })
  it('judges an HA setup with the key in a keys file', () => {
    const v = judgeSurvey(parseSurvey(HA))
    expect(v.relayMiner).toEqual(['ha'])
    expect(v.operatorKey).toEqual({ kind: 'keysfile', where: '/opt/supplier/supplier-keys.yaml' })
    expect(v.services).toEqual([{ id: 'example-charts', backend: 'http://charts:8080' }])
    expect(v.webPorts.map((p) => p.port).sort()).toEqual([443, 80])
    expect(v.notes).toEqual([])
  })
  it('says what stands in the way', () => {
    const v = judgeSurvey(
      parseSurvey(
        'survey: 1\ndocker: unreachable\nprocess: pid=3 user=root args=pocketd relayminer --config /r.yaml\ndone: partial (no python3 to read configs and keys)'
      )
    )
    expect(v.relayMiner).toEqual(['legacy'])
    expect(v.operatorKey).toBeNull()
    expect(v.notes.join(' ')).toMatch(/no python3/)
    expect(v.notes.join(' ')).toMatch(/docker group/)
    expect(v.notes.join(' ')).toMatch(/legacy pocketd relayminer/)
    expect(judgeSurvey(parseSurvey('survey: 1\n')).notes[0]).toMatch(/did not finish/)
  })
})
