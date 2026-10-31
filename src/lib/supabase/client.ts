import { createBrowserClient } from "@supabase/ssr"
import type { Database } from "./database.types"
import { supabaseEnv } from "./env"

/**
 * Supabase client for Client Components (Google sign-in, phase 2). Not used by the ERP yet: business data
 * still goes through src/lib/api → localStorage. Business writes will go through the server, never this client.
 */
export function createClient() {
  const { url, key } = supabaseEnv()
  return createBrowserClient<Database>(url, key)
}
