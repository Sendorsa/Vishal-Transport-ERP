/**
 * The HTTP side of the shared-database backend: which `api.*` methods the browser may call, the verified identity of
 * the caller, the Postgres connection, and how errors reach the browser. Server only.
 */
import "server-only"
import postgres from "postgres"
import { api, PossibleDuplicateError } from "@/lib/api"
import { getServerAuth } from "@/lib/auth/session"
import type { RequestIdentity } from "@/lib/request-scope"
import { ConflictError } from "@/lib/versions"
import type { Role } from "@/lib/types"
import type { Transact } from "./engine"
import { PG_OPTIONS } from "./pg-options"

/* ------------------------------------------------------------------ connection (server-only secret) */

let client: ReturnType<typeof postgres> | null = null
/**
 * SUPABASE_DB_URL: the Supavisor pooler in transaction mode (port 6543) as the `erp_server` login (migration
 * 20261103000100) — never the service-role key, never a NEXT_PUBLIC_ variable. Prepared statements off (pooler).
 */
export function serverTransact(): Transact {
  const url = process.env.SUPABASE_DB_URL
  if (!url) throw new Error("The shared database isn't configured on this server (SUPABASE_DB_URL).")
  client ??= postgres(url, { ...PG_OPTIONS, ssl: "require" })
  return (fn) => client!.begin((tx) => fn((text, params) => tx.unsafe(text, (params ?? []) as never[]) as never)) as never
}

/* ------------------------------------------------------------------ who is calling */

/** The verified account of this request: a valid session (getClaims) and an ACTIVE profile. Never browser input. */
export async function requestIdentity(): Promise<RequestIdentity | { error: string; status: 401 | 403 }> {
  const auth = await getServerAuth()
  if (!auth.signedIn || !auth.userId) return { error: "Your session has ended. Sign in again.", status: 401 }
  if (auth.status !== "ACTIVE" || !auth.role || !auth.profileId) return { error: "Your Google account has no ERP access. Ask the system administrator.", status: 403 }
  return { userId: auth.userId, profileId: auth.profileId, role: auth.role as Role, email: auth.email, name: auth.fullName }
}

/* ------------------------------------------------------------------ the allowlist */

/** Reads run in a transaction without the write lock and never write. */
const READS = new Set(["list", "get", "history", "editedIds", "unreviewedDeletions", "checkRestore", "exportBackup"])
/** Never callable from the browser on the shared database (D-9): they would replace or wipe it. */
const BLOCKED = new Set(["admin.restoreBackup", "admin.resetDemoData", "admin.clearAllData"])

/** `namespace.method` → the function and whether it writes. Only methods of the public `api` object exist here. */
export function resolveMethod(name: unknown): { fn: (...args: unknown[]) => Promise<unknown>; write: boolean } | null {
  if (typeof name !== "string" || !/^[a-zA-Z]+\.[a-zA-Z]+$/.test(name) || BLOCKED.has(name)) return null
  const [ns, method] = name.split(".")
  const group = (api as unknown as Record<string, Record<string, unknown>>)[ns]
  if (!group || !Object.hasOwn(api, ns) || !Object.hasOwn(group, method)) return null
  const fn = group[method]
  if (typeof fn !== "function") return null
  const write = !(READS.has(method) || name === "settings.get")
  return { fn: fn as (...args: unknown[]) => Promise<unknown>, write }
}

/** Record versions the user's screen showed: string → string only. */
export function cleanVersions(v: unknown): Record<string, string> {
  if (!v || typeof v !== "object") return {}
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string" && e[0].length < 80))
}

/* ------------------------------------------------------------------ errors */

export interface ErpError {
  message: string
  code?: "CONFLICT" | "DUPLICATE"
  duplicate?: { id: string; label: string }
}

/**
 * The app's own checks (permission, month lock, stock, reasons, conflicts) keep their messages. A database refusal is
 * turned into business language; nothing else (SQL text, constraint names) ever reaches the browser.
 */
export function toErpError(e: unknown): { status: number; body: ErpError; log: boolean } {
  if (e instanceof ConflictError) return { status: 409, body: { message: e.message, code: "CONFLICT" }, log: false }
  if (e instanceof PossibleDuplicateError) return { status: 409, body: { message: e.message, code: "DUPLICATE", duplicate: e.duplicate }, log: false }
  const pg = e as { code?: string; message?: string; severity?: string }
  if (typeof pg?.code === "string" && /^[0-9A-Z]{5}$/.test(pg.code) && pg.severity) {
    const msg = pg.message ?? ""
    const business = !/^(new row|duplicate key|insert or update|update or delete|null value|.*violates)/i.test(msg) && !/no audit event/.test(msg)
    switch (pg.code) {
      case "23505": return { status: 409, body: { message: "That already exists (a duplicate name, registration, code or number)." }, log: false }
      case "23503": return { status: 409, body: { message: "This record is linked to other records and can't be changed that way." }, log: false }
      case "23P01": return { status: 409, body: { message: "Those dates overlap an existing period." }, log: false }
      case "40001": case "40P01": return { status: 409, body: { message: "Someone else saved at the same moment. Please try again." }, log: false }
      case "42501": return { status: 403, body: { message: business ? msg : "Your role or the month lock doesn't allow this change. Nothing was saved." }, log: false }
      case "23514": case "P0001": case "22023": if (business) return { status: 400, body: { message: msg }, log: false }
    }
    return { status: 500, body: { message: "Something went wrong. Nothing was saved." }, log: true }
  }
  if (e instanceof Error && !(e instanceof TypeError) && !(e instanceof RangeError)) return { status: 400, body: { message: e.message }, log: false }
  return { status: 500, body: { message: "Something went wrong. Nothing was saved." }, log: true }
}
