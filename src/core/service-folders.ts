// Which service folder is a service's own. A folder declares its service ID in
// service.json, and nothing stops two folders declaring the same one (an older copy,
// or a card saved beside its source before 0.1.16). The app shows one entry per
// service and works on one folder for it: the source folder, the one with the backend.

export interface ServiceFolderInfo {
  folder: string
  id: string
  hasCard: boolean
  hasDockerfile: boolean
}

/**
 * The folders that declare one service, source folder first: the one with a backend,
 * then one with a card, then the one named after the service ID, then by name.
 */
export function rankServiceFolders<T extends ServiceFolderInfo>(folders: T[]): T[] {
  const score = (f: T): number =>
    (f.hasDockerfile ? 4 : 0) + (f.hasCard ? 2 : 0) + (f.folder === f.id ? 1 : 0)
  return [...folders].sort((a, b) => score(b) - score(a) || a.folder.localeCompare(b.folder))
}

/** One entry per service ID, in first-seen order: its source folder and any others. */
export function groupServiceFolders<T extends ServiceFolderInfo>(
  folders: T[]
): { id: string; primary: T; others: T[] }[] {
  const byId = new Map<string, T[]>()
  for (const f of folders) byId.set(f.id, [...(byId.get(f.id) ?? []), f])
  return [...byId.entries()].map(([id, list]) => {
    const [primary, ...others] = rankServiceFolders(list)
    return { id, primary, others }
  })
}

/** The source folder for a service ID, or null when no folder declares it. */
export function sourceFolderFor<T extends ServiceFolderInfo>(folders: T[], id: string): T | null {
  return rankServiceFolders(folders.filter((f) => f.id === id))[0] ?? null
}

/**
 * Where Create writes a card. A card loaded from a folder goes back to that folder,
 * whatever its name. A new card goes to a folder named after its service ID, unless
 * another folder already declares that ID, which would make a second entry for it.
 */
export function createTargetFolder(
  loadedFolder: string,
  id: string,
  folders: ServiceFolderInfo[]
): { ok: true; folder: string } | { ok: false; reason: string } {
  if (loadedFolder) return { ok: true, folder: loadedFolder }
  const other = folders.find((f) => f.id === id && f.folder !== id)
  if (other)
    return {
      ok: false,
      reason: `The folder ${other.folder} already holds the service ${id}. To change its card, press Edit card on its row in My services, or load that folder at the top of this form.`
    }
  return { ok: true, folder: id }
}
