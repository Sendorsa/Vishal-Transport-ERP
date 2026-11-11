/**
 * The per-request scope used when `api.*` runs on the server against Supabase (src/lib/server/erp). It carries the
 * verified identity and the request's in-memory copy of the business data. Plain module (no Node imports) so the
 * browser bundle can import it: the server registers an AsyncLocalStorage-backed getter; in the browser and the
 * offline checks there is no scope and everything behaves as before (localStorage).
 */
import type { AuditEvent, AuditReview, Role } from "./types"

export interface RequestIdentity {
  /** public.profiles.id of the signed-in ACTIVE account. */
  profileId: string
  /** auth.users id (the verified JWT subject). */
  userId: string
  role: Role
  email: string | null
  name: string | null
}

export interface RequestScope {
  identity: RequestIdentity
  /** Parsed collections, keyed like localStorage ("vt:fuelEntries"…), loaded from the database for this request. */
  cache: Map<string, unknown>
  /** Keys written during the request (the unit of work turns them into SQL). */
  written: Set<string>
  /** Record id → the version (updatedAt) the user's screen showed. A different stored version = a conflict. */
  expected: Record<string, string>
  /** Audit events and reviews appended by this request (inserted with the changes, in the same transaction). */
  newEvents: AuditEvent[]
  newReviews: AuditReview[]
  /** Tata Adblue only: the customers Dev granted (core.profile_customer_access), loaded once per request. */
  customerIds?: ReadonlySet<string>
}

/**
 * Thrown when the API reads a collection the request hasn't loaded yet: the server loads it and runs the method again
 * from the start (nothing is written before a method finishes, so the re-run is safe). Never caught by business code.
 */
export class NeedData extends Error {
  constructor(readonly key: string) {
    super(`Data not loaded yet: ${key}`)
  }
}

let getter: () => RequestScope | undefined = () => undefined

/** Called once by the server module that owns the AsyncLocalStorage. */
export function registerScopeGetter(fn: () => RequestScope | undefined) {
  getter = fn
}

export const requestScope = () => getter()
