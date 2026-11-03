import type { SupabaseClient } from "@supabase/supabase-js"
import type { AccountStatus, Database, ErpRole } from "@/lib/supabase/database.types"

export interface Account {
  /** public.profiles.id — the audit trail's actor id. */
  id: string
  role: ErpRole
  status: AccountStatus
  fullName: string | null
}

/**
 * The signed-in user's ERP account — a plain, read-only lookup of their own `public.profiles` row (RLS "Read own
 * account": user_id = auth.uid()). `userId` must be the verified JWT subject (getClaims). Linking a Google sign-in to a
 * pre-created account happens only in the OAuth callback (`link_google_account`), never on ordinary page loads.
 * Any error means "no account".
 */
export async function readAccount(supabase: SupabaseClient<Database>, userId: string): Promise<Account | null> {
  const { data, error } = await supabase.from("profiles").select("id, role, status, full_name").eq("user_id", userId).maybeSingle()
  return error || !data ? null : { id: data.id, role: data.role, status: data.status, fullName: data.full_name }
}
