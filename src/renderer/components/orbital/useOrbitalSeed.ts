/**
 * Seeds for local agents. Local surfaces pass only the DID and the file path
 * (never the handle) so the sidebar, title bar and fleet map, which do not
 * all know the handle, always agree on the seed.
 */

import { useEffect, useMemo, useState } from 'react'
import { useAgentStore } from '../../stores/agent.store'
import { useDocumentStore } from '../../stores/document.store'
import { useTrackedDirsStore } from '../../stores/tracked-dirs.store'
import type { TrackedDirEntry } from '../../../shared/types/ipc.types'
import { orbitalSeedFor, type OrbitalSeedSource } from './orbital-seed'

export function useOrbitalSeed(agent: OrbitalSeedSource | null | undefined): string | null {
  const did = agent?.did
  const publicKey = agent?.publicKey
  const handle = agent?.handle
  const filePath = agent?.filePath
  return useMemo(
    () => orbitalSeedFor({ did, publicKey, handle, filePath }),
    [did, publicKey, handle, filePath]
  )
}

function findEntry(entries: TrackedDirEntry[] | undefined, filePath: string): TrackedDirEntry | null {
  if (!entries) return null
  for (const e of entries) {
    if (e.filePath === filePath) return e
    if (e.children) {
      const hit = findEntry(e.children, filePath)
      if (hit) return hit
    }
  }
  return null
}

/** DIDs fetched for open files (by path and config id), so reopening one does
 *  not ask main again. Only hits are kept: a file without one may get one. */
const fetchedDids = new Map<string, string>()

/**
 * Seed of the agent open in the editor. Takes the DID from the tracked-folder
 * listing when the file is in one, else asks main for the open agent's DID.
 * Null until the DID is known, so the avatar never shows a path-seeded shape
 * that then changes.
 */
export function useOpenAgentOrbitalSeed(): string | null {
  const filePath = useDocumentStore((s) => s.filePath)
  // getDid answers for the agent main has open; wait until its config is
  // loaded here so the answer belongs to this file, not the previous one.
  const configId = useAgentStore((s) => s.config?.id ?? null)
  const cacheKey = filePath && configId ? `${filePath}|${configId}` : null
  const listedDid = useTrackedDirsStore((s) => {
    if (!filePath) return undefined
    for (const files of Object.values(s.filesByDir)) {
      const hit = findEntry(files, filePath)
      if (hit) return hit.did ?? null
    }
    return undefined
  })
  const [fetched, setFetched] = useState<{ key: string; did: string | null } | null>(() => {
    const did = cacheKey ? fetchedDids.get(cacheKey) : undefined
    return cacheKey && did ? { key: cacheKey, did } : null
  })

  useEffect(() => {
    if (!cacheKey || listedDid) return
    const hit = fetchedDids.get(cacheKey)
    if (hit) {
      setFetched({ key: cacheKey, did: hit })
      return
    }
    let live = true
    window.adfApi?.getDid?.().then(
      (r) => {
        const did = r?.did ?? null
        if (did) fetchedDids.set(cacheKey, did)
        if (live) setFetched({ key: cacheKey, did })
      },
      () => {
        if (live) setFetched({ key: cacheKey, did: null })
      }
    )
    return () => {
      live = false
    }
  }, [cacheKey, listedDid])

  if (!filePath) return null
  if (listedDid) return orbitalSeedFor({ did: listedDid, filePath })
  if (!cacheKey || fetched?.key !== cacheKey) return null
  return orbitalSeedFor({ did: fetched.did, filePath })
}
