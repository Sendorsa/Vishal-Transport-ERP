/**
 * Runnable check of the AdBlue supplier payments Production safeguards (offline, in-memory PostgreSQL):
 *   npm run check:adblue-payments-deploy
 *
 *   1. The migration is exactly the reviewed file (md5), with its own BEGIN / COMMIT.
 *   2. It stops with nothing changed before 20261116000000_adblue_vendors_owner_dev_delete.sql.
 *   3. On a Production-like state (every earlier migration; a vendor, two bulk purchases and opening stock already
 *      recorded): 15-adblue-payments-preflight.sql — every CHECK row OK; the migration; 16-adblue-payments-post-apply.sql
 *      — every CHECK row OK, purchases / litres / costs exactly as before, no payment invented, every purchase still
 *      outstanding at its old value; 10-adblue-vendors-post-apply.sql still OK (the two new tables classified); a second
 *      run stops.
 *   4. 20261118000100_adblue_direct_purchase_payments.sql (direct purchases on credit): reviewed (md5), guarded (after
 *      20261118000000, once); with a payment already recorded: 17 pre-flight OK, the migration, 18 post-apply OK — direct
 *      purchases, payments and allocations unchanged; 10-adblue-vendors-post-apply.sql still OK.
 *   The rules themselves (engine + RLS, every role): check:erp-db section 12g; the calculations: check:adblue-payments.
 */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import { PGlite } from "@electric-sql/pglite"
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist"

const MIGRATIONS = new URL("../../../supabase/migrations/", import.meta.url)
const SCRIPTS = new URL("../../../supabase/scripts/production-readonly/", import.meta.url)
const MIGRATION = "20261118000000_adblue_supplier_payments.sql"
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
  assert.equal(createHash("md5").update(migration).digest("hex"), "9176b8383ec340b6d3cf44bdbb199c83", `${MIGRATION} changed after review`)
  assert.match(migration, /^begin;$/m)
  assert.match(migration, /^commit;\s*$/m)
  const preflight = read(SCRIPTS, "15-adblue-payments-preflight.sql")
  const postApply = read(SCRIPTS, "16-adblue-payments-post-apply.sql")
  const vendors = read(SCRIPTS, "10-adblue-vendors-post-apply.sql")
  const run = async (db: PGlite, sql: string) => (await db.query<Row>(sql)).rows
  const stops = async (db: PGlite, sql: string) => (await run(db, sql)).filter((r) => r.status === "STOP").map((r) => `${r.check_no} ${r.check_name}: ${r.actual}`)
  const info = async (db: PGlite, sql: string, n: number) => (await run(db, sql)).find((r) => Number(r.check_no) === n)!.actual

  /* ---------------------------------------------------------------- 2. never before the AdBlue vendor migration */
  const early = await database("20261116000000")
  await assert.rejects(early.exec(migration), /20261116000000_adblue_vendors_owner_dev_delete\.sql must be applied first/)
  await early.exec("rollback").catch(() => undefined)
  assert.equal((await run(early, `select to_regclass('fuel.adblue_payments')::text as t`))[0].t, null, "a stopped migration changes nothing")

  /* ---------------------------------------------------------------- 3. Production-like: preflight → migration → post-apply */
  const db = await database(MIGRATION)
  const ev = (type: string, id: string) => `insert into audit.events (actor_kind, action, module, record_type, record_id) values ('SYSTEM', 'CREATED', 'AdBlue', '${type}', '${id}');`
  await db.exec(`begin;
    insert into fuel.adblue_purchases (id, date, vendor_name, product, buckets, litres_per_bucket, price_per_bucket, opening) values ('adp_open', '2026-10-31', '', 'Opening stock', 1, 120, 5400, true);
    ${ev("AdBlue purchase", "adp_open")}
    insert into fuel.adblue_vendors (id, name, default_rate) values ('adv_a', 'Vendor A', 45);
    ${ev("AdBlue vendor", "adv_a")}
    insert into fuel.adblue_purchases (id, date, vendor_name, vendor_id, product, buckets, litres_per_bucket, price_per_bucket) values ('adp_1', '2026-11-02', 'Vendor A', 'adv_a', 'AdBlue', 10, 20, 900), ('adp_2', '2026-11-05', 'Vendor A', 'adv_a', 'AdBlue', 5, 20, 960);
    ${ev("AdBlue purchase", "adp_1")} ${ev("AdBlue purchase", "adp_2")}
    commit;`)
  assert.deepEqual(await stops(db, preflight), [], "pre-flight: every CHECK row OK")
  const before = await info(db, preflight, 6)
  assert.equal(before, "3 · 1 · 19200.00 · 420.000")
  await db.exec(migration)
  assert.deepEqual(await stops(db, postApply), [], "post-apply: every CHECK row OK")
  assert.equal(await info(db, postApply, 11), before, "purchases, litres and costs exactly as before")
  assert.deepEqual(await stops(db, vendors), [], "10-adblue-vendors-post-apply: every deletable table still classified")
  const value = await run(db, `select id, (total_cost + gst_amount)::text as v from fuel.adblue_purchases where not opening order by id`)
  assert.deepEqual(value, [{ id: "adp_1", v: "9000.00" }, { id: "adp_2", v: "4800.00" }], "each purchase's value = its old Total Cost (0 % GST): fully outstanding, nothing paid")
  await assert.rejects(db.exec(migration), /already applied/, "runs once")
  await db.exec("rollback").catch(() => undefined)
  assert.ok((await stops(db, preflight)).some((s) => s.startsWith("3 ")), "the pre-flight then reports it applied")

  /* ---------------------------------------------------------------- 4. direct purchases on credit (20261118000100) */
  const DIRECT = "20261118000100_adblue_direct_purchase_payments.sql"
  const directMigration = read(MIGRATIONS, DIRECT)
  assert.equal(createHash("md5").update(directMigration).digest("hex"), "1c67ec53c89562157cc9db3edb724c31", `${DIRECT} changed after review`)
  assert.match(directMigration, /^begin;$/m)
  const pre17 = read(SCRIPTS, "17-adblue-direct-payments-preflight.sql")
  const post18 = read(SCRIPTS, "18-adblue-direct-payments-post-apply.sql")
  const notYet = await database(MIGRATION) // 20261118000000 not applied
  await assert.rejects(notYet.exec(directMigration), /20261118000000_adblue_supplier_payments\.sql must be applied first/, "never before the AdBlue payments migration")
  // A payment recorded before it (₹5,000 on adp_1): it must come through unchanged.
  await db.exec(`begin;
    insert into fuel.adblue_payments (id, date, vendor_id, amount, mode, utr) values ('abp_1', '2026-11-06', 'adv_a', 5000, 'NEFT', 'UTR-AB-1');
    insert into fuel.adblue_payment_allocations (payment_id, line_no, purchase_id, amount) values ('abp_1', 0, 'adp_1', 5000);
    insert into audit.events (actor_kind, action, module, record_type, record_id) values ('SYSTEM', 'PAYMENT_RECORDED', 'AdBlue', 'AdBlue payment', 'abp_1');
    commit;`)
  assert.deepEqual(await stops(db, pre17), [], "pre-flight 17: every CHECK row OK")
  const [d6, d7] = [await info(db, pre17, 6), await info(db, pre17, 7)]
  assert.equal(d7, "1 · 1 · 5000.00")
  await db.exec(directMigration)
  assert.deepEqual(await stops(db, post18), [], "post-apply 18: every CHECK row OK")
  assert.deepEqual([await info(db, post18, 10), await info(db, post18, 11)], [d6, d7], "direct purchases, payments and allocations exactly as before")
  assert.deepEqual(await stops(db, vendors), [], "10-adblue-vendors-post-apply: still every row OK")
  assert.deepEqual((await run(db, `select purchase_id, entry_id from fuel.adblue_payment_allocations`))[0], { purchase_id: "adp_1", entry_id: null }, "the existing allocation still points at its bulk purchase")
  await assert.rejects(db.exec(directMigration), /already applied/, "runs once")
  await db.exec("rollback").catch(() => undefined)

  console.log("AdBlue payments deploy: reviewed migration, guarded (AdBlue vendors first, once), pre-flight and post-apply all OK on a Production-like state, purchases and stock unchanged, no payment invented, deletable tables classified: all checks passed")
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
