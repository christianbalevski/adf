// Open documents (design daemon-backend.md D4): `.adf` files opened for
// reading and editing without a runtime. The daemon's equivalent of embedded
// Studio's open file (FILE_OPEN opens the workspace and starts nothing).
//
// This module keeps the records; RuntimeService owns the lifecycle (open,
// start on the open workspace, stop keeping it open, release, close), so a
// document and the runtime started on it share one AdfWorkspace and one
// derived-key cell (never two handles on one file in this process).
//
// Holders: client sessions hold documents (D5, W2-B). A holder is an opaque
// string, normally the session id. A document with no holder and no runtime
// is closed. Session expiry calls RuntimeService.releaseDocumentHolder, which
// releases every document the session holds.
//
// Derived keys (D3): Studio caches a password-protected file's derived key
// per path for its process lifetime, so reopening a file never prompts again
// (ipc/index.ts derivedKeyCache). Here the cache is per holder: a document's
// key is remembered for each session that held it when it was unlocked or
// released, and dropped with the session. A session that never unlocked the
// file is prompted, as a second Studio would be.

import type { AdfWorkspace } from '../adf/adf-workspace'
import type { AgentConfig } from '../../shared/types/adf-v02.types'

/** One agent's legacy-password derived key, shared by the document and the runtime started on it. */
export interface DocumentKeyCell {
  current: Buffer | null
}

export interface OpenDocument {
  /** config.id when the document was opened. */
  agentId: string
  /** Canonical (realpath) file path. */
  filePath: string
  /** The open workspace. A runtime started on the document uses this same object. */
  workspace: AdfWorkspace
  keyCell: DocumentKeyCell
  /** The latest config read or written through the document (name and handle resolve against it). */
  config: AgentConfig
  holders: Set<string>
  openedAt: number
  /** Config writes made through the document; a start compares it before and after its build. */
  configWrites: number
}

export class DocumentHost {
  private readonly byPath = new Map<string, OpenDocument>()
  /** holder → canonical path → derived key (Studio's derivedKeyCache, per session). */
  private readonly holderKeys = new Map<string, Map<string, Buffer>>()

  get(filePath: string | null | undefined): OpenDocument | undefined {
    return filePath ? this.byPath.get(filePath) : undefined
  }

  /** By config id, then handle or name, as RuntimeService resolves running agents. */
  resolve(identifier: string): OpenDocument | undefined {
    for (const doc of this.byPath.values()) if (doc.agentId === identifier) return doc
    for (const doc of this.byPath.values()) {
      if (doc.config.handle === identifier || doc.config.name === identifier) return doc
    }
    return undefined
  }

  /** Another open document with this config id (a copied file), if any. */
  withId(agentId: string, exceptPath: string): OpenDocument | undefined {
    for (const doc of this.byPath.values()) if (doc.agentId === agentId && doc.filePath !== exceptPath) return doc
    return undefined
  }

  list(): OpenDocument[] {
    return [...this.byPath.values()]
  }

  heldBy(holder: string): OpenDocument[] {
    return this.list().filter(doc => doc.holders.has(holder))
  }

  add(doc: OpenDocument): void {
    this.byPath.set(doc.filePath, doc)
  }

  remove(doc: OpenDocument): void {
    if (this.byPath.get(doc.filePath) === doc) this.byPath.delete(doc.filePath)
  }

  /** The file moved: the record and every holder's cached key follow it. */
  rekey(oldPath: string, newPath: string): void {
    const doc = this.byPath.get(oldPath)
    if (doc) {
      this.byPath.delete(oldPath)
      doc.filePath = newPath
      this.byPath.set(newPath, doc)
    }
    for (const keys of this.holderKeys.values()) {
      const key = keys.get(oldPath)
      if (!key) continue
      keys.delete(oldPath)
      keys.set(newPath, key)
    }
  }

  rememberKey(holder: string, filePath: string, key: Buffer): void {
    let keys = this.holderKeys.get(holder)
    if (!keys) {
      keys = new Map()
      this.holderKeys.set(holder, keys)
    }
    keys.set(filePath, key)
  }

  cachedKey(holder: string, filePath: string): Buffer | undefined {
    return this.holderKeys.get(holder)?.get(filePath)
  }

  /** The file's key is gone (password removed, identity wiped, stale): no holder keeps it. */
  forgetKey(filePath: string): void {
    for (const keys of this.holderKeys.values()) keys.delete(filePath)
  }

  /** Session expiry: the holder's cached keys go with it. */
  dropHolder(holder: string): void {
    this.holderKeys.delete(holder)
  }
}
