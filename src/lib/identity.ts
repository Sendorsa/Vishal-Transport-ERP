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
const ROLES: readonly Role[] = ["OWNER", "DEV", "EMPLOYEE", "TATA_ADBLUE", "ADBLUE"]
const LEGACY: readonly LegacyRole[] = ["ACCOUNTANT", "OPS_MANAGER"]

// The verified account for code outside React in the browser. Browser only: on the server, module state would be
// shared between requests (the server uses the request scope instead).
let verified: { role: Role; email: string | null } | null = null
export function setVerifiedSession(session: { role: Role; email: string | null } | null) {
  if (typeof window === "undefined") return
  verified = session
  // Signed out, session ended, or another account: a preview never outlives the DEV session that started it.
  if (!session || session.role !== "DEV" || session.email !== preview?.email) preview = null
}

/**
 * UI Preview Mode (DEV role preview). A signed-in DEV can look at the ERP as the Owner or the Employee sees it:
 * navigation, pages and buttons follow the previewed role (useRole / useCan). It changes the interface only — not the
 * authenticated identity and not backend permissions: the API's role (currentRole, currentActor) and the server's
 * identity stay the verified DEV account, so a preview never gains any permission.
 * Writes through the normal application UI are blocked to prevent accidental changes (client.ts). This is a browser
 * guard, not a security boundary: DEV retains their actual DEV permissions, and direct API or database requests may
 * still modify data (recorded as DEV). In memory only: a reload, sign-out or a different account ends it. Never
 * stored, never sent to the server.
 */
let preview: { role: Role; email: string | null } | null = null
const previewListeners = new Set<() => void>()

/** Starts (OWNER / EMPLOYEE) or ends (null / DEV) a preview. Ignored unless the verified account is DEV. */
export function setPreviewRole(role: Role | null) {
  if (typeof window === "undefined") return
  preview = role && role !== "DEV" && verified?.role === "DEV" ? { role, email: verified.email } : null
  previewListeners.forEach((l) => l())
}

/** The role being previewed, or null — only ever for the verified DEV session that started it. */
export function previewRole(): Role | null {
  return preview && verified?.role === "DEV" && verified.email === preview.email ? preview.role : null
}

export function subscribePreview(cb: () => void) {
  previewListeners.add(cb)
  return () => void previewListeners.delete(cb)
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

/**
 * The customers the caller may work with: null = every customer. Tata Adblue: the customers Dev granted, loaded by the
 * server for each request (engine.ts) — without a request scope (the browser backend) none, so it fails closed.
 */
export function customerScope(): ReadonlySet<string> | null {
  if (currentRole() !== "TATA_ADBLUE") return null
  return requestScope()?.customerIds ?? new Set()
}
