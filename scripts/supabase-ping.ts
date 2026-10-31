/**
 * Live connection check against the Supabase project in .env.local (`npm run supabase:ping`).
 * Contacts the project for real; reports exactly what is and isn't set up. Read-only: writes nothing.
 */
import { createClient } from "@supabase/supabase-js"
import type { Database } from "../src/lib/supabase/database.types"
import { supabaseEnv } from "../src/lib/supabase/env"

async function main() {
  try {
    process.loadEnvFile(".env.local")
  } catch {
    throw new Error("No prototype/.env.local. Copy .env.example to .env.local and fill in the two values (see SUPABASE_SETUP.md).")
  }
  const { url, key } = supabaseEnv()
  console.log(`Supabase project: ${url}`)

  // 1. Auth settings: proves the URL and key are accepted, and shows the sign-in setup.
  const res = await fetch(`${url}/auth/v1/settings`, { headers: { apikey: key } }).catch((e) => {
    throw new Error(`Can't reach ${url} (${e.cause?.code ?? e.message}). Check NEXT_PUBLIC_SUPABASE_URL.`)
  })
  if (res.status === 401 || res.status === 403) throw new Error(`The project rejected the key (HTTP ${res.status}). Check NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.`)
  if (!res.ok) throw new Error(`Auth settings returned HTTP ${res.status}.`)
  const auth = (await res.json()) as { external?: Record<string, boolean>; disable_signup?: boolean }
  console.log("✓ Connected: URL and publishable key accepted")
  console.log(`  Google sign-in: ${auth.external?.google ? "enabled" : "not enabled yet"}`)
  console.log(`  Email sign-in:  ${auth.external?.email ? "enabled (turn off for the ERP)" : "off"}`)

  // 2. Database: the accounts table exists and anonymous visitors can't read it.
  const { error } = await createClient<Database>(url, key, { auth: { persistSession: false } }).from("profiles").select("id").limit(1)
  if (!error) throw new Error("public.profiles is readable without signing in. Re-apply supabase/migrations before going further.")
  if (error.code === "42501") console.log("✓ Database reached: accounts table exists and is closed to anonymous visitors")
  else if (error.code === "PGRST205" || error.code === "42P01") console.log("• Database reached, but the migration isn't applied yet (see SUPABASE_SETUP.md step 3)")
  else throw new Error(`Database query failed: ${error.code} ${error.message}`)
}

main().catch((e) => {
  console.error(`✗ ${e.message}`)
  process.exit(1)
})
