/**
 * Who may open which page (owner's decision, 1 Nov 2026): the whole ERP requires a signed-in Google user whose
 * pre-created account is ACTIVE. One pure function so the proxy's decisions are testable (gate.check.ts).
 * `src/proxy.ts` applies it to every page request before anything renders.
 */
export type AccountStatus = "INVITED" | "ACTIVE" | "DISABLED"

export interface AuthState {
  configured: boolean // Supabase URL and publishable key are set
  signedIn: boolean // a verified Supabase session (getClaims)
  status: AccountStatus | null // the caller's ERP account, null when there is none
}

export type GateResult = { action: "allow" } | { action: "redirect"; to: string }

export const LANDING = "/fuel-stations"
export const COOKIE_NEXT = "erp_next" // where to return after Google sign-in (short-lived, set by the login page)

/**
 * A safe in-app destination: a same-origin path, never the login / callback pages; otherwise the landing page.
 * Rejects anything a browser could turn into another site — "//host", backslashes, and control characters or
 * whitespace (browsers drop tabs and newlines from URLs, so "/\t/host" would become "//host") — and re-checks the
 * parsed result stays on this origin.
 */
export function safeNext(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || /[\\\s\u0000-\u001f\u007f]/.test(raw)) return LANDING
  let url: URL
  try {
    url = new URL(raw, "http://erp.local")
  } catch {
    return LANDING
  }
  if (url.origin !== "http://erp.local") return LANDING
  const path = url.pathname
  if (path === "/" || path === "/login" || path.startsWith("/login/") || path.startsWith("/auth/")) return LANDING
  return url.pathname + url.search + url.hash
}

/** `path` is the request's pathname plus search (e.g. "/diesel?month=2026-11"). */
export function gate(path: string, s: AuthState): GateResult {
  const url = new URL(path, "http://erp.local")
  const onLogin = url.pathname === "/login"
  if (!s.configured) return onLogin ? { action: "allow" } : { action: "redirect", to: "/login" }
  if (!s.signedIn) {
    if (onLogin) return { action: "allow" }
    const next = url.pathname === "/" ? null : safeNext(path)
    return { action: "redirect", to: next && next !== LANDING ? `/login?next=${encodeURIComponent(next)}` : "/login" }
  }
  if (s.status !== "ACTIVE") return onLogin ? { action: "allow" } : { action: "redirect", to: "/login" } // the login page explains why
  if (onLogin) return { action: "redirect", to: safeNext(url.searchParams.get("next")) }
  if (url.pathname === "/") return { action: "redirect", to: LANDING }
  return { action: "allow" }
}
