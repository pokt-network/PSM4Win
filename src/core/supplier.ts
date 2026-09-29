// The supplier-run allow-list and argument builder (docs/SIGNER-CONTRACT.md, supplier-run).
// Every argument returned here is later single-quoted into the remote command without
// escaping, so each one must pass a strict pattern first. Pure: the signer runs it, the
// tests exercise it.
import { fail } from './errors'
import {
  RE,
  requireNetwork,
  validateServiceId,
  validateLinuxPath,
  validateHealthPath,
  validateAddress
} from './validate'
import { validateRoutes, routeArgs } from './routes'
import { validateBackendPort } from './relayer'
import type { SignerRequests, SupplierStep } from './contract'

export const SUPPLIER_STEPS: readonly SupplierStep[] = [
  'operator',
  'keys',
  'start',
  'status',
  'publish',
  'deploy',
  'add-service',
  'remove-service',
  'add-routes',
  'remove-routes',
  'operator-adopt'
]

/** The step and its validated arguments, or a thrown SignerFailure. */
export function supplierStepArgs(req: SignerRequests['supplier-run']): {
  step: SupplierStep
  args: string[]
} {
  const step = String(req.step) as SupplierStep
  if (!SUPPLIER_STEPS.includes(step)) fail(`Unknown supplier step '${step}'.`)
  const args: string[] = []
  switch (step) {
    case 'operator':
    case 'keys':
    case 'start':
    case 'status':
      break
    case 'publish':
      args.push(requireNetwork(req.network))
      break
    case 'deploy': {
      const sid = validateServiceId(String(req.service_id ?? ''))
      const root = validateLinuxPath(String(req.deploy_root ?? ''), 'Deploy root')
      args.push(
        sid,
        root,
        validateHealthPath(req.health_path),
        String(validateBackendPort(req.backend_port))
      )
      break
    }
    case 'add-service': {
      const sid = validateServiceId(String(req.service_id ?? ''))
      const url = String(req.backend_url ?? '')
      if (!RE.backendUrl.test(url)) fail('Backend URL must be http://<container>:<port>.')
      args.push(sid, url, validateHealthPath(req.health_path))
      break
    }
    case 'remove-service':
    case 'remove-routes':
      args.push(validateServiceId(String(req.service_id ?? '')))
      break
    case 'add-routes':
      args.push(
        validateServiceId(String(req.service_id ?? '')),
        ...routeArgs(validateRoutes(req.routes))
      )
      break
    case 'operator-adopt': {
      const kind = String(req.source_kind ?? '')
      if (kind !== 'keysfile' && kind !== 'keyring')
        fail("The key's source must be a keys file or a keyring on the server.")
      args.push(
        kind,
        validateLinuxPath(String(req.source_path ?? ''), 'Key source'),
        validateAddress(String(req.operator_address ?? ''), 'Operator address')
      )
      break
    }
  }
  return { step, args }
}

/**
 * A pasted operator secret: a 64-hex private key (optionally 0x-prefixed) or a recovery
 * phrase of 12, 15, 18, 21, or 24 lowercase words. Whitespace is normalised; anything else
 * is refused before it leaves the app. The value is never logged or put in a message.
 */
export function normalizeOperatorSecret(s: string): { kind: 'hex' | 'mnemonic'; value: string } {
  const t = String(s ?? '').trim()
  const hex = t.replace(/^0x/i, '')
  if (/^[0-9a-fA-F]{64}$/.test(hex)) return { kind: 'hex', value: hex.toLowerCase() }
  const words = t.toLowerCase().split(/\s+/).filter(Boolean)
  if ([12, 15, 18, 21, 24].includes(words.length) && words.every((w) => /^[a-z]+$/.test(w)))
    return { kind: 'mnemonic', value: words.join(' ') }
  return fail('That is neither a 64-character hex private key nor a 12 to 24 word recovery phrase.')
}
