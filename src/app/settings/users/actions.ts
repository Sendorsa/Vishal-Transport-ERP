"use server"
/**
 * Settings → Users: account state and DEV-only account management (docs/SUPABASE_INTEGRATION_PLAN.md §3).
 * Identity comes only from the verified Supabase session (getClaims), never from the ERP's mock role switcher.
 * The server checks the DEV role by name before every change; the database functions check it again
 * (20261101000700_accounts.sql) and write the audit event in the same transaction.
 */
import type { PostgrestError } from "@supabase/supabase-js"
import { createClient } from "@/lib/supabase/server"
import type { AccountStatus, Database, ErpRole } from "@/lib/supabase/database.types"

type ProfileRow = Database["public"]["Tables"]["profiles"]["Row"]

export interface Account {
  id: string
  email: string
  fullName: string | null
  role: ErpRole
  status: AccountStatus
  linked: boolean
  activatedAt: string | null
  createdAt: string
}

export type AccountState =
  | { kind: "unconfigured"; message: string }
  | { kind: "signed-out" }
  | { kind: "no-account"; email: string | null }
  | { kind: "signed-in"; me: Account; accounts: Account[] | null } // accounts: DEV only

export type Result = { ok: true } | { ok: false; error: string }

const ROLES: readonly ErpRole[] = ["OWNER", "DEV", "EMPLOYEE"]

const toAccount = (p: ProfileRow): Account => ({
  id: p.id,
  email: p.email,
  fullName: p.full_name,
  role: p.role,
  status: p.status,
  linked: p.user_id !== null,
  activatedAt: p.activated_at,
  createdAt: p.created_at,
})

/** The verified session and the caller's own account (linking a pre-created account at first Google sign-in). */
async function session() {
  const supabase = await createClient() // throws a setup message when Supabase isn't configured
  const { data, error } = await supabase.auth.getClaims()
  const claims = error ? null : (data?.claims ?? null)
  if (!claims) return { supabase, claims: null, me: null }
  const own = () => supabase.from("profiles").select("*").eq("user_id", claims.sub).maybeSingle()
  let { data: me } = await own()
  if (!me) {
    await supabase.rpc("link_google_account") // no-op unless a pre-created account matches the Google-verified email
    ;({ data: me } = await own())
  }
  return { supabase, claims, me }
}

export async function getAccountState(): Promise<AccountState> {
  let s: Awaited<ReturnType<typeof session>>
  try {
    s = await session()
  } catch (e) {
    return { kind: "unconfigured", message: e instanceof Error ? e.message : String(e) }
  }
  if (!s.claims) return { kind: "signed-out" }
  if (!s.me) return { kind: "no-account", email: typeof s.claims.email === "string" ? s.claims.email : null }
  const isDev = s.me.role === "DEV" && s.me.status === "ACTIVE"
  const all = isDev ? (await s.supabase.from("profiles").select("*").order("created_at")).data : null
  return { kind: "signed-in", me: toAccount(s.me), accounts: all ? all.map(toAccount) : null }
}

/** Runs one account operation for an ACTIVE DEV only (checked here by name, and again in the database). */
async function asDev(op: (supabase: Awaited<ReturnType<typeof createClient>>) => PromiseLike<{ error: PostgrestError | null }>): Promise<Result> {
  let s: Awaited<ReturnType<typeof session>>
  try {
    s = await session()
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  if (!s.claims) return { ok: false, error: "Sign in with Google first." }
  if (s.me?.role !== "DEV" || s.me.status !== "ACTIVE") return { ok: false, error: "Only Dev can manage user accounts." }
  const { error } = await op(s.supabase)
  return error ? { ok: false, error: message(error) } : { ok: true }
}

/** The database's own business messages pass through; anything unexpected is logged, never shown raw. */
function message(e: PostgrestError) {
  if (e.code === "23505") return "An account with this email already exists." // never the raw constraint text
  if (["42501", "22023", "P0002"].includes(e.code)) return e.message
  if (e.code === "23514") return "Enter a valid email address."
  console.error("account operation failed", e.code, e.message)
  return "Something went wrong; nothing was saved."
}

const text = (v: unknown) => (typeof v === "string" ? v : "")
const badRole = (r: unknown) => !ROLES.includes(r as ErpRole)

export async function addAccount(email: string, role: ErpRole, fullName?: string): Promise<Result> {
  if (badRole(role)) return { ok: false, error: "Choose a role." }
  return asDev((s) => s.rpc("add_account", { p_email: text(email), p_role: role, p_full_name: text(fullName) || null }))
}

export async function setAccountRole(id: string, role: ErpRole, reason: string): Promise<Result> {
  if (badRole(role)) return { ok: false, error: "Choose a role." }
  return asDev((s) => s.rpc("set_account_role", { p_id: text(id), p_role: role, p_reason: text(reason) }))
}

export async function setAccountStatus(id: string, status: "ACTIVE" | "DISABLED", reason: string): Promise<Result> {
  if (status !== "ACTIVE" && status !== "DISABLED") return { ok: false, error: "An account can only be deactivated or reactivated." }
  return asDev((s) => s.rpc("set_account_status", { p_id: text(id), p_status: status, p_reason: text(reason) }))
}

export async function relinkAccount(id: string, newEmail: string, reason: string): Promise<Result> {
  return asDev((s) => s.rpc("relink_account", { p_id: text(id), p_new_email: text(newEmail), p_reason: text(reason) }))
}
