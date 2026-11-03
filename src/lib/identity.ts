/**
 * Who is calling the API (`api.*`) — the one source for permission checks and audit attribution.
 *
 * - On the server (Supabase backend): the verified account of the request (src/lib/server/erp), never anything the
 *   browser sent. No request scope on the server = no identity: it throws. There is no fallback to Owner.
 * - In the browser (localStorage backend): the signed-in account's role, handed down by AppShell (setVerifiedSession);
 *   without a session (the offline checks) the stored `vt:ui:role`, as before.
 */
import { requestScope } from "./request-scope"
import type { AuditActor, LegacyRole, Role } from "./types"

const ROLE_KEY = "vt:ui:role"
const ROLES: readonly Role[] = ["OWNER", "DEV", "EMPLOYEE"]
const LEGACY: readonly LegacyRole[] = ["ACCOUNTANT", "OPS_MANAGER"]

// The verified account for code outside React in the browser. Browser only: on the server, module state would be
// shared between requests (the server uses the request scope instead).
let verified: { role: Role; email: string | null } | null = null
export function setVerifiedSession(session: { role: Role; email: string | null } | null) {
  if (typeof window !== "undefined") verified = session
}

/**
 * The stored session role (browser, no signed-in session). A removed role (Accountant / Operations Manager,
 * 31 Oct 2026) reads as Employee — never the unknown-role fallback to Owner, which would promote it.
 */
export function readStoredRole(): Role {
  if (verified) return verified.role
  try {
    const v = window.localStorage.getItem(ROLE_KEY)
    if (LEGACY.includes(v as LegacyRole)) return "EMPLOYEE"
    return v && ROLES.includes(v as Role) ? (v as Role) : "OWNER"
  } catch {
    return "OWNER"
  }
}

/** Current role outside React (the API's "who is calling"). */
export function currentRole(): Role {
  const scope = requestScope()
  if (scope) return scope.identity.role
  if (typeof window === "undefined") throw new Error("Not signed in: no verified account for this request.")
  return readStoredRole()
}

/**
 * Who is acting, for the audit trail. Server: the verified profile (id, name or email, role). Browser: the signed-in
 * account's role and email (no profile id in the browser); none of it is ever invented.
 */
export function currentActor(): AuditActor {
  const scope = requestScope()
  if (scope) {
    const { profileId, name, email, role } = scope.identity
    return { kind: "SESSION", userId: profileId, name: name ?? email, role }
  }
  return { kind: "SESSION", userId: null, name: verified?.email ?? null, role: currentRole() }
}
