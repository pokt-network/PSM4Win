// Wallet operations (SIGNER-CONTRACT.md section 3.2). Same names, same checks,
// same error texts as signer.ps1. Secrets arrive in the request object over IPC
// and go into a child's environment only; they are never logged or written.
import { fail } from '@core/errors'
import { OWNER_KEY_NAME } from '@core/versions'
import {
  RE,
  validateWalletName,
  validateServiceId,
  normalizeHexKey,
  normalizeMnemonic
} from '@core/validate'
import { cleanErr, summarizeErr, parseFirstJson } from '@core/pocketd-output'
import { shQuote } from '@core/text'
import type { SignerRequests, SignerResults } from '@core/contract'
import type { OpContext } from './context'
import {
  dockerCheck,
  requireDocker,
  volumeExists,
  ensureVolume,
  removeVolume,
  keyringAddress,
  keyringList,
  probeHexAddress,
  invokeInBox,
  pocketd
} from './docker'
import {
  unsealPassphrase,
  requirePassphrase,
  hasSealedPassphrase,
  newPassphrase,
  sealPassphrase,
  deleteSealedPassphrase
} from './passphrase'
import {
  readOwnerWallet,
  writeOwnerWallet,
  readWallets,
  saveWallets,
  findWallet,
  registerWallet,
  walletHolding,
  setWalletService,
  removeWalletFiles
} from '../state/wallets'
import { addHistory } from '../state/history'
import { removeFile } from '../state/files'
import { dataFiles } from '../paths'
import { log } from '../state/log'

type Req<K extends keyof SignerRequests> = SignerRequests[K]
type Res<K extends keyof SignerResults> = SignerResults[K]

export async function walletStatus(
  _req: Req<'wallet-status'>,
  ctx: OpContext
): Promise<Res<'wallet-status'>> {
  const w = await readOwnerWallet()
  const hasPass = hasSealedPassphrase()
  const dc = await dockerCheck(ctx)
  const apps = await readWallets()
  const appCount = apps.length
  if (!dc.ok) {
    if (w && hasPass)
      return {
        ok: true,
        imported: true,
        verified: false,
        address: w.address,
        name: OWNER_KEY_NAME,
        imported_at: w.imported_at,
        app_wallets: appCount
      }
    return { ok: true, imported: false, verified: false, app_wallets: appCount }
  }
  const vol = await volumeExists(ctx)
  if (!(w && hasPass && vol)) {
    return {
      ok: true,
      imported: false,
      verified: true,
      partial: !!(w || hasPass || vol),
      app_wallets: appCount
    }
  }
  if (!dc.image) {
    // The keyring cannot be read without the image; report what the files say.
    return {
      ok: true,
      imported: true,
      verified: false,
      address: w.address,
      name: OWNER_KEY_NAME,
      imported_at: w.imported_at,
      app_wallets: appCount
    }
  }
  const pass = await unsealPassphrase()
  const addr = pass ? await keyringAddress(OWNER_KEY_NAME, pass, ctx) : null
  if (!addr)
    return {
      ok: true,
      imported: false,
      verified: true,
      partial: true,
      app_wallets: appCount,
      error: 'The parent key could not be read from the keyring.'
    }
  return {
    ok: true,
    imported: true,
    verified: true,
    address: addr,
    name: OWNER_KEY_NAME,
    imported_at: w.imported_at,
    app_wallets: appCount
  }
}

export async function walletImport(
  req: Req<'wallet-import'>,
  ctx: OpContext
): Promise<Res<'wallet-import'>> {
  await requireDocker(ctx)
  let hex: string | null = normalizeHexKey(req.privateKeyHex)
  if (await readOwnerWallet())
    fail('A wallet is already imported. Revoke it before importing another.')
  let pass = await unsealPassphrase()
  if (!pass) {
    // No usable passphrase means any leftover keyring is unreadable; start clean.
    if (await volumeExists(ctx)) {
      ctx.progress('warn', 'No sealed passphrase exists; removing the leftover keyring volume.')
      await removeVolume(ctx)
    }
    await removeFile(dataFiles.wallets())
    pass = newPassphrase()
    await sealPassphrase(pass)
  }
  await ensureVolume(ctx)
  if (await keyringAddress(OWNER_KEY_NAME, pass, ctx)) {
    await pocketd(['keys', 'delete', OWNER_KEY_NAME, '-y', '--keyring-backend', 'file'], {
      pass,
      ctx
    })
  }
  const r = await invokeInBox(
    `pocketd keys import-hex ${shQuote(OWNER_KEY_NAME)} "$PSM_IMPORT_KEY" --keyring-backend file`,
    {
      stdinText: `${pass}\n${pass}\n`,
      envExtra: { PSM_IMPORT_KEY: hex },
      ctx
    }
  )
  hex = null
  if (r.code !== 0) fail('pocketd could not import the key.', cleanErr(r.err))
  const addr = await keyringAddress(OWNER_KEY_NAME, pass, ctx)
  if (!addr) fail('The key was imported but cannot be read back.')
  await writeOwnerWallet(addr)
  await addHistory({ op: 'wallet-import', address: addr })
  return { ok: true, address: addr, name: OWNER_KEY_NAME }
}

async function requireOwnerForApps(): Promise<void> {
  if (!(await readOwnerWallet()))
    fail('Import the owner wallet first; it creates the keyring the application wallets live in.')
}

async function refuseUntrackedKey(name: string, pass: string, ctx: OpContext): Promise<void> {
  if (await keyringAddress(name, pass, ctx))
    fail(
      `The keyring already holds a key named '${name}' that this app does not track. Choose another name.`
    )
}

export async function walletImportApp(
  req: Req<'wallet-import-app'>,
  ctx: OpContext
): Promise<Res<'wallet-import-app'>> {
  await requireDocker(ctx)
  const name = validateWalletName(req.name)
  const sid = req.service_id ? validateServiceId(req.service_id) : ''
  await requireOwnerForApps()
  if (await findWallet(name)) fail(`A wallet named '${name}' already exists.`)
  let hex: string | null = normalizeHexKey(req.privateKeyHex)
  const pass = await requirePassphrase()
  await refuseUntrackedKey(name, pass, ctx)
  const probe = await probeHexAddress(hex, ctx)
  if (!probe) fail('pocketd could not derive an address from that key.')
  const holder = await walletHolding(probe)
  if (holder) {
    hex = null
    fail(`That key is already in the keyring as '${holder}' (${probe}).`)
  }
  const r = await invokeInBox(
    `pocketd keys import-hex ${shQuote(name)} "$PSM_IMPORT_KEY" --keyring-backend file`,
    {
      stdinText: `${pass}\n${pass}\n`,
      envExtra: { PSM_IMPORT_KEY: hex! },
      ctx
    }
  )
  hex = null
  if (r.code !== 0) fail('pocketd could not import the key.', summarizeErr(r.err))
  const addr = await keyringAddress(name, pass, ctx)
  if (!addr) fail('The key was imported but cannot be read back.')
  if (addr !== probe)
    fail('The imported key does not match the address derived beforehand.', `${addr} vs ${probe}`)
  await registerWallet(name, addr, sid, 'import')
  return { ok: true, name, address: addr, service_id: sid }
}

export async function walletCreate(
  req: Req<'wallet-create'>,
  ctx: OpContext
): Promise<Res<'wallet-create'>> {
  await requireDocker(ctx)
  const name = validateWalletName(req.name)
  const sid = req.service_id ? validateServiceId(req.service_id) : ''
  await requireOwnerForApps()
  if (await findWallet(name)) fail(`A wallet named '${name}' already exists.`)
  const pass = await requirePassphrase()
  await refuseUntrackedKey(name, pass, ctx)
  const r = await pocketd(['keys', 'add', name, '--keyring-backend', 'file', '--output', 'json'], {
    pass,
    ctx
  })
  const j = parseFirstJson(r)
  if (r.code !== 0 || !j || !j.address) fail('pocketd could not create the key.', cleanErr(r.err))
  const addr = String(j!.address)
  const phrase = String(j!.mnemonic ?? '')
  if (!RE.address.test(addr)) fail('pocketd returned an address that is not a pokt1 address.', addr)
  if (phrase.split(' ').length < 12)
    fail(
      'pocketd did not return a recovery phrase; the key was created but cannot be backed up. Remove it and try again.'
    )
  await registerWallet(name, addr, sid, 'create')
  return { ok: true, name, address: addr, service_id: sid, mnemonic: phrase }
}

export async function walletRecover(
  req: Req<'wallet-recover'>,
  ctx: OpContext
): Promise<Res<'wallet-recover'>> {
  await requireDocker(ctx)
  const name = validateWalletName(req.name)
  const sid = req.service_id ? validateServiceId(req.service_id) : ''
  await requireOwnerForApps()
  if (await findWallet(name)) fail(`A wallet named '${name}' already exists.`)
  let phrase: string | null = normalizeMnemonic(req.mnemonic)
  const pass = await requirePassphrase()
  await refuseUntrackedKey(name, pass, ctx)
  // pocketd reads the phrase first, then the keyring passphrase.
  const r = await pocketd(
    ['keys', 'add', name, '--recover', '--keyring-backend', 'file', '--output', 'json'],
    { pass, prefixLines: `${phrase}\n`, ctx }
  )
  phrase = null
  const j = parseFirstJson(r)
  if (r.code !== 0 || !j || !j.address)
    fail('pocketd could not recover the key.', summarizeErr(r.err))
  const addr = String(j!.address)
  await registerWallet(name, addr, sid, 'recover')
  return { ok: true, name, address: addr, service_id: sid }
}

export async function walletList(
  _req: Req<'wallet-list'>,
  ctx: OpContext
): Promise<Res<'wallet-list'>> {
  const parent = await readOwnerWallet()
  const apps = await readWallets()
  const dc = await dockerCheck(ctx)
  let verified = false
  const inRing = new Map<string, string>()
  if (dc.ok && dc.image && hasSealedPassphrase() && (await volumeExists(ctx))) {
    const pass = await unsealPassphrase()
    const lst = pass ? await keyringList(pass, ctx) : null
    if (lst !== null) {
      verified = true
      for (const k of lst) inRing.set(k.name, k.address)
    }
  }
  return {
    ok: true,
    verified,
    parent: parent
      ? {
          name: OWNER_KEY_NAME,
          address: parent.address,
          present: verified ? inRing.has(OWNER_KEY_NAME) : null
        }
      : null,
    wallets: apps.map((a) => ({ ...a, present: verified ? inRing.has(a.name) : null }))
  }
}

export async function walletExport(
  req: Req<'wallet-export'>,
  ctx: OpContext
): Promise<Res<'wallet-export'>> {
  await requireDocker(ctx)
  const name = req.name && req.name !== '' ? req.name : OWNER_KEY_NAME
  if (name !== OWNER_KEY_NAME && !(await findWallet(name)))
    fail(`'${name}' is not a wallet this app manages.`)
  const pass = await requirePassphrase()
  // pocketd asks "continue? [y/N]" for --unsafe, then the keyring passphrase.
  const r = await pocketd(
    ['keys', 'export', name, '--unarmored-hex', '--unsafe', '--keyring-backend', 'file'],
    { pass, prefixLines: 'y\n', ctx }
  )
  if (r.code !== 0) fail('pocketd could not export the key.', cleanErr(r.err))
  const hex = r.out.trim()
  if (!RE.hexKey.test(hex))
    fail('pocketd returned something that is not a 64-character hex key.', cleanErr(r.err))
  await addHistory({ op: 'wallet-export', extra: `name=${name}` })
  return { ok: true, hex, name }
}

/** Exports a key for in-memory use only (relay-call). Not logged, not in history. */
export async function exportKeyInMemory(
  name: string,
  pass: string,
  ctx: OpContext
): Promise<string> {
  const x = await pocketd(
    ['keys', 'export', name, '--unarmored-hex', '--unsafe', '--keyring-backend', 'file'],
    { pass, prefixLines: 'y\n', ctx }
  )
  if (x.code !== 0) fail('The wallet key could not be read from the keyring.', cleanErr(x.err))
  const hex = x.out.trim()
  if (!RE.hexKey.test(hex)) fail('The keyring returned something that is not a key.')
  return hex
}

export async function walletRemove(
  req: Req<'wallet-remove'>,
  ctx: OpContext
): Promise<Res<'wallet-remove'>> {
  await requireDocker(ctx)
  const name = req.name
  if (name === OWNER_KEY_NAME) fail('The owner wallet is removed with Revoke, not here.')
  const w = await findWallet(name)
  if (!w) fail(`'${name}' is not a wallet this app manages.`)
  if (req.confirm !== name) fail('The wallet name was not confirmed.')
  for (const x of await readWallets()) {
    if (x.name !== name && x.address === w!.address)
      fail(
        `'${x.name}' holds the same key; removing one would break the other. Remove that record first.`
      )
  }
  const pass = await requirePassphrase()
  if (await keyringAddress(name, pass, ctx)) {
    const r = await pocketd(['keys', 'delete', name, '-y', '--keyring-backend', 'file'], {
      pass,
      ctx
    })
    // Treat a failed delete as done only if the key really is gone afterwards.
    if (r.code !== 0 && (await keyringAddress(name, pass, ctx)))
      fail('pocketd could not delete the key.', cleanErr(r.err))
  }
  await saveWallets((await readWallets()).filter((x) => x.name !== name))
  await addHistory({ op: 'wallet-remove', address: w!.address, extra: `name=${name}` })
  return { ok: true }
}

export async function walletDelete(
  req: Req<'wallet-delete'>,
  ctx: OpContext
): Promise<Res<'wallet-delete'>> {
  const apps = await readWallets()
  if (apps.length > 0 && !req.force) {
    fail(
      `The keyring still holds ${apps.length} application wallet(s). Export or remove them first, or confirm that they may be deleted with it.`
    )
  }
  const dc = await dockerCheck(ctx)
  if (dc.ok && (await volumeExists(ctx))) {
    const r = await removeVolume(ctx)
    if (r.code !== 0)
      fail('Could not delete the keyring volume.', r.err.trim().split(/\r?\n/)[0] ?? '')
  } else if (!dc.ok) {
    fail('Docker Desktop must be running to delete the keyring volume.', dc.detail ?? '')
  }
  const w = await readOwnerWallet()
  await deleteSealedPassphrase()
  await removeWalletFiles()
  log.warn('revoke: keyring volume and wallet files removed')
  await addHistory({ op: 'wallet-delete', address: w?.address ?? '' })
  return { ok: true }
}

export async function walletSetService(
  req: Req<'wallet-set-service'>
): Promise<Res<'wallet-set-service'>> {
  const sid = req.service_id ? validateServiceId(req.service_id) : ''
  if (!(await findWallet(req.name))) fail(`'${req.name}' is not a wallet this app manages.`)
  await setWalletService(req.name, sid)
  return { ok: true }
}
