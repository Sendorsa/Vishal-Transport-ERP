import { createServerClient } from "@supabase/ssr"
import { NextResponse, type NextRequest } from "next/server"
import { supabaseEnv } from "@/lib/supabase/env"

/**
 * Keeps the Supabase session cookie fresh on the account pages. Never an authorisation check: the server
 * actions verify the session and the role, and the database checks again. The rest of the ERP doesn't
 * require sign-in yet (owner's decision, 1 Nov 2026), so the matcher covers only the account pages.
 */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request })
  let env: ReturnType<typeof supabaseEnv>
  try {
    env = supabaseEnv()
  } catch {
    return response // not configured: the page explains it
  }
  const supabase = createServerClient(env.url, env.key, {
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
  await supabase.auth.getClaims() // refreshes an expiring session
  return response
}

export const config = {
  matcher: ["/login", "/settings/users"],
}
