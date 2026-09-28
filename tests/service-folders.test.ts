import { describe, it, expect } from 'vitest'
import {
  rankServiceFolders,
  groupServiceFolders,
  sourceFolderFor,
  createTargetFolder,
  type ServiceFolderInfo
} from '@core/service-folders'

const f = (
  folder: string,
  id: string,
  hasDockerfile = false,
  hasCard = true
): ServiceFolderInfo => ({
  folder,
  id,
  hasCard,
  hasDockerfile
})

// The case that produced two rows: the source folder is named differently from its
// service ID, and a card was saved beside it under the ID's name.
const source = f('meadow-node', 'meadow', true)
const stray = f('meadow', 'meadow', false)
const other = f('pretty-charts', 'pretty-charts', true)

describe('service folders', () => {
  it('ranks the folder with the backend first, even when another is named after the ID', () => {
    expect(rankServiceFolders([stray, source]).map((x) => x.folder)).toEqual([
      'meadow-node',
      'meadow'
    ])
  })
  it('then a card, then the folder named after the ID, then by name', () => {
    const noCard = f('b-copy', 'b', false, false)
    const named = f('b', 'b', false, true)
    const alsoCard = f('a-copy', 'b', false, true)
    expect(rankServiceFolders([noCard, alsoCard, named]).map((x) => x.folder)).toEqual([
      'b',
      'a-copy',
      'b-copy'
    ])
  })
  it('groups one entry per service ID, with the extra folders named', () => {
    const g = groupServiceFolders([stray, other, source])
    expect(g.map((x) => [x.id, x.primary.folder, x.others.map((o) => o.folder)])).toEqual([
      ['meadow', 'meadow-node', ['meadow']],
      ['pretty-charts', 'pretty-charts', []]
    ])
  })
  it('finds the source folder for an ID, or none', () => {
    expect(sourceFolderFor([stray, source, other], 'meadow')?.folder).toBe('meadow-node')
    expect(sourceFolderFor([other], 'meadow')).toBeNull()
  })
  it('saves a loaded card back to its own folder, whatever its name', () => {
    expect(createTargetFolder('meadow-node', 'meadow', [source])).toEqual({
      ok: true,
      folder: 'meadow-node'
    })
  })
  it('refuses a new card whose ID another folder already declares', () => {
    const r = createTargetFolder('', 'meadow', [source, other])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('meadow-node')
  })
  it('puts a new card in a folder named after its ID', () => {
    expect(createTargetFolder('', 'new-svc', [source, other])).toEqual({
      ok: true,
      folder: 'new-svc'
    })
    expect(createTargetFolder('', 'pretty-charts', [other])).toEqual({
      ok: true,
      folder: 'pretty-charts'
    })
  })
})
