import { createServerClient } from "@supabase/ssr"
import { cookies } from "next/headers"
import type { Database } from "./database.types"
import { supabaseEnv } from "./env"

/**
 * Supabase client for Server Components, Server Functions and Route Handlers, acting as the signed-in user
 * (session in cookies, so Row Level Security applies). Create one per request. Not used by the ERP yet.
 * Authorise with `supabase.auth.getClaims()` / `getUser()`, never `getSession()` (unverified cookie data).
 */
export async function createClient() {
  const { url, key } = supabaseEnv()
  const cookieStore = await cookies()
  return createServerClient<Database>(url, key, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options))
        } catch {
          // Server Components can't set cookies. The session-refresh proxy (added with sign-in, phase 2) does it.
        }
      },
    },
  })
}
