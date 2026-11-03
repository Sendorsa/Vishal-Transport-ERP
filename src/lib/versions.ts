/**
 * Optimistic concurrency (owner's decision OD-6, 3 Nov 2026): an edit or delete carries the version (`updatedAt`) of
 * the record the user's screen showed. If someone else saved the record since, the write is refused with a clear
 * message instead of silently overwriting their change. One check, in the shared repository update / remove
 * (src/lib/api/repository.ts), so every API method that changes an existing record is covered.
 *
 * - Callers (the mutation hooks) wrap the API call: `withVersions({ [id]: record.updatedAt }, () => api.x.update(…))`.
 * - The browser backend captures the versions when the call starts (the API's `tx`); the server backend receives them
 *   with the request and keeps them in the request scope.
 * - Versions are carried as the exact text the backend gave (never through `Date`: the database keeps microseconds).
 */
import { requestScope } from "./request-scope"

export class ConflictError extends Error {
  readonly code = "CONFLICT"
  constructor() {
    super("Someone else changed this record after you opened it. Reload to see their change, then try again.")
  }
}

let pending: Record<string, string> | null = null
let active: Record<string, string> | null = null

const clean = (v: Record<string, string | undefined | null>) => Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === "string" && e[1] !== ""))

/** Runs `call` (an API call) with the versions the user saw. Synchronous capture: the API reads them as it starts. */
export function withVersions<T>(versions: Record<string, string | undefined | null>, call: () => T): T {
  const prev = pending
  pending = clean(versions)
  try {
    return call()
  } finally {
    pending = prev
  }
}

/** The versions attached to the API call that is starting now (read synchronously by `tx` and the remote client). */
export const pendingVersions = () => pending

/** Browser backend: the versions of the transaction that is running (transactions run one at a time). */
export async function runWithVersions<T>(versions: Record<string, string> | null, fn: () => Promise<T>): Promise<T> {
  active = versions
  try {
    return await fn()
  } finally {
    active = null
  }
}

/** Throws ConflictError when the user's version of `record` is not the stored one. No version given = no check. */
export function assertVersion(record: { id: string; updatedAt: string }) {
  const expected = (requestScope()?.expected ?? active ?? {})[record.id]
  if (expected !== undefined && expected !== record.updatedAt) throw new ConflictError()
}
