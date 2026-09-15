// Writes <dir>/SHA256SUMS for the installer and the portable zip.
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2] ?? 'release'
const files = readdirSync(dir)
  .filter((f) => /\.(exe|zip)$/i.test(f))
  .sort()
if (!files.length) {
  console.error(`no .exe or .zip in ${dir}`)
  process.exit(1)
}
const lines = files.map(
  (f) =>
    `${createHash('sha256')
      .update(readFileSync(join(dir, f)))
      .digest('hex')}  ${f}`
)
writeFileSync(join(dir, 'SHA256SUMS'), lines.join('\n') + '\n')
console.log(lines.join('\n'))
