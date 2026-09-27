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
  validateHealthPath
} from './validate'
import { validateRoutes, routeArgs } from './routes'
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
  'remove-routes'
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
      args.push(sid, root, validateHealthPath(req.health_path))
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
  }
  return { step, args }
}
