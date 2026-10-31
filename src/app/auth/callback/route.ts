import { cookies } from "next/headers"
import type { NextRequest } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { COOKIE_NEXT, safeNext } from "@/lib/auth/gate"
import { sameHostRedirect as go } from "@/lib/auth/redirect"

/**
 * Google sign-in returns here. Exchanges the code for a session (cookies), then links the caller to their
 * pre-created account if its email equals the email Google verified (`link_google_account`; no invitation email
 * exists). Signing in grants nothing by itself. An ACTIVE account goes on to the page it was heading for (or Fuel
 * Stations); no account, a deactivated one or an error goes back to /login, which explains it.
 */
export async function GET(request: NextRequest) {
  const url = request.nextUrl
  const cookieStore = await cookies()
  const remembered = cookieStore.get(COOKIE_NEXT)?.value
  let next = safeNext(null)
  try {
    next = safeNext(remembered ? decodeURIComponent(remembered) : null)
  } catch {
    /* malformed cookie: go to the landing page */
  }
  cookieStore.delete(COOKIE_NEXT)
  const to = new URLSearchParams()
  const code = url.searchParams.get("code")
  if (!code) {
    to.set("error", "cancelled")
    return go(`/login?${to}`)
  }
  try {
    const supabase = await createClient()
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (error) throw error
    const { data, error: linkError } = await supabase.rpc("link_google_account")
    if (linkError) throw linkError
    if (data?.[0]?.status === "ACTIVE") return go(next)
  } catch (e) {
    console.error("sign-in callback failed", e instanceof Error ? e.message : e)
    to.set("error", "failed")
  }
  return go(to.size ? `/login?${to}` : "/login")
}
