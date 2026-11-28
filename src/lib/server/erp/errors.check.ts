/**
 * What the browser sees when a shared-database call fails:  npm run check:erp-errors
 * Business messages pass through; database internals (SQL, constraint names, hosts, users) never do.
 */
import assert from "node:assert/strict"
import { ConflictError } from "@/lib/versions"
import { toErpError } from "./errors"

const pg = (code: string, message: string) => Object.assign(new Error(message), { code, severity: "ERROR" })
const sys = (code: string, message: string) => Object.assign(new Error(message), { code })

// The app's own checks keep their words.
assert.deepEqual(toErpError(new Error("Insufficient tanker inventory in JIO. Available: 50 L")), { status: 400, body: { message: "Insufficient tanker inventory in JIO. Available: 50 L" }, log: false })
assert.deepEqual(toErpError(new ConflictError()).body.code, "CONFLICT")
// Database refusals become business language — no constraint or table names.
for (const [code, msg] of [["23514", 'new row for relation "events" violates check constraint "events_changes_check"'], ["23505", 'duplicate key value violates unique constraint "payments_payment_no_key"'], ["XX000", "internal"]] as const) {
  const r = toErpError(pg(code, msg))
  assert.ok(!/constraint|relation|events_|payments_/.test(r.body.message), `${code}: ${r.body.message}`)
}
assert.equal(toErpError(pg("28P01", 'password authentication failed for user "erp_server.abc"')).body.message, "Something went wrong. Nothing was saved.")
// Connection failures (4 Nov 2026): they used to reach the browser word for word, with the database host.
for (const e of [sys("ENOTFOUND", "getaddrinfo ENOTFOUND aws-0-ap-south-1.pooler.supabase.com"), sys("ECONNREFUSED", "connect ECONNREFUSED 10.0.0.1:6543"), sys("CONNECT_TIMEOUT", "write CONNECT_TIMEOUT aws-0-ap-south-1.pooler.supabase.com:6543")]) {
  const r = toErpError(e)
  assert.equal(r.status, 503)
  assert.ok(!/supabase|6543|10\.0|ENOTFOUND|ECONN|TIMEOUT/.test(r.body.message), r.body.message)
  assert.equal(r.log, true, "logged on the server for diagnosis")
}
// The database older than the app (25 Nov 2026 — AdBlue direct purchases on credit, enum value 'CREDIT' missing until
// 20261118000100): a plain "needs an update" message, never the SQL; logged on the server with the real error.
for (const e of [pg("22P02", 'invalid input value for enum fuel.adblue_payment_mode: "CREDIT"'), pg("42703", 'column "gst_rate" of relation "adblue_purchases" does not exist'), pg("42P01", 'relation "fuel.adblue_payments" does not exist'), pg("42883", "function private.adblue_payment_check() does not exist"), pg("42704", 'type "fuel.adblue_payment_mode" does not exist')]) {
  const r = toErpError(e)
  assert.deepEqual([r.status, r.log], [503, true], e.message)
  assert.match(r.body.message, /needs an update before this can be saved.*Nothing was saved/)
  assert.ok(!/enum|relation|column|fuel\.|adblue_|CREDIT|function|type "/.test(r.body.message), r.body.message)
}
// Programming errors never show their text either.
assert.equal(toErpError(new TypeError("Cannot read properties of undefined (reading 'id')")).body.message, "Something went wrong. Nothing was saved.")

console.log("shared database errors: business messages shown, database internals and hosts never: all checks passed")
