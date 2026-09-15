// Rewrites bucket/pocket-service-manager.json for a released version.
//   node scripts/update-bucket.mjs <version> <path to SHA256SUMS> <owner/repo>
import { readFileSync, writeFileSync } from 'node:fs'

const [version, sumsPath, repo] = process.argv.slice(2)
if (!version || !sumsPath || !repo) {
  console.error('usage: update-bucket.mjs <version> <SHA256SUMS> <owner/repo>')
  process.exit(1)
}
const zipName = `PocketServiceManager-${version}-win-x64.zip`
const sums = readFileSync(sumsPath, 'utf8').split(/\r?\n/)
const line = sums.find((l) => l.trim().endsWith(zipName))
if (!line) {
  console.error(`${zipName} not found in ${sumsPath}`)
  process.exit(1)
}
const hash = line.trim().split(/\s+/)[0]
const path = 'bucket/pocket-service-manager.json'
const manifest = JSON.parse(readFileSync(path, 'utf8'))
manifest.version = version
manifest.homepage = `https://github.com/${repo}`
manifest.architecture['64bit'].url =
  `https://github.com/${repo}/releases/download/v${version}/${zipName}`
manifest.architecture['64bit'].hash = `sha256:${hash}`
manifest.autoupdate.architecture['64bit'].url =
  `https://github.com/${repo}/releases/download/v$version/PocketServiceManager-$version-win-x64.zip`
writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n')
console.log(`bucket updated to ${version} (${hash})`)
