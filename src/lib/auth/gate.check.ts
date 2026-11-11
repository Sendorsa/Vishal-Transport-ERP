/**
 * Offline checks for the sign-in gate (src/lib/auth/gate.ts, applied by src/proxy.ts) and for the role binding:
 * signed-out, expired, unapproved, deactivated and approved visitors on every kind of page, safe return paths,
 * no redirect loops, the proxy matcher, and that a signed-in account's role wins over the browser's stored role.
 */
import assert from "node:assert/strict"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { setRole } from "@/lib/api/test-browser"
import { currentRole, setVerifiedRole } from "@/lib/app-state"
import { can } from "@/lib/permissions"
import { NextRequest } from "next/server"
import { config, proxy } from "@/proxy"
import { gate, LANDING, landingFor, oauthCallbackUrl, PROFILE_LANDING, safeNext, type AuthState } from "./gate"
import { sameHostRedirect } from "./redirect"

const OUT: AuthState = { configured: true, signedIn: false, status: null } // signed out, or an expired session
const ACTIVE: AuthState = { configured: true, signedIn: true, status: "ACTIVE" }
const NOT_APPROVED: AuthState = { configured: true, signedIn: true, status: null }
const DISABLED: AuthState = { configured: true, signedIn: true, status: "DISABLED" }
const INVITED: AuthState = { configured: true, signedIn: true, status: "INVITED" }
const UNCONFIGURED: AuthState = { configured: false, signedIn: false, status: null }
const to = (path: string, s: AuthState) => {
  const r = gate(path, s)
  return r.action === "redirect" ? r.to : "allow"
}

/* ---------------------------------------------------------------- safe return paths */
for (const bad of [null, "", "dashboard", "//evil.example", "https://evil.example", "/\\evil.example", "/\t/evil.example", "/\n/evil.example", "/ /evil.example", "/\u0000x", "/", "/login", "/login?next=/x", "/auth/callback?code=1", "/auth/../login"])
  assert.equal(safeNext(bad), LANDING, `unsafe or pointless return path ${JSON.stringify(bad)} → landing page`)
assert.equal(safeNext("/dashboard"), "/dashboard")
assert.equal(safeNext("/diesel?month=2026-11"), "/diesel?month=2026-11", "query strings are kept")
assert.equal(safeNext("/login/../dashboard"), "/dashboard", "dot segments are resolved before the checks")
assert.equal(safeNext("/%2F%2Fevil.example"), "/%2F%2Fevil.example", "encoded slashes stay a same-site path")

/* ---------------------------------------------------------------- signed out (or session expired) */
assert.equal(to("/", OUT), "/login", "opening the site signed out goes to the login page")
assert.equal(to("/fuel-stations", OUT), "/login", "the landing page needs no return path")
assert.equal(to("/dashboard", OUT), "/login?next=%2Fdashboard", "the destination is remembered")
assert.equal(to("/diesel?month=2026-11", OUT), "/login?next=%2Fdiesel%3Fmonth%3D2026-11", "…with its query string")
for (const page of ["/customers", "/vehicles/v1", "/trips/new", "/invoices", "/payments", "/reports", "/tanker", "/adblue", "/audit", "/settings", "/settings/users"])
  assert.match(to(page, OUT), /^\/login\?next=/, `${page} requires sign-in`)
assert.equal(to("/login", OUT), "allow", "the login page is open")

/* ---------------------------------------------------------------- approved and signed in (DEV, OWNER, EMPLOYEE alike: the role decides what's inside) */
assert.equal(to("/", ACTIVE), LANDING, "an approved user opening the site lands on Fuel Stations")
assert.equal(to("/fuel-stations", ACTIVE), "allow")
assert.equal(to("/dashboard", ACTIVE), "allow", "the Dashboard stays reachable")
assert.equal(to("/settings/users", ACTIVE), "allow")
assert.equal(to("/login", ACTIVE), LANDING, "an approved user isn't shown the login page")
assert.equal(to("/login?next=%2Fdashboard", ACTIVE), "/dashboard", "…and goes where they were heading")
assert.equal(to("/login?next=%2F%2Fevil.example", ACTIVE), LANDING, "…never to another site")

/* ---------------------------------------------------------------- signed in without an approved, active account */
for (const [label, s] of [["unapproved Google account", NOT_APPROVED], ["deactivated account", DISABLED], ["account never linked", INVITED]] as const) {
  for (const page of ["/", "/fuel-stations", "/dashboard", "/settings/users", "/diesel"]) assert.equal(to(page, s), "/login", `${label}: ${page} → login`)
  assert.equal(to("/login", s), "allow", `${label}: the login page explains it (no redirect loop)`)
}

/* ---------------------------------------------------------------- Supabase not configured: fail closed */
assert.equal(to("/fuel-stations", UNCONFIGURED), "/login", "no Supabase settings → nobody gets in")
assert.equal(to("/login", UNCONFIGURED), "allow")

/* ---------------------------------------------------------------- no redirect loops, from any page, in any state */
for (const s of [OUT, ACTIVE, NOT_APPROVED, DISABLED, INVITED, UNCONFIGURED])
  for (const start of ["/", "/fuel-stations", "/dashboard", "/login", "/login?next=%2Fdashboard", "/settings/users?x=1"]) {
    let path = start
    let hops = 0
    while (gate(path, s).action === "redirect") {
      path = (gate(path, s) as { to: string }).to
      assert.ok(++hops <= 2, `redirects settle within two hops (${start}, ${JSON.stringify(s)})`)
    }
  }

/* ---------------------------------------------------------------- the AdBlue profiles: AdBlue and Diesel pages only (owner, 11 Nov 2026) */
{
  // Every page route of the app (src/app/**/page.tsx), with sample ids for its dynamic segments.
  const appDir = fileURLToPath(new URL("../../app", import.meta.url))
  const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : f === "page.tsx" ? [d] : []))
  const routes = walk(appDir).map((d) => "/" + d.slice(appDir.length + 1).split("/").filter(Boolean).map((seg) => ({ "[company]": "tepl", "[month]": "2026-11", "[vehicle]": "veh_1", "[id]": "x1" })[seg] ?? seg).join("/")).map((r) => (r === "/" ? r : r.replace(/\/$/, "")))
  assert.ok(routes.length >= 30 && routes.includes("/diesel/tepl/2026-11/veh_1"), "every page route found")
  const expectAllowed: Record<"TATA_ADBLUE" | "ADBLUE", string[]> = {
    TATA_ADBLUE: ["/adblue", "/diesel", "/diesel/tepl", "/diesel/tepl/2026-11", "/diesel/tepl/2026-11/veh_1"],
    ADBLUE: ["/adblue", "/diesel", "/diesel/tepl", "/diesel/tepl/2026-11", "/diesel/tepl/2026-11/veh_1", "/diesel/monthly-master", "/diesel/quarterly-master", "/diesel/yearly-master"],
  }
  for (const role of ["TATA_ADBLUE", "ADBLUE"] as const) {
    const s: AuthState = { ...ACTIVE, role }
    assert.equal(landingFor(role), PROFILE_LANDING)
    assert.equal(to("/", s), "/adblue", `${role} opens on AdBlue`)
    assert.equal(to("/login", s), "/adblue", `${role}: signed in → AdBlue`)
    assert.equal(to("/login?next=%2Fdiesel", s), "/diesel", `${role}: back to the Diesel page it was heading for`)
    for (const r of routes.filter((r) => r !== "/" && r !== "/login")) {
      const allowed = expectAllowed[role].includes(r)
      assert.equal(to(r, s), allowed ? "allow" : "/adblue", `${role}: ${r} ${allowed ? "allowed" : "→ AdBlue"}`)
      assert.equal(to(`${r}?month=2026-11`, s), allowed ? "allow" : "/adblue", `${role}: ${r} with a query string`)
    }
    for (const r of ["/diesel/ledger", "/settings/users", "/audit", "/fuel-stations/dv_tanker", "/diesel/tepl/2026-11/veh_1/extra", "/diesel/../settings"]) assert.equal(to(r, s), "/adblue", `${role}: ${r} refused`)
    assert.equal(to("/adblue", s), "allow", `${role}: the landing page itself is allowed (no redirect loop)`)
    assert.equal(to("/api/erp", s), "allow", `${role}: the API enforces its own method list`)
  }
  // The other roles are unchanged: every page, the Fuel Stations landing.
  for (const role of ["OWNER", "DEV", "EMPLOYEE"] as const) {
    const s: AuthState = { ...ACTIVE, role }
    assert.equal(to("/", s), LANDING)
    for (const r of routes.filter((r) => r !== "/" && r !== "/login")) assert.equal(to(r, s), "allow", `${role}: ${r}`)
  }
}

/* ---------------------------------------------------------------- the proxy runs on every page, not on assets or the OAuth callback */
const matcher = new RegExp(`^${config.matcher[0]}$`)
for (const page of ["/", "/login", "/fuel-stations", "/dashboard", "/settings/users", "/diesel/c1/2026-11/v1"]) assert.ok(matcher.test(page), `the proxy guards ${page}`)
for (const asset of ["/_next/static/chunks/a.js", "/_next/image", "/favicon.ico", "/auth/callback", "/logo.png", "/icon.svg"]) assert.ok(!matcher.test(asset), `the proxy skips ${asset}`)

/* ---------------------------------------------------------------- the signed-in account's role wins over the browser's stored role */
setRole("OWNER") // what the old demo switcher would have stored
setVerifiedRole("EMPLOYEE")
assert.equal(currentRole(), "EMPLOYEE", "the API acts as the signed-in account's role, not the stored one")
assert.equal(can(currentRole(), "settings", "edit"), false, "…so an Employee can't reach the Owner's Settings")
setVerifiedRole("DEV")
assert.equal(currentRole(), "DEV")
setVerifiedRole(null)
assert.equal(currentRole(), "OWNER", "without a session (offline checks) the stored role still applies")

/* ---------------------------------------------------------------- redirects stay on the host that started sign-in (local and Vercel) */
const HOSTS = ["http://localhost:3000", "http://127.0.0.1:3000", "https://vishal-erp.vercel.app", "https://erp.vishaltransport.example"]
for (const origin of HOSTS) assert.equal(oauthCallbackUrl(origin), `${origin}/auth/callback`, `Google returns to ${origin}'s own callback`)
for (const bad of ["javascript:alert(1)", "https://vishal-erp.vercel.app/path", "ftp://host"]) assert.throws(() => oauthCallbackUrl(bad), `not an origin: ${bad}`)

// Supabase falls back to its Site URL (the site root) with ?code= when the callback isn't allow-listed: finish it here.
assert.equal(to("/?code=abc123", OUT), "/auth/callback?code=abc123", "a sign-in returned to the site root is finished on this host")
assert.equal(to("/?code=abc123", ACTIVE), "/auth/callback?code=abc123")
assert.equal(to("/?error=access_denied&error_description=Denied", OUT), "/auth/callback?error=access_denied&error_description=Denied", "…as is a refused one")
assert.equal(to("/?code=x&next=https%3A%2F%2Fevil.example", OUT), "/auth/callback?code=x", "only the OAuth parameters are carried over")
assert.equal(to("/dashboard?code=abc", OUT), "/login?next=%2Fdashboard%3Fcode%3Dabc", "only the site root is treated as an OAuth return")

// The callback's redirects are relative, so the browser stays on its own host whatever the server thinks it is.
const r = sameHostRedirect("/dashboard")
assert.equal(r.status, 307)
assert.equal(r.headers.get("location"), "/dashboard", "relative Location: no host for anything to get wrong")
assert.match(r.headers.get("cache-control") ?? "", /no-store/, "never cached (it can carry session cookies)")
for (const bad of ["https://localhost:3000/login", "//evil.example", "login"]) assert.throws(() => sameHostRedirect(bad), `refuses ${bad}`)


/* ---------------------------------------------------------------- account linking happens only in the OAuth callback */
// Page loads, the layout and server actions read the caller's own profile (readAccount); only /auth/callback may call
// link_google_account, the function that links a Google sign-in to a pre-created account.
const SRC = fileURLToPath(new URL("../../", import.meta.url))
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(f) && !/\.check\.ts$/.test(f) ? [p] : []
  })
const linkers = files(SRC).filter((f) => /rpc\(\s*["']link_google_account["']/.test(readFileSync(f, "utf8"))).map((f) => f.slice(SRC.length))
assert.deepEqual(linkers, ["app/auth/callback/route.ts"], "only the OAuth callback links accounts")
for (const f of ["proxy.ts", "lib/auth/session.ts", "app/settings/users/actions.ts"])
  assert.match(readFileSync(join(SRC, f), "utf8"), /readAccount|\.from\("profiles"\)/, `${f} reads the account instead of linking`)

// The proxy redirects to the host of the incoming request — localhost stays localhost, Vercel stays Vercel.
async function proxyChecks() {
  // What a browser on each host sends; Vercel's edge adds x-forwarded-proto.
  const request = (origin: string, path: string, extra: Record<string, string> = {}) => {
    const u = new URL(origin)
    return new NextRequest(`${origin}${path}`, { headers: { host: u.host, "x-forwarded-proto": u.protocol.replace(":", ""), ...extra } })
  }
  const proxyTo = async (origin: string, path: string, extra?: Record<string, string>) => (await proxy(request(origin, path, extra))).headers.get("location")
  for (const origin of HOSTS) {
    assert.equal(await proxyTo(origin, "/dashboard"), `${origin}/login`, `${origin}: Supabase not configured → its own /login`)
    assert.equal(await proxyTo(origin, "/?code=abc"), `${origin}/auth/callback?code=abc`, `${origin}: a site-root OAuth return → its own callback`)
  }
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:9" // dummy project: no request is made without a session cookie
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_offlinecheck"
  for (const origin of HOSTS) {
    assert.equal(await proxyTo(origin, "/"), `${origin}/login`, `${origin}: signed out → its own /login`)
    assert.equal(await proxyTo(origin, "/dashboard"), `${origin}/login?next=%2Fdashboard`, `${origin}: the destination is remembered, on the same host`)
    const res = await proxy(request(origin, "/dashboard"))
    assert.match(res.headers.get("cache-control") ?? "", /no-store/, `${origin}: the redirect is never cached`)
    if (origin.startsWith("https://")) assert.doesNotMatch(res.headers.get("location") ?? "", /localhost|127\.0\.0\.1/, `${origin}: never redirected to localhost`)
  }
  // A Host header that isn't a plain host[:port] can't steer the redirect.
  assert.equal(await proxyTo("https://vishal-erp.vercel.app", "/dashboard", { host: "evil.example/x" }), "https://vishal-erp.vercel.app/login?next=%2Fdashboard", "a malformed Host header falls back to the request URL")
  delete process.env.NEXT_PUBLIC_SUPABASE_URL
  delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
}

proxyChecks()
  .then(() => console.log("auth: sign-in gate (signed out, expired, unapproved, deactivated, approved), safe return paths, no loops, proxy matcher, role binding, same-host redirects (local and Vercel), linking only in the OAuth callback: all checks passed"))
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
