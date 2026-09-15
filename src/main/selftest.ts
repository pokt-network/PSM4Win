// Phase 1 exit criterion: `npm run selftest:beta`. Runs the signer without the
// renderer against Beta TestNet, exercising every read-only path, the wallet
// lifecycle with a throwaway application wallet, and every transaction as a dry
// run. Nothing is signed or broadcast. Prints a table and writes selftest.txt
// to the data folder. Refuses any network other than beta.
import { app } from 'electron'
import { join } from 'node:path'
import { signer } from './signer'
import { detectHta, importFromHta } from './migration/importer'
import { hasSealedPassphrase } from './signer/passphrase'
import { readSettings } from './state/settings'
import { readJson, writeText, exists } from './state/files'
import { dataFiles, htaFiles } from './paths'
import { balanceUpokt, latestBlock, params, gateways, upoktToPokt } from '@core/lcd'
import { RE } from '@core/validate'
import { OWNER_KEY_NAME } from '@core/versions'
import type { WalletRecord } from '@core/contract'

interface Row {
  step: string
  ok: boolean | null
  note: string
}

export async function runSelfTest(network: string): Promise<number> {
  if (network !== 'beta') {
    console.error('The self-test runs on Beta TestNet only.')
    return 2
  }
  const rows: Row[] = []
  const add = (step: string, ok: boolean | null, note = ''): void => {
    rows.push({ step, ok, note })
    console.log(
      `${ok === null ? 'SKIP' : ok ? 'PASS' : 'FAIL'}  ${step}${note ? '  -  ' + note : ''}`
    )
  }
  const started = Date.now()
  console.log(`Pocket Service Manager self-test (beta)  ${new Date().toISOString()}`)
  console.log(`data folder: ${dataFiles.settings().replace(/[\\/]settings\.json$/, '')}`)

  // 1. Docker.
  let dc = await signer.run('docker-check', {})
  if (dc.ok && !dc.image) {
    console.log(`      pinned image missing; downloading it first`)
    const pull = await signer.run('image-pull', {})
    add(
      'image-pull',
      pull.ok,
      pull.ok ? `pocketd ${pull.pocketd}` : (pull as { error: string }).error
    )
    dc = await signer.run('docker-check', {})
  }
  add(
    'docker-check',
    dc.ok && !!dc.image,
    dc.ok
      ? `docker ${dc.docker}, image ${dc.image ? 'present' : 'missing'}, pocketd ${dc.pocketd || '?'}`
      : `${dc.error} ${dc.detail ?? ''}`
  )

  // 2. Import from the HTA when this app has no sealed passphrase yet.
  const det = await detectHta()
  if (!hasSealedPassphrase() && det.found && det.hasSealedPassphrase) {
    const settings = await readSettings()
    const imp = await importFromHta({
      servicesRoot: settings.servicesRoot,
      progress: (ev) => console.log(`      import: ${ev.text}${ev.sub ? ' (' + ev.sub + ')' : ''}`)
    })
    add(
      'import-from-hta',
      imp.ok && imp.passphrase !== 'failed',
      `passphrase ${imp.passphrase}, verified ${imp.verified}, wallets ${imp.wallets}, history ${imp.history}`
    )
  } else {
    add(
      'import-from-hta',
      null,
      det.found ? 'already sealed in this app' : 'no HTA data on this PC'
    )
  }

  // 3. Read paths.
  const ws = await signer.run('wallet-status', {})
  add(
    'wallet-status',
    ws.ok && ws.imported && ws.verified,
    ws.ok
      ? `imported=${ws.imported} verified=${ws.verified} address=${ws.address ?? '-'} app_wallets=${ws.app_wallets}`
      : ((ws as { error?: string }).error ?? '')
  )
  const wl = await signer.run('wallet-list', {})
  add(
    'wallet-list',
    wl.ok && wl.verified,
    wl.ok ? `verified=${wl.verified} parent=${wl.parent?.present} wallets=${wl.wallets.length}` : ''
  )
  const hist = await signer.run('history', {})
  add('history', hist.ok, hist.ok ? `${hist.entries.length} entries` : '')
  const nope = (await signer.run('nope' as never, {} as never)) as unknown as {
    ok: boolean
    error: string
  }
  add(
    'unknown-op',
    !nope.ok && (nope as { error: string }).error === "Unknown operation 'nope'.",
    (nope as { error: string }).error
  )

  // 4. Compare with the HTA's records.
  const htaWallet = await readJson<{ address?: string }>(htaFiles.wallet())
  if (htaWallet && ws.ok && ws.address)
    add(
      'owner-matches-hta',
      htaWallet.address === ws.address,
      `${htaWallet.address} vs ${ws.address}`
    )
  else add('owner-matches-hta', null, 'no HTA wallet.json')
  const htaWallets = await readJson<{ wallets?: WalletRecord[] }>(htaFiles.wallets())
  if (htaWallets?.wallets && wl.ok) {
    const ours = new Set(wl.wallets.map((w) => `${w.name}:${w.address}`))
    const missing = htaWallets.wallets
      .filter((w) => !ours.has(`${w.name}:${w.address}`))
      .map((w) => w.name)
    add(
      'app-wallets-match-hta',
      missing.length === 0,
      missing.length
        ? `missing: ${missing.join(', ')}`
        : `${htaWallets.wallets.length} wallets match`
    )
  } else add('app-wallets-match-hta', null, 'no HTA wallets.json')

  // 5. Live chain reads.
  let ownerBalance = 0
  try {
    const blk = await latestBlock('beta')
    add(
      'lcd-latest-block',
      blk.chainId === 'pocket-lego-testnet',
      `height ${blk.height} chain ${blk.chainId}`
    )
    if (ws.ok && ws.address) {
      ownerBalance = await balanceUpokt('beta', ws.address)
      add('lcd-owner-balance', true, `${upoktToPokt(ownerBalance)} POKT`)
    }
    const sp = await params('beta', 'service')
    add(
      'lcd-service-params',
      'add_service_fee' in sp,
      `add_service_fee=${JSON.stringify(sp.add_service_fee)}`
    )
  } catch (e) {
    add('lcd', false, (e as Error).message)
  }

  // 6. Wallet lifecycle with a throwaway application wallet (no funds involved).
  const tmpName = `psm-selftest-${Date.now().toString(36).slice(-6)}`
  let created: { address: string } | null = null
  if (ws.ok && ws.imported && ws.verified) {
    const wc = await signer.run('wallet-create', { name: tmpName, service_id: 'example-charts' })
    if (wc.ok) {
      created = { address: wc.address }
      const phraseWords = wc.mnemonic.split(' ').length
      add(
        'wallet-create',
        RE.address.test(wc.address) && phraseWords >= 12,
        `${tmpName} ${wc.address}, ${phraseWords}-word phrase (not shown)`
      )
      const wl2 = await signer.run('wallet-list', {})
      add(
        'wallet-create-present',
        wl2.ok && wl2.wallets.some((w) => w.name === tmpName && w.present === true)
      )
      const ex = await signer.run('wallet-export', { name: tmpName })
      add(
        'wallet-export',
        ex.ok && RE.hexKey.test(ex.hex),
        ex.ok ? '64 hex chars returned (not shown)' : (ex as { error: string }).error
      )
      if (ex.ok) {
        const dup = await signer.run('wallet-import-app', {
          name: `${tmpName}-dup`,
          privateKeyHex: ex.hex
        })
        add(
          'wallet-import-app-duplicate-refused',
          !dup.ok && /already in the keyring as/.test((dup as { error: string }).error),
          (dup as { error: string }).error
        )
        // Recovering the same phrase while the key is still present is a duplicate pocketd refuses,
        // so remove the created key first, recover it from the phrase, and check the address matches.
        const dupRec = await signer.run('wallet-recover', {
          name: `${tmpName}-r`,
          mnemonic: wc.mnemonic
        })
        add(
          'wallet-recover-duplicate-refused',
          !dupRec.ok,
          (dupRec as { error?: string }).error + ' / ' + (dupRec as { detail?: string }).detail
        )
        const rm1 = await signer.run('wallet-remove', { name: tmpName, confirm: tmpName })
        add(
          'wallet-remove',
          rm1.ok,
          rm1.ok ? `${tmpName} removed` : (rm1 as { error: string }).error
        )
        const rec = await signer.run('wallet-recover', { name: tmpName, mnemonic: wc.mnemonic })
        add(
          'wallet-recover',
          rec.ok && rec.address === wc.address,
          rec.ok
            ? `recovered to ${rec.address}`
            : (rec as { error: string }).error + ' / ' + (rec as { detail?: string }).detail
        )
        if (!rec.ok) created = null
      }
      const bal = await balanceUpokt('beta', wc.address).catch(() => -1)
      add('lcd-new-wallet-balance', bal === 0, `${bal} upokt`)
      const setsvc = await signer.run('wallet-set-service', {
        name: tmpName,
        service_id: 'example-builder-test'
      })
      add('wallet-set-service', setsvc.ok)
    } else {
      add('wallet-create', false, (wc as { error: string }).error)
    }
  } else {
    add('wallet-lifecycle', null, 'owner wallet not verified; skipped')
  }

  // 7. Every transaction as a dry run.
  const cardPath = join(app.getAppPath(), 'fixtures', 'services', 'example-charts', 'card.json')
  const dryAdd = await signer.run('tx-add-service', {
    network: 'beta',
    service_id: 'psm-selftest-x',
    name: 'PSM Selftest',
    compute_units_per_relay: 7,
    card_path: exists(cardPath) ? cardPath : '',
    dry: true
  })
  add(
    'tx-add-service (dry)',
    dryAdd.ok && 'command' in dryAdd && /add-service psm-selftest-x/.test(dryAdd.command),
    'command' in dryAdd ? dryAdd.command.slice(0, 90) : (dryAdd as { error: string }).error
  )
  const dryStake = await signer.run('tx-stake-app', {
    network: 'beta',
    service_id: 'example-charts',
    stake_upokt: 1_000_000_000,
    from: created ? tmpName : undefined,
    dry: true
  })
  add(
    'tx-stake-app (dry)',
    dryStake.ok && 'config' in dryStake && /example-charts/.test(dryStake.config),
    'from' in dryStake ? `from=${dryStake.from}` : (dryStake as { error: string }).error
  )
  if (created) {
    const dryFund = await signer.run('tx-fund-wallet', {
      network: 'beta',
      name: tmpName,
      amount_upokt: 1_000_000,
      dry: true
    })
    add(
      'tx-fund-wallet (dry)',
      dryFund.ok && 'command' in dryFund && dryFund.command.includes(created.address)
    )
  }
  const dryFundOp = await signer.run('tx-fund-operator', {
    network: 'beta',
    to: ws.ok && ws.address ? ws.address : 'pokt1qyqszqgpqyqszqgpqyqszqgpqyqszqgp04723y',
    amount_upokt: 1,
    dry: true
  })
  add(
    'tx-fund-operator (self refused)',
    !dryFundOp.ok &&
      (dryFundOp as { error: string }).error === 'The recipient is this wallet itself.',
    (dryFundOp as { error?: string }).error
  )
  try {
    const gws = await gateways('beta')
    if (gws.length) {
      const dryDel = await signer.run('tx-delegate-gateway', {
        network: 'beta',
        gateway_address: gws[0].address,
        dry: true
      })
      add(
        'tx-delegate-gateway (dry)',
        dryDel.ok && 'from' in dryDel && dryDel.from === OWNER_KEY_NAME,
        `gateway ${gws[0].address} (${gws.length} live)`
      )
      const dryUndel = await signer.run('tx-undelegate-gateway', {
        network: 'beta',
        gateway_address: gws[0].address,
        dry: true
      })
      add('tx-undelegate-gateway (dry)', dryUndel.ok)
    } else add('tx-delegate-gateway (dry)', null, 'no gateways on beta')
  } catch (e) {
    add('tx-delegate-gateway (dry)', false, (e as Error).message)
  }
  const dryUnstake = await signer.run('tx-unstake-supplier', {
    network: 'beta',
    operator_address: 'pokt1qgpqyqszqgpqyqszqgpqyqszqgpqyqsz73c06j',
    dry: true
  })
  add(
    'tx-unstake-supplier (dry)',
    dryUnstake.ok && 'command' in dryUnstake && /unstake-supplier/.test(dryUnstake.command)
  )
  const badNet = await signer.run('tx-fund-operator', {
    network: 'main',
    to: 'pokt1qgpqyqszqgpqyqszqgpqyqszqgpqyqsz73c06j',
    amount_upokt: 1,
    dry: true
  })
  add(
    'mainnet dry run stays dry',
    badNet.ok && 'dry' in badNet && badNet.dry === true,
    'no passphrase unsealed for a dry run'
  )

  // 8. Servers, if Settings has one with a key on this PC.
  const settings = await readSettings()
  const srv = settings.servers.find((s) => s.keyPath)
  if (srv) {
    const st = await signer.run('ssh-test', {
      host: srv.host,
      port: srv.port,
      user: srv.user,
      key_path: srv.keyPath,
      path: srv.suppliers.beta?.dir
    })
    add(
      'ssh-test',
      st.ok,
      st.ok
        ? `${st.hostname} ${st.docker} keyring=${st.keyring}`
        : `${(st as { error: string }).error} ${(st as { detail?: string }).detail ?? ''}`
    )
    const beta = srv.suppliers.beta
    if (beta && ws.ok && ws.address && beta.operator) {
      const dryRemote = await signer.run('remote-stake-supplier', {
        host: srv.host,
        port: srv.port,
        user: srv.user,
        key_path: srv.keyPath,
        network: 'beta',
        path: beta.dir,
        owner_address: ws.address,
        operator_address: beta.operator,
        stake_upokt: 1,
        services: [{ service_id: 'example-charts', url: beta.url, rpc_type: 'REST' }],
        dry: true
      })
      add(
        'remote-stake-supplier (dry)',
        dryRemote.ok && 'config' in dryRemote,
        'config' in dryRemote
          ? dryRemote.command.slice(0, 80)
          : (dryRemote as { error: string }).error
      )
      const status = await signer.run('supplier-run', {
        host: srv.host,
        port: srv.port,
        user: srv.user,
        key_path: srv.keyPath,
        path: beta.dir,
        step: 'status'
      })
      add(
        'supplier-run status',
        status.ok,
        'lines' in status
          ? status.lines.slice(0, 3).join(' | ')
          : (status as { error: string }).error
      )
    }
  } else add('ssh-test', null, 'no server entry in settings')

  // 9. Card validation without Python.
  if (exists(cardPath)) {
    const vc = await signer.run('validate-card', { card_path: cardPath })
    add('validate-card', vc.ok, 'output' in vc ? vc.output.split('\n').slice(-1)[0] : '')
  }

  // 10. Clean up the throwaway wallet.
  if (created) {
    const rm = await signer.run('wallet-remove', { name: tmpName, confirm: tmpName })
    add(
      'wallet-remove-final',
      rm.ok,
      rm.ok ? `${tmpName} removed` : (rm as { error: string }).error
    )
  }
  const wl3 = await signer.run('wallet-list', {})
  add(
    'throwaway-gone',
    wl3.ok && !wl3.wallets.some((w) => w.name.startsWith('psm-selftest-')),
    wl3.ok ? `${wl3.wallets.length} wallet(s) remain` : ''
  )

  const failed = rows.filter((r) => r.ok === false)
  const passed = rows.filter((r) => r.ok === true)
  const summary = `${passed.length} passed, ${failed.length} failed, ${rows.length - passed.length - failed.length} skipped in ${Math.round((Date.now() - started) / 1000)} s`
  console.log(summary)
  await writeText(
    dataFiles.selftest(),
    [
      `selftest beta ${new Date().toISOString()}`,
      ...rows.map(
        (r) => `${r.ok === null ? 'SKIP' : r.ok ? 'PASS' : 'FAIL'}\t${r.step}\t${r.note}`
      ),
      summary
    ].join('\n') + '\n'
  )
  return failed.length ? 1 : 0
}
