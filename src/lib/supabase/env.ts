/**
 * Supabase connection settings. Only the publishable key may be public: it is safe in the browser because
 * Row Level Security decides what it can read. The secret / service_role key is refused here so it can
 * never be shipped in a NEXT_PUBLIC_ variable by mistake.
 */
export function supabaseEnv() {
  // Literal process.env reads: Next.js inlines NEXT_PUBLIC_ values into the browser bundle only this way.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  if (!url || !key)
    throw new Error(
      "Supabase is not configured: set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY in prototype/.env.local (see SUPABASE_SETUP.md)."
    )
  if (key.startsWith("sb_secret_") || legacyJwtRole(key) === "service_role")
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY holds a secret key. Use the publishable key (sb_publishable_…) and rotate the secret key in the Supabase dashboard."
    )
  return { url, key }
}

/** The role inside a legacy JWT-style key (anon / service_role); undefined for the new sb_… keys. */
function legacyJwtRole(key: string): string | undefined {
  try {
    const payload = key.split(".")[1]
    return payload ? JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))).role : undefined
  } catch {
    return undefined
  }
}
