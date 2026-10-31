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
import { config } from "@/proxy"
import { gate, LANDING, safeNext, type AuthState } from "./gate"

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

/* ---------------------------------------------------------------- the proxy runs on every page, not on assets or the OAuth callback */
const matcher = new RegExp(`^${config.matcher[0]}$`)
for (const page of ["/", "/login", "/fuel-stations", "/dashboard", "/settings/users", "/diesel/c1/2026-11/v1"]) assert.ok(matcher.test(page), `the proxy guards ${page}`)
for (const asset of ["/_next/static/chunks/a.js", "/_next/image", "/favicon.ico", "/auth/callback", "/logo.png", "/icon.svg"]) assert.ok(!matcher.test(asset), `the proxy skips ${asset}`)

/* ---------------------------------------------------------------- the signed-in account's role wins over the browser's stored role */
setRole("OWNER") // what the old demo switcher would have stored
setVerifiedRole("EMPLOYEE")
assert.equal(currentRole(), "EMPLOYEE", "the API acts as the signed-in account's role, not the stored one")
assert.equal(can(currentRole(), "payments", "create"), false, "…so an Employee can't act as Owner")
setVerifiedRole("DEV")
assert.equal(currentRole(), "DEV")
setVerifiedRole(null)
assert.equal(currentRole(), "OWNER", "without a session (offline checks) the stored role still applies")

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

console.log("auth: sign-in gate (signed out, expired, unapproved, deactivated, approved), safe return paths, no loops, proxy matcher, role binding, linking only in the OAuth callback: all checks passed")
