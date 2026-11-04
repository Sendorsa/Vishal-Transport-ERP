/**
 * Repository contract. The UI only talks to this interface (via TanStack Query hooks),
 * so swapping localStorage for the real REST/Supabase API means writing an
 * `HttpRepository` with the same five methods — no component changes.
 */
import type { BaseEntity, CollectionKey, CollectionMap, NewEntity } from "@/lib/types"
import { readCollection, writeCollection } from "@/lib/storage/local-store"
import { ensureSeeded } from "./bootstrap"
import { requestScope } from "@/lib/request-scope"
import { advanceVersion, assertVersion } from "@/lib/versions"

export interface Repository<T extends BaseEntity> {
  list(): Promise<T[]>
  get(id: string): Promise<T | null>
  create(input: NewEntity<T>): Promise<T>
  update(id: string, patch: Partial<NewEntity<T>>): Promise<T>
  remove(id: string): Promise<void>
}

export class NotFoundError extends Error {
  constructor(entity: string, id: string) {
    super(`${entity} ${id} not found`)
  }
}

/** Simulated network latency so loading states are visible and realistic. */
const LATENCY_MS = 60
export const latency = () => (requestScope() ? Promise.resolve() : new Promise((r) => setTimeout(r, LATENCY_MS)))

export function newId(prefix: string) {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 12)
      : Math.random().toString(36).slice(2, 14)
  return `${prefix}_${rand}`
}

export function createLocalRepository<K extends CollectionKey>(
  key: K,
  idPrefix: string
): Repository<CollectionMap[K]> {
  type T = CollectionMap[K]
  const all = () => {
    ensureSeeded()
    return readCollection(key)
  }
  return {
    async list() {
      await latency()
      return all()
    },
    async get(id) {
      await latency()
      return all().find((x) => x.id === id) ?? null
    },
    async create(input) {
      await latency()
      const now = new Date().toISOString()
      const item = { ...input, id: newId(idPrefix), createdAt: now, updatedAt: now } as T
      writeCollection(key, [...all(), item])
      return item
    },
    async update(id, patch) {
      await latency()
      const items = all()
      const idx = items.findIndex((x) => x.id === id)
      if (idx < 0) throw new NotFoundError(key, id)
      assertVersion(items[idx]) // a stale screen never overwrites someone else's newer change
      const updated = { ...items[idx], ...patch, id, updatedAt: new Date().toISOString() } as T
      advanceVersion(id, updated.updatedAt) // a later step of this call may change it again
      const next = items.slice()
      next[idx] = updated
      writeCollection(key, next)
      return updated
    },
    async remove(id) {
      await latency()
      const current = all().find((x) => x.id === id)
      if (current) assertVersion(current)
      writeCollection(
        key,
        all().filter((x) => x.id !== id)
      )
    },
  }
}
