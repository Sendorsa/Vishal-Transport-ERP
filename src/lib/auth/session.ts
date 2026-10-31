import "server-only"
import { cache } from "react"
import { createClient } from "@/lib/supabase/server"
import type { ErpRole } from "@/lib/supabase/database.types"
import type { AccountStatus } from "./gate"
import { readAccount } from "./account"

export interface ServerAuth {
  configured: boolean
  signedIn: boolean
  email: string | null
  status: AccountStatus | null
  role: ErpRole | null
}

/**
 * The verified session and the caller's ERP account, once per request. Identity comes only from getClaims()
 * (a verified JWT); the account (role, status) is read from the database (readAccount — read-only; linking happens
 * only in the OAuth callback). Any failure means "no access" — never a guess.
 */
export const getServerAuth = cache(async (): Promise<ServerAuth> => {
  let supabase: Awaited<ReturnType<typeof createClient>>
  try {
    supabase = await createClient()
  } catch {
    return { configured: false, signedIn: false, email: null, status: null, role: null }
  }
  const { data, error } = await supabase.auth.getClaims()
  const claims = error ? null : (data?.claims ?? null)
  if (!claims) return { configured: true, signedIn: false, email: null, status: null, role: null }
  const email = typeof claims.email === "string" ? claims.email : null
  const account = await readAccount(supabase, claims.sub)
  return { configured: true, signedIn: true, email, status: account?.status ?? null, role: account?.role ?? null }
})
