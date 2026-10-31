import { NextResponse, type NextRequest } from "next/server"
import { createClient } from "@/lib/supabase/server"

/**
 * Google sign-in returns here. Exchanges the code for a session (cookies), then links the caller to their
 * pre-created account if its email equals the email Google verified (no invitation email exists). Signing in
 * grants nothing by itself: without an ACTIVE account the database gives no access. Always lands on Settings →
 * User accounts, which shows the outcome.
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url)
  const to = new URL("/settings/users", url.origin)
  const code = url.searchParams.get("code")
  if (!code) {
    to.searchParams.set("error", url.searchParams.get("error_description") ?? "Sign-in was cancelled.")
    return NextResponse.redirect(to)
  }
  try {
    const supabase = await createClient()
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (error) throw error
    const { error: claimError } = await supabase.rpc("link_google_account")
    if (claimError) throw claimError
  } catch (e) {
    console.error("sign-in callback failed", e instanceof Error ? e.message : e)
    to.searchParams.set("error", "Sign-in failed. Please try again.")
  }
  return NextResponse.redirect(to)
}
