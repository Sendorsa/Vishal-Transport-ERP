/**
 * Runnable check of the tyre-payments Production safeguards (offline, in-memory PostgreSQL):  npm run check:tyre-payments-deploy
 *
 *   1. The migration is exactly the reviewed file (md5), with its own BEGIN / COMMIT.
 *   2. It stops with nothing changed when 20261117000000_tyre_data.sql isn't applied.
 *   3. On a Production-like state (every earlier migration, a tyre invoice recorded with payment type NEFT):
 *      11-tyre-payments-preflight.sql — every CHECK row OK; the migration; 12-tyre-payments-post-apply.sql — every CHECK
 *      row OK, the invoices / lines / totals exactly as before, no payment invented; a second run stops.
 *   4. 20261117000300_tyre_payment_tds_edit.sql ("Deduct TDS?", IMPS, corrections, permanent deletion): reviewed (md5),
 *      guarded (after 20261117000100, once; never while a payment is voided); on that state plus a recorded payment:
 *      13-tyre-payment-tds-preflight.sql OK, the migration, 14-tyre-payment-tds-post-apply.sql OK — payments,
 *      allocations and amounts unchanged, no TDS invented — and 10-adblue-vendors-post-apply.sql still OK (every
 *      deletable table classified: tyre payments Owner / Dev, allocations inside an audited edit).
 *   The rules themselves (engine + RLS, every role): check:erp-db section 12f; the calculations: check:tyre section 9.
 */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import { PGlite } from "@electric-sql/pglite"
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist"

const MIGRATIONS = new URL("../../../supabase/migrations/", import.meta.url)
const SCRIPTS = new URL("../../../supabase/scripts/production-readonly/", import.meta.url)
const MIGRATION = "20261117000100_tyre_payments.sql"
const read = (base: URL, f: string) => readFileSync(new URL(f, base), "utf8")
type Row = Record<string, string>

async function database(upTo: string) {
  const db = new PGlite({ extensions: { btree_gist } })
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth;
    create table auth.users (id uuid primary key, email text);
    create table auth.identities (id uuid primary key default gen_random_uuid(), user_id uuid references auth.users (id), provider text, identity_data jsonb, created_at timestamptz default now());
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema public, auth to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated;`)
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql") && f < upTo).sort()) await db.exec(read(MIGRATIONS, f))
  return db
}

async function main() {
  /* ---------------------------------------------------------------- 1. the reviewed migration */
  const migration = read(MIGRATIONS, MIGRATION)
  assert.equal(createHash("md5").update(migration).digest("hex"), "3f16146c40a9aab107e8f0c8cbca6000", `${MIGRATION} changed after review`)
  assert.match(migration, /^begin;$/m)
  assert.match(migration, /^commit;\s*$/m)
  const preflight = read(SCRIPTS, "11-tyre-payments-preflight.sql")
  const postApply = read(SCRIPTS, "12-tyre-payments-post-apply.sql")
  const run = async (db: PGlite, sql: string) => (await db.query<Row>(sql)).rows
  const stops = async (db: PGlite, sql: string) => (await run(db, sql)).filter((r) => r.status === "STOP").map((r) => `${r.check_no} ${r.check_name}: ${r.actual}`)
  const info = async (db: PGlite, sql: string, n: number) => (await run(db, sql)).find((r) => Number(r.check_no) === n)!.actual

  /* ---------------------------------------------------------------- 2. never before Tyre Data */
  const early = await database("20261117000000")
  await assert.rejects(early.exec(migration), /20261117000000_tyre_data\.sql must be applied first/)
  await early.exec("rollback").catch(() => undefined)
  assert.equal((await run(early, `select to_regclass('ops.tyre_payments')::text as t`))[0].t, null, "a stopped migration changes nothing")
  await assert.rejects(run(early, preflight), /ops\.tyre_invoices/, "…and the pre-flight can't run (ops.tyre_invoices does not exist)")

  /* ---------------------------------------------------------------- 3. Production-like: preflight → migration → post-apply */
  const db = await database(MIGRATION)
  const ev = (module: string, type: string, id: string) => `insert into audit.events (actor_kind, action, module, record_type, record_id) values ('SYSTEM', 'CREATED', '${module}', '${type}', '${id}');`
  await db.exec(`begin;
    insert into core.customers (id, code, short_name, name, company_code) values ('cus_a', 'MINDA', 'Minda', 'Minda Industries', 'VTHPL');
    insert into core.customer_status_periods (customer_id, status, start_date) values ('cus_a', 'ACTIVE', '2026-01-01');
    ${ev("Customers", "Customer", "cus_a")}
    insert into core.vehicles (id, reg_no, company_code, type_code, fuel_type, assigned_customer_id) values ('veh_1', 'TN70AM1921', 'VT', 'BUS_41', 'DIESEL', 'cus_a');
    insert into core.vehicle_status_periods (vehicle_id, status, start_date) values ('veh_1', 'ACTIVE', '2026-01-01');
    insert into core.vehicle_assignments (vehicle_id, customer_id, start_date) values ('veh_1', 'cus_a', '2026-01-01');
    ${ev("Vehicles", "Vehicle", "veh_1")}
    insert into ops.tyre_masters (id, kind, name) values ('tym_s', 'SUPPLIER', 'Bhagyalakshmi Tyres');
    ${ev("Tyre", "Supplier", "tym_s")}
    insert into ops.tyre_invoices (id, date, vehicle_id, customer_id, supplier_id, bill_no, payment_mode, payment_details) values ('tyr_1', '2026-11-05', 'veh_1', 'cus_a', 'tym_s', '37', 'NEFT', 'UTR 99');
    insert into ops.tyre_invoice_items (invoice_id, line_no, repair_type_id, quantity, rate, gst_rate) values ('tyr_1', 0, (select id from ops.tyre_masters where name = 'Wheel Alignment'), 1, 1000, 18);
    ${ev("Tyre", "Tyre invoice", "tyr_1")}
    commit;`)
  assert.deepEqual(await stops(db, preflight), [], "pre-flight: every CHECK row OK")
  const before = await info(db, preflight, 7)
  assert.equal(before, "1 · 1 · 1180.00")
  assert.equal(await info(db, preflight, 9), "1", "the NEFT invoice is listed: it stays unpaid (no payment invented)")
  await db.exec(migration)
  assert.deepEqual(await stops(db, postApply), [], "post-apply: every CHECK row OK")
  assert.equal(await info(db, postApply, 13), before, "invoices, lines and totals exactly as before")
  await assert.rejects(db.exec(migration), /already applied/, "runs once")
  await db.exec("rollback").catch(() => undefined)
  assert.ok((await stops(db, preflight)).some((s) => s.startsWith("3 ")), "the pre-flight then reports it applied")

  /* ---------------------------------------------------------------- 4. TDS and corrections (20261117000300) */
  const TDS = "20261117000300_tyre_payment_tds_edit.sql"
  const tdsMigration = read(MIGRATIONS, TDS)
  assert.equal(createHash("md5").update(tdsMigration).digest("hex"), "c5d0d4e04ac894615fd5208d365330ea", `${TDS} changed after review`)
  assert.match(tdsMigration, /^begin;$/m)
  const pre2 = read(SCRIPTS, "13-tyre-payment-tds-preflight.sql")
  const post2 = read(SCRIPTS, "14-tyre-payment-tds-post-apply.sql")
  const tooEarly = await database(MIGRATION)
  await assert.rejects(tooEarly.exec(tdsMigration), /20261117000100_tyre_payments\.sql must be applied first/, "never before the tyre payments migration")
  // A payment recorded before it (₹500 on bill 37, NEFT) — it must come through unchanged, with no TDS.
  await db.exec(`begin;
    insert into ops.tyre_payments (id, date, supplier_id, amount, mode, utr) values ('tpy_1', '2026-11-06', 'tym_s', 500, 'NEFT', 'UTR-1');
    insert into ops.tyre_payment_allocations (payment_id, line_no, invoice_id, amount) values ('tpy_1', 0, 'tyr_1', 500);
    ${ev("Tyre", "Tyre payment", "tpy_1").replace("'CREATED'", "'PAYMENT_RECORDED'")}
    commit;`)
  // A voided payment (voiding is replaced by deletion): the pre-flight reports it and the migration stops, nothing changed.
  await db.exec(`begin;
    insert into ops.tyre_payments (id, date, supplier_id, amount, mode, utr, voided, void_reason) values ('tpy_v', '2026-11-06', 'tym_s', 100, 'Cash', 'R-9', true, 'entered twice');
    ${ev("Tyre", "Tyre payment", "tpy_v")}
    commit;`)
  assert.deepEqual((await stops(db, pre2)).map((x) => x.split(" ")[0]), ["7"], "pre-flight 13: row 7 STOP while a payment is voided")
  await assert.rejects(db.exec(tdsMigration), /1 voided payment\(s\) exist/, "…and the migration stops")
  await db.exec("rollback").catch(() => undefined)
  await db.exec(`begin; ${ev("Tyre", "Tyre payment", "tpy_v").replace("'CREATED'", "'DELETED'")} delete from ops.tyre_payments where id = 'tpy_v'; commit;`)
  assert.deepEqual(await stops(db, pre2), [], "pre-flight 13: every CHECK row OK")
  const before2 = await info(db, pre2, 6)
  assert.equal(before2, "1 · 1 · 500.00")
  await db.exec(tdsMigration)
  assert.deepEqual(await stops(db, post2), [], "post-apply 14: every CHECK row OK")
  assert.deepEqual(await stops(db, read(SCRIPTS, "10-adblue-vendors-post-apply.sql")), [], "post-apply 10: every deletable table still classified (tyre payments Owner / Dev)")
  assert.equal(await info(db, post2, 10), before2, "payments, allocations and amounts exactly as before")
  assert.deepEqual((await run(db, `select tds_rate, tds_amount::text as t from ops.tyre_payments`))[0], { tds_rate: null, t: "0.00" }, "the existing payment has no TDS")
  await assert.rejects(db.exec(tdsMigration), /already applied/, "runs once")
  await db.exec("rollback").catch(() => undefined)

  console.log("tyre payments deploy (incl. TDS / corrections): reviewed migration, guarded (Tyre Data first, once), pre-flight and post-apply all OK on a Production-like state, nothing existing changed, no payment invented: all checks passed")
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
