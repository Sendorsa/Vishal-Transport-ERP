import type { SupabaseClient } from "@supabase/supabase-js"
import type { AccountStatus, Database, ErpRole } from "@/lib/supabase/database.types"

export interface Account {
  role: ErpRole
  status: AccountStatus
}

/**
 * The signed-in user's ERP account — a plain, read-only lookup of their own `public.profiles` row (RLS "Read own
 * account": user_id = auth.uid()). `userId` must be the verified JWT subject (getClaims). Linking a Google sign-in to a
 * pre-created account happens only in the OAuth callback (`link_google_account`), never on ordinary page loads.
 * Any error means "no account".
 */
export async function readAccount(supabase: SupabaseClient<Database>, userId: string): Promise<Account | null> {
  const { data, error } = await supabase.from("profiles").select("role, status").eq("user_id", userId).maybeSingle()
  return error || !data ? null : { role: data.role, status: data.status }
}
