/**
 * Who may open which page (owner's decision, 1 Nov 2026): the whole ERP requires a signed-in Google user whose
 * pre-created account is ACTIVE. One pure function so the proxy's decisions are testable (gate.check.ts).
 * `src/proxy.ts` applies it to every page request before anything renders.
 */
import type { Role } from "@/lib/types"

export type AccountStatus = "INVITED" | "ACTIVE" | "DISABLED"

export interface AuthState {
  configured: boolean // Supabase URL and publishable key are set
  signedIn: boolean // a verified Supabase session (getClaims)
  status: AccountStatus | null // the caller's ERP account, null when there is none
  role?: Role | null // that account's role (the AdBlue profiles see only AdBlue and Diesel)
}

export type GateResult = { action: "allow" } | { action: "redirect"; to: string }

export const LANDING = "/fuel-stations"
/** Where an AdBlue profile (Tata Adblue, Adblue) opens the ERP — and where any page it may not open sends it. */
export const PROFILE_LANDING = "/adblue"
export const landingFor = (role: Role | null | undefined) => (role === "TATA_ADBLUE" || role === "ADBLUE" ? PROFILE_LANDING : LANDING)

/**
 * The pages an AdBlue profile may open (owner, 11 Nov 2026): AdBlue, and Diesel → customer → month → vehicle. Never the
 * Diesel ledger or any other module; the Monthly / Quarterly / Yearly Masters for Adblue only. A positive list: any
 * other path (and any other role here) is refused. /api/* is not a page: the API enforces its own method list.
 */
export function profilePageAllowed(role: Role, pathname: string) {
  if (pathname === "/adblue" || pathname === "/diesel") return true
  const parts = pathname.split("/").filter(Boolean)
  if (parts[0] !== "diesel" || parts.length > 4) return false
  if (parts[1] === "ledger") return false
  if (["monthly-master", "quarterly-master", "yearly-master"].includes(parts[1])) return role === "ADBLUE" && parts.length === 2
  return true
}

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

/**
 * Where Google sign-in must return: this deployment's own callback, built from the origin the browser is on
 * (`window.location.origin`) — never a configured or hard-coded host, so localhost returns to localhost and the Vercel
 * domain to the Vercel domain. Supabase honours it only if it is on its Redirect URLs allow list; otherwise it falls
 * back to its Site URL (SUPABASE_SETUP.md §5).
 */
export function oauthCallbackUrl(origin: string): string {
  const o = new URL(origin)
  if ((o.protocol !== "https:" && o.protocol !== "http:") || o.origin !== origin.replace(/\/$/, "")) throw new Error(`Not an origin: ${origin}`)
  return `${o.origin}/auth/callback`
}

/** `path` is the request's pathname plus search (e.g. "/diesel?month=2026-11"). */
export function gate(path: string, s: AuthState): GateResult {
  const url = new URL(path, "http://erp.local")
  // Supabase returns a sign-in to its Site URL (the site root) when the requested callback isn't allow-listed: finish
  // it here, on the host the browser is on (the PKCE check in the callback still decides whether it succeeds).
  if (url.pathname === "/" && (url.searchParams.has("code") || url.searchParams.has("error"))) {
    const keep = new URLSearchParams()
    for (const k of ["code", "error", "error_description"]) if (url.searchParams.has(k)) keep.set(k, url.searchParams.get(k)!)
    return { action: "redirect", to: `/auth/callback?${keep}` }
  }
  const onLogin = url.pathname === "/login"
  if (!s.configured) return onLogin ? { action: "allow" } : { action: "redirect", to: "/login" }
  if (!s.signedIn) {
    if (onLogin) return { action: "allow" }
    const next = url.pathname === "/" ? null : safeNext(path)
    return { action: "redirect", to: next && next !== LANDING ? `/login?next=${encodeURIComponent(next)}` : "/login" }
  }
  if (s.status !== "ACTIVE") return onLogin ? { action: "allow" } : { action: "redirect", to: "/login" } // the login page explains why
  const home = landingFor(s.role)
  if (onLogin) {
    const next = safeNext(url.searchParams.get("next"))
    return { action: "redirect", to: next === LANDING ? home : next }
  }
  if (url.pathname === "/") return { action: "redirect", to: home }
  if ((s.role === "TATA_ADBLUE" || s.role === "ADBLUE") && !url.pathname.startsWith("/api/") && !profilePageAllowed(s.role, url.pathname)) return { action: "redirect", to: home }
  return { action: "allow" }
}
