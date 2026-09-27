// Writes a release's notes from its CHANGELOG.md section, so the release page and the
// app's update dialog say what changed.
//   node scripts/release-notes.mjs <version> <out file> <owner/repo>
// A version with no section still gets a note pointing at the changelog, and a warning,
// rather than failing the release.
import { readFileSync, writeFileSync } from 'node:fs'

const [version, out, repo] = process.argv.slice(2)
if (!version || !out || !repo) {
  console.error('usage: release-notes.mjs <version> <out file> <owner/repo>')
  process.exit(1)
}
const lines = readFileSync('CHANGELOG.md', 'utf8').replace(/\r/g, '').split('\n')
const start = lines.findIndex((l) => l.trim() === `## ${version}`)
let section = ''
if (start >= 0) {
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((l) => l.startsWith('## '))
  section = (end >= 0 ? rest.slice(0, end) : rest).join('\n').trim()
}
if (!section) console.log(`::warning::CHANGELOG.md has no "## ${version}" section`)
const link = `https://github.com/${repo}/blob/v${version}/CHANGELOG.md#${version.replace(/\./g, '')}`
writeFileSync(
  out,
  `${section || 'No notes were written for this version.'}\n\nEvery change, all versions: ${link}\n`
)
console.log(`release notes for ${version}: ${section ? section.split('\n').length : 0} lines`)
