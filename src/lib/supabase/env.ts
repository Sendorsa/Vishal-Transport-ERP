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
  // The project's base URL only. Anything else (a path such as /rest/v1, the dashboard URL, a Vercel URL) makes
  // Supabase Auth answer {"error":"requested path is invalid"} instead of signing in.
  let base: URL | null = null
  try {
    base = new URL(url)
  } catch {
    /* refused below */
  }
  const local = base && (base.hostname === "localhost" || base.hostname === "127.0.0.1")
  if (!base || !(base.protocol === "https:" || (local && base.protocol === "http:")) || base.pathname !== "/" || base.search || base.hash || base.username)
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL must be the project's base URL — https://<project-ref>.supabase.co, with no path — as shown in Supabase → Settings → API."
    )
  if (key.startsWith("sb_secret_") || legacyJwtRole(key) === "service_role")
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY holds a secret key. Use the publishable key (sb_publishable_…) and rotate the secret key in the Supabase dashboard."
    )
  return { url: base.origin, key }
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
