import { createServerClient } from "@supabase/ssr"
import { NextResponse, type NextRequest } from "next/server"
import { supabaseEnv } from "@/lib/supabase/env"
import { gate, type AccountStatus } from "@/lib/auth/gate"
import { readAccount } from "@/lib/auth/account"
import { proxyRedirect } from "@/lib/auth/redirect"
import type { Database } from "@/lib/supabase/database.types"

/**
 * The sign-in gate for every page (and the server actions posted to them). Runs before anything renders, so a
 * signed-out or unapproved visitor never receives ERP content: no verified session → /login (remembering where
 * they were going); a session without an ACTIVE ERP account → /login, which explains why. It also refreshes an
 * expiring session cookie. Identity: getClaims() only; account: a read-only lookup of the caller's own profile
 * (readAccount). It never links accounts — that happens only in the OAuth callback.
 * Rules: src/lib/auth/gate.ts.
 */
export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname + request.nextUrl.search
  let env: ReturnType<typeof supabaseEnv>
  try {
    env = supabaseEnv()
  } catch {
    return apply(request, NextResponse.next({ request }), gate(path, { configured: false, signedIn: false, status: null }))
  }
  let response = NextResponse.next({ request })
  const supabase = createServerClient<Database>(env.url, env.key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(cookiesToSet, headers) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
        response = NextResponse.next({ request })
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options))
        Object.entries(headers).forEach(([key, value]) => response.headers.set(key, value))
      },
    },
  })
  const { data, error } = await supabase.auth.getClaims() // verifies the JWT; refreshes an expiring session
  const claims = error ? null : (data?.claims ?? null)
  const account = claims ? await readAccount(supabase, claims.sub) : null
  const status: AccountStatus | null = account?.status ?? null
  return apply(request, response, gate(path, { configured: true, signedIn: !!claims, status, role: account?.role ?? null }))
}

/**
 * Lets the request through, or redirects on the host the browser used (proxyRedirect: its Host header, never a
 * configured URL or `request.url`), carrying any refreshed session cookies along. Never cacheable.
 */
function apply(request: NextRequest, response: NextResponse, result: ReturnType<typeof gate>) {
  if (result.action === "allow") return response
  const redirect = proxyRedirect(request, result.to)
  response.cookies.getAll().forEach((c) => redirect.cookies.set(c))
  return redirect
}

export const config = {
  // Every page except Next.js assets, static files and the OAuth callback (which handles its own session).
  matcher: ["/((?!_next/static|_next/image|favicon.ico|auth/callback|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
}
