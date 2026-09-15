// One-shot DPAPI unseal of the HTA's keyring.pass.dpapi (docs/MIGRATION.md).
// The only place the app spawns PowerShell. The sealed hex goes in through the
// environment, the plain value comes back on stdout, nothing touches a file.
import { spawn } from 'node:child_process'
import { RE } from '@core/validate'

export function unsealHtaPassphrase(sealedHex: string): Promise<string> {
  const script = `
    $s = ConvertTo-SecureString $env:PSM_SEALED
    $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
    try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
  `
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      {
        env: { ...process.env, PSM_SEALED: sealedHex.trim() },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      }
    )
    const out: Buffer[] = []
    child.stdout.on('data', (d: Buffer) => out.push(d))
    child.stderr.on('data', () => {
      /* never surface stderr unredacted */
    })
    child.on('error', (e) =>
      reject(new Error('Could not start PowerShell for the one-time unseal: ' + e.message))
    )
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error('DPAPI unseal failed (code ' + code + ')'))
      const pass = Buffer.concat(out).toString('utf8')
      if (!RE.passphrase.test(pass))
        return reject(new Error('Unsealed value has an unexpected shape.'))
      resolve(pass)
    })
  })
}
