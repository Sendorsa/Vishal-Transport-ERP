/**
 * Runnable check of the AdBlue-vendor Production safeguards (offline, in-memory PostgreSQL):  npm run check:adblue-vendors-deploy
 *
 *   1. The migration is exactly the reviewed file (md5) — it must never change after review.
 *   2. 09-adblue-vendors-preflight.sql on a Production-like state (migrations through 20261112000100 and AdBlue history:
 *      two vendors, spelling variants, old draws): no STOP; the delete-path rows hold; the variant group is REVIEW.
 *   3. Atomic and guarded: a purchase without a usable vendor name → preflight STOP, and the migration stops with that
 *      message and changes NOTHING (no table, no column, private.can unchanged) — the explicit BEGIN / COMMIT.
 *   4. The migration on the clean state: one vendor per name, every purchase linked with its SYSTEM event, existing
 *      entries marked before_vendor_tracking (no row updated), new rows default to it unless the app says false; a
 *      second run stops ("already applied"); the preflight then reports STOP on row 3.
 *   5. Historical inventory reconciles (the app's calculation on the migrated rows): the review's example — vendor
 *      stock never exceeds company stock, every old litre counted once, Σ vendors + unattributed = company.
 *   6. Delete = Owner / Dev only in the database: private.can(…, 'delete') for every role and resource; the AdBlue rows
 *      can't be deleted by the Employee or either AdBlue profile (RLS), while edits still work.
 *   7. scripts/adblue-cutover-report.ts on an export of the pre-migration data prints the same reconciled figures.
 *   8. 07-rollback-adblue-vendors.sql: refused without the typed confirmation; then the schema is exactly the
 *      pre-migration state (functions, view, the six child tables' policies and triggers), every purchase and entry
 *      kept, the audit trail untouched; preflight OK.
 *   10-adblue-vendors-post-apply.sql: all OK after the migration (every deletable table classified); fails before it.
 *   Direct DELETE attempts by every role on the six child tables, and the Employee's edits that remove child rows
 *   legitimately: check:erp-db section 12e (the real engine).
 */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { PGlite } from "@electric-sql/pglite"
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist"
import { NO_VENDOR, stockFor, inventoryLedger, valueInventory, vendorLedger } from "@/domain/adblue-inventory"
import { RESOURCES, type Action } from "@/lib/permissions"

const MIGRATIONS = new URL("../../../supabase/migrations/", import.meta.url)
const SCRIPTS = new URL("../../../supabase/scripts/", import.meta.url)
const MIGRATION = "20261116000000_adblue_vendors_owner_dev_delete.sql"
const read = (base: URL, f: string) => readFileSync(new URL(f, base), "utf8")
type Row = Record<string, string>

const OWNER = "00000000-0000-0000-0000-00000000000a"
const DEV = "00000000-0000-0000-0000-00000000000b"
const EMP = "00000000-0000-0000-0000-00000000000c"
const TATA = "00000000-0000-0000-0000-00000000000d"
const ADB = "00000000-0000-0000-0000-00000000000e"
const USERS: [string, string][] = [[OWNER, "OWNER"], [DEV, "DEV"], [EMP, "EMPLOYEE"], [TATA, "TATA_ADBLUE"], [ADB, "ADBLUE"]]

/** Migrations before this one, accounts for every role, and AdBlue history recorded before vendor tracking. */
async function production(extra = "") {
  const db = new PGlite({ extensions: { btree_gist } })
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth;
    create table auth.users (id uuid primary key, email text);
    create table auth.identities (id uuid primary key default gen_random_uuid(), user_id uuid references auth.users (id), provider text, identity_data jsonb, created_at timestamptz default now());
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema public, auth to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated;`)
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql") && f < MIGRATION).sort()) await db.exec(read(MIGRATIONS, f))
  const ev = (module: string, type: string, id: string) => `insert into audit.events (actor_kind, action, module, record_type, record_id) values ('SYSTEM', 'CREATED', '${module}', '${type}', '${id}');`
  await db.exec(`begin;
    ${USERS.map(([u, r], i) => `insert into auth.users values ('${u}', 'u${i}@example.com');
      insert into public.profiles (id, user_id, email, role, status, activated_at) values ('${u}', '${u}', 'u${i}@example.com', '${r}', 'ACTIVE', now());
      ${ev("Accounts", "User account", u)}`).join("\n")}
    insert into core.customers (id, code, short_name, name, company_code) values ('cus_a', 'MINDA', 'Minda', 'Minda Industries', 'VTHPL');
    insert into core.customer_status_periods (customer_id, status, start_date) values ('cus_a', 'ACTIVE', '2026-01-01');
    ${ev("Customers", "Customer", "cus_a")}
    insert into core.vehicles (id, reg_no, company_code, type_code, fuel_type, assigned_customer_id) values ('veh_1', 'TN70AM1921', 'VT', 'BUS_41', 'DIESEL', 'cus_a');
    insert into core.vehicle_status_periods (vehicle_id, status, start_date) values ('veh_1', 'ACTIVE', '2026-01-01');
    insert into core.vehicle_assignments (vehicle_id, customer_id, start_date) values ('veh_1', 'cus_a', '2026-01-01');
    ${ev("Vehicles", "Vehicle", "veh_1")}
    -- Vendor A 1,000 L on 1 Nov; Vendor B 500 L in two purchases spelt differently (one vendor, spaces / case ignored).
    insert into fuel.adblue_purchases (id, date, vendor_name, buckets, litres_per_bucket, price_per_bucket, created_at) values
      ('adp_a1', '2026-11-01', 'Vendor A', 50, 20, 900, '2026-11-01T05:00:00Z'),
      ('adp_b1', '2026-11-02', 'Vendor  B', 25, 10, 480, '2026-11-02T05:00:00Z'),
      ('adp_b2', '2026-11-03', ' vendor b', 25, 10, 480, '2026-11-03T05:00:00Z');
    ${["adp_a1", "adp_b1", "adp_b2"].map((id) => ev("AdBlue", "AdBlue purchase", id)).join("\n")}
    -- Old draws (no vendor): 50 L on 1 Nov, when only A held stock; 300 L on 4 Nov, when A and B did.
    insert into fuel.adblue_entries (id, vehicle_id, customer_id, date, closing_km, quantity_litres, created_at) values
      ('adb_h0', 'veh_1', 'cus_a', '2026-11-01', 1000, 50, '2026-11-01T06:00:00Z'),
      ('adb_h1', 'veh_1', 'cus_a', '2026-11-04', 2000, 300, '2026-11-04T06:00:00Z');
    ${["adb_h0", "adb_h1"].map((id) => ev("AdBlue", "AdBlue entry", id)).join("\n")}
    ${extra}
    commit;`)
  return db
}

async function main() {
  /* ---------------------------------------------------------------- 1. the reviewed migration */
  const migration = read(MIGRATIONS, MIGRATION)
  assert.equal(createHash("md5").update(migration).digest("hex"), "d1aeee83aff042bbd876b6d804a18017", `${MIGRATION} changed after review`)
  assert.match(migration, /^begin;$/m, "the migration opens its own transaction")
  assert.match(migration, /^commit;\s*$/m, "…and commits it")

  const preflight = read(SCRIPTS, "production-readonly/09-adblue-vendors-preflight.sql")
  const postApply = read(SCRIPTS, "production-readonly/10-adblue-vendors-post-apply.sql")
  const postStops = async (db: PGlite) => (await db.query<Row>(postApply)).rows.filter((r) => r.status === "STOP").map((r) => `${r.check_no} ${r.check_name}: ${r.actual}`)
  const rollback = read(SCRIPTS, "07-rollback-adblue-vendors.sql")
  const run = async (db: PGlite, sql: string) => (await db.query<Row>(sql)).rows
  const status = async (db: PGlite) => new Map((await run(db, preflight)).map((r) => [Number(r.check_no), r]))
  const stops = async (db: PGlite) => [...(await status(db)).values()].filter((r) => r.status === "STOP").map((r) => `${r.check_no} ${r.check_name}: ${r.actual}`)
  const fingerprint = async (db: PGlite) =>
    (await run(db, `select string_agg(p.oid::regprocedure::text || ':' || md5(p.prosrc), ',' order by p.oid::regprocedure::text) as f from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and p.proname in ('can', 'adblue_shortfall', 'edit_delete_guard', 'is_same_day_undo')`))[0].f +
    (await run(db, `select string_agg(attname, ',' order by attnum) as c from pg_attribute where attrelid = 'fuel.adblue_stock_movements'::regclass and attnum > 0 and not attisdropped`))[0].c +
    // the delete rules of every child table: policies (command, roles, expressions) and triggers
    (await run(db, `select string_agg(tablename || '/' || policyname || '/' || cmd || '/' || roles::text || '/' || coalesce(qual, '') || '/' || coalesce(with_check, ''), '|' order by tablename, policyname) as p from pg_policies where tablename in ('vehicle_assignments', 'vehicle_status_periods', 'customer_status_periods', 'customer_pricing', 'customer_route_rates', 'industrial_supply_allocations')`))[0].p +
    (await run(db, `select string_agg(c.relname || '/' || g.tgname, ',' order by c.relname, g.tgname) as t from pg_trigger g join pg_class c on c.oid = g.tgrelid where c.relname in ('vehicle_assignments', 'vehicle_status_periods', 'customer_status_periods', 'customer_pricing', 'customer_route_rates', 'industrial_supply_allocations')`))[0].t
  const counts = async (db: PGlite) => (await run(db, `select (select count(*) from fuel.adblue_purchases) || '/' || (select count(*) from fuel.adblue_entries) || '/' || (select sum(total_litres) from fuel.adblue_purchases) || '/' || (select count(*) from audit.events) as c`))[0].c

  /* ---------------------------------------------------------------- 2. pre-flight on a Production-like state */
  const db = await production()
  const pre = await status(db)
  assert.deepEqual(await stops(db), [], "no STOP before the migration")
  assert.equal(pre.get(10)!.actual, "10", "10 record DELETE policies check private.can(…, 'delete')")
  assert.equal(pre.get(11)!.actual, "none", "no other DELETE path")
  assert.equal(pre.get(12)!.actual, "6", "the 6 edit-internal DELETE policies")
  assert.equal(pre.get(15)!.actual, "public.set_account_role,public.set_customer_access", "only the Dev-only account functions delete as SECURITY DEFINER")
  assert.equal(pre.get(17)!.actual, "1", "one ACTIVE Employee")
  assert.equal(pre.get(32)!.status, "REVIEW", "spelling variants are shown for review")
  assert.match(pre.get(32)!.actual, /^vendor b ← /, "…grouped under their key")
  assert.equal(pre.get(33)!.actual, "2: Vendor A; Vendor B", "two vendors, each named by its earliest spelling")
  assert.equal(pre.get(35)!.actual, "2 · 350.000 L; direct: 0")
  assert.equal(pre.get(36)!.actual, "1150.000 L")
  assert.equal(pre.get(37)!.actual, "2 · 1 draws", "at most the 4 Nov draw can become unattributed")
  assert.equal(pre.get(16)!.status, "OK", "every table an authenticated session may delete from is the known list")
  await assert.rejects(postStops(db), /vendor_id|tyre_masters|adblue_vendors/, "the post-apply check can't run before the migrations")
  const before = await fingerprint(db)
  const beforeCounts = await counts(db)

  /* ---------------------------------------------------------------- 3. guarded and atomic */
  const bad = await production(`insert into fuel.adblue_purchases (id, date, vendor_name, buckets, litres_per_bucket, price_per_bucket) values ('adp_tab', '2026-11-05', E'\\t', 1, 10, 480);
    insert into audit.events (actor_kind, action, module, record_type, record_id) values ('SYSTEM', 'CREATED', 'AdBlue', 'AdBlue purchase', 'adp_tab');`)
  assert.deepEqual((await stops(bad)).map((s) => s.split(" ")[0]), ["30"], "a purchase without a usable vendor name is a STOP")
  assert.match((await status(bad)).get(30)!.actual, /^1: adp_tab \(2026-11-05, 10\.000 L\)$/, "…naming the purchase")
  const badBefore = [await fingerprint(bad), await counts(bad)]
  await assert.rejects(bad.exec(migration), /AdBlue vendor migration stopped: 1 bulk purchase\(s\) have no vendor name: adp_tab/, "the migration stops with the reason")
  await bad.exec("rollback").catch(() => undefined) // the SQL editor's session ends; PGlite keeps it — close the aborted transaction
  assert.deepEqual([await fingerprint(bad), await counts(bad)], badBefore, "nothing changed: functions, view, rows, audit trail")
  assert.equal((await run(bad, `select to_regclass('fuel.adblue_vendors')::text as t`))[0].t, null, "no vendor table")
  assert.equal((await run(bad, `select count(*)::text as n from information_schema.columns where table_schema = 'fuel' and column_name in ('vendor_id', 'before_vendor_tracking')`))[0].n, "0", "no new column")
  // A failure half-way (after the first changes) rolls back too: the link-count guard, forced.
  const half = await production()
  await assert.rejects(half.exec(migration.replace("where not opening and vendor_id is null;", "where not opening and vendor_id is not null;")), /could not be linked to a vendor/)
  await half.exec("rollback").catch(() => undefined)
  assert.equal(await fingerprint(half), before, "a failure after private.can was replaced leaves it unchanged")
  assert.equal((await run(half, `select to_regclass('fuel.adblue_vendors')::text as t`))[0].t, null)

  /* ---------------------------------------------------------------- 4. the migration */
  const eventsBefore = Number((await run(db, `select count(*)::text as n from audit.events`))[0].n)
  const updatedAt = (await run(db, `select string_agg(id || updated_at, ',' order by id) as u from fuel.adblue_entries`))[0].u
  await db.exec(migration)
  const vendors = await run(db, `select id, name from fuel.adblue_vendors order by name`)
  assert.deepEqual(vendors.map((v) => v.name), ["Vendor A", "Vendor B"], "one vendor per name, spaces / case ignored")
  const links = await run(db, `select id, vendor_id, vendor_name from fuel.adblue_purchases order by id`)
  const idOf = (n: string) => vendors.find((v) => v.name === n)!.id
  assert.deepEqual(links.map((l) => [l.id, l.vendor_id, l.vendor_name]), [["adp_a1", idOf("Vendor A"), "Vendor A"], ["adp_b1", idOf("Vendor B"), "Vendor  B"], ["adp_b2", idOf("Vendor B"), " vendor b"]], "every purchase linked; its saved name unchanged")
  assert.equal(Number((await run(db, `select count(*)::text as n from audit.events`))[0].n), eventsBefore + 2 + 3, "a SYSTEM event per vendor and per linked purchase")
  assert.equal((await run(db, `select string_agg(id || before_vendor_tracking, ',' order by id) as f from fuel.adblue_entries`))[0].f, "adb_h0true,adb_h1true", "existing entries are marked before vendor tracking")
  assert.equal((await run(db, `select string_agg(id || updated_at, ',' order by id) as u from fuel.adblue_entries`))[0].u, updatedAt, "…without updating a row")
  assert.equal(await counts(db).then((c) => c.split("/").slice(0, 3).join("/")), beforeCounts.split("/").slice(0, 3).join("/"), "no purchase or entry added or removed; litres unchanged")
  assert.notEqual(await fingerprint(db), before)
  assert.deepEqual(await stops(db).then((s) => s.map((x) => x.split(" ")[0])), ["3", "4", "5", "6", "10", "12"], "the preflight now says: applied (two new Owner / Dev delete policies; the six child-row policies replaced)")
  await assert.rejects(postStops(db), /tyre_masters/, "post-apply: needs the Tyre Data migration too (17 Nov 2026)")
  await assert.rejects(db.exec(migration), /already applied/, "a second run stops")
  await db.exec("rollback").catch(() => undefined)
  assert.equal(Number((await run(db, `select count(*)::text as n from fuel.adblue_vendors`))[0].n), 2, "…and changes nothing")

  // Production today: the AdBlue migration applied; then the Tyre Data migration (20261117000000) — compatible, and it
  // changes none of the AdBlue migration's objects (functions, view, the six child tables' policies and triggers).
  const withTyre = await production()
  await withTyre.exec(migration)
  const adblueObjects = await fingerprint(withTyre)
  const tyre = read(MIGRATIONS, "20261117000000_tyre_data.sql")
  await withTyre.exec(tyre)
  assert.equal(await fingerprint(withTyre), adblueObjects, "the Tyre Data migration leaves every AdBlue-migration object as it was")
  assert.deepEqual(await postStops(withTyre), [], "post-apply after the Tyre Data migration: AdBlue rows and Tyre rows all OK; tyre invoices Owner / Dev, tyre lines only inside an audited edit")
  await assert.rejects(withTyre.exec(tyre), /already applied/, "the Tyre Data migration runs once: a second run stops")
  await withTyre.exec("rollback").catch(() => undefined)
  const noAdblue = await production()
  await assert.rejects(noAdblue.exec(tyre), /20261116000000_adblue_vendors_owner_dev_delete\.sql .* must be applied first/, "…and never before the AdBlue migration")
  await noAdblue.exec("rollback").catch(() => undefined)
  assert.equal((await run(noAdblue, `select to_regclass('ops.tyre_invoices')::text as t`))[0].t, null, "a stopped Tyre migration changes nothing")

  /* ---------------------------------------------------------------- 5. historical inventory reconciles */
  const load = async () => ({
    purchases: (await run(db, `select id, date::text, created_at::text as "createdAt", total_litres::float8 as "totalLitres", total_cost::float8 as "totalCost", vendor_id as "adblueVendorId", opening from fuel.adblue_purchases`)) as never as Parameters<typeof valueInventory>[0],
    draws: (await run(db, `select id, date::text, created_at::text as "createdAt", quantity_litres::float8 as "quantityLitres", vendor_id as "adblueVendorId", before_vendor_tracking as "beforeVendorTracking" from fuel.adblue_entries where source = 'STOCK'`)) as never as Parameters<typeof valueInventory>[1],
  })
  const { purchases, draws } = await load()
  const v = valueInventory(purchases, draws)
  const A = idOf("Vendor A")
  const B = idOf("Vendor B")
  const per = [NO_VENDOR, A, B].map((k) => stockFor(vendorLedger(purchases, draws, k)))
  const company = stockFor(inventoryLedger(purchases, draws))
  assert.equal(v.shortfall, null)
  assert.deepEqual([v.stockLitres, company.closing], [1150, 1150], "company stock = 1,500 − 350, before and after")
  assert.deepEqual(per.map((r) => r.closing), [1150, 0, 0], "A and B hold nothing attributable; 1,150 L unattributed — never 1,500 L")
  assert.deepEqual(per.map((r) => r.consumed), [300, 50, 0], "the 1 Nov draw came from A (the only stock on hand); the 4 Nov one from unattributed stock")
  assert.deepEqual(per.map((r) => r.unattributed), [1450, -950, -500], "on 4 Nov A's 950 L and B's 500 L became unattributed (relabelled only)")
  assert.equal(per.reduce((t, r) => t + r.consumed, 0), company.consumed, "every old litre counted once")
  assert.equal(per.reduce((t, r) => t + r.closing, 0), v.stockLitres, "Σ vendors + unattributed = company stock")
  assert.equal(Math.round((company.purchasedCost - company.consumedCost) * 100) / 100, v.stockValue, "and the value reconciles")
  // A new purchase after the cutover is the vendor's own stock again, and the database's backstop still holds.
  await db.exec(`begin; insert into fuel.adblue_purchases (id, date, vendor_id, vendor_name, buckets, litres_per_bucket, price_per_bucket) values ('adp_a2', '2026-11-10', '${A}', 'Vendor A', 5, 20, 1000);
    insert into audit.events (actor_kind, action, module, record_type, record_id) values ('SYSTEM', 'CREATED', 'AdBlue', 'AdBlue purchase', 'adp_a2'); commit;`)
  const after = await load()
  assert.equal(valueInventory(after.purchases, after.draws).vendorStock.get(A)?.litres, 100)
  await assert.rejects(db.exec(`begin; insert into fuel.adblue_purchases (id, date, vendor_name, buckets, litres_per_bucket, price_per_bucket) values ('adp_x', '2026-11-10', 'Nobody', 1, 1, 1);
    insert into audit.events (actor_kind, action, module, record_type, record_id) values ('SYSTEM', 'CREATED', 'AdBlue', 'AdBlue purchase', 'adp_x'); commit;`), /adblue_purchases_vendor_id_check/, "a purchase without a vendor is refused from now on")
  await db.exec("rollback").catch(() => undefined)
  await db.exec(`begin; insert into fuel.adblue_entries (id, vehicle_id, customer_id, date, closing_km, quantity_litres) values ('adb_old_app', 'veh_1', 'cus_a', '2026-11-11', 3000, 1);
    insert into audit.events (actor_kind, action, module, record_type, record_id) values ('SYSTEM', 'CREATED', 'AdBlue', 'AdBlue entry', 'adb_old_app'); commit;`)
  assert.equal((await run(db, `select before_vendor_tracking::text as f from fuel.adblue_entries where id = 'adb_old_app'`))[0].f, "true", "a write that knows nothing of vendors (the old app) is marked as recording none")

  /* ---------------------------------------------------------------- 6. delete = Owner and Dev, in the database */
  const as = async (user: string, sql: string) => {
    await db.exec("begin")
    try {
      await db.exec(`set local role authenticated; select set_config('request.jwt.claim.sub', '${user}', true);`)
      return (await db.query<Row>(sql)).rows
    } finally {
      await db.exec("rollback")
    }
  }
  for (const [user, role] of USERS)
    for (const r of RESOURCES) {
      const [row] = await as(user, `select private.can('${r}', 'delete') as d, exists (select 1 from core.role_permissions where role::text = '${role}' and permission in ('*', '${r}:*', '${r}:delete')) and ('${r}' not in ('accounts', 'system') or '${role}' = 'DEV') as had`)
      assert.equal(row.d, ["OWNER", "DEV"].includes(role) ? row.had : false, `private.can(${r}, delete) as ${role}`)
    }
  for (const [user, role] of USERS.filter(([, r]) => !["OWNER", "DEV"].includes(r))) {
    for (const t of ["fuel.adblue_entries", "fuel.adblue_purchases"]) assert.equal((await as(user, `delete from ${t} returning id`)).length, 0, `${role} deletes no row of ${t} (RLS)`)
    for (const a of ["view", "create", "edit"] as Action[]) assert.equal((await as(user, `select private.can('adblue', '${a}') as c`))[0].c, true, `${role} keeps adblue:${a}`)
  }
  assert.ok((await as(OWNER, `delete from fuel.adblue_entries where id = 'adb_old_app' returning id`)).length === 1, "the Owner can delete (rolled back here)")

  /* ---------------------------------------------------------------- 7. the offline cutover report */
  const dir = mkdtempSync(join(tmpdir(), "vt-adblue-"))
  const exported = await production()
  const file = join(dir, "export.json")
  writeFileSync(file, JSON.stringify({ collections: {
    adblue_purchases: (await run(exported, `select id, date::text as date, created_at::text as "createdAt", vendor_name as "vendorName", total_litres::float8 as "totalLitres", total_cost::float8 as "totalCost", opening from fuel.adblue_purchases`)),
    adblue_entries: (await run(exported, `select id, date::text as date, created_at::text as "createdAt", quantity_litres::float8 as "quantityLitres", source::text as source from fuel.adblue_entries`)),
  } }))
  const report = execFileSync("npx", ["tsx", fileURLToPath(new URL("../../../scripts/adblue-cutover-report.ts", import.meta.url)), file], { encoding: "utf8" })
  assert.match(report, /Company stock: 1150 L worth .* = Σ the rows above \(reconciled\)/)
  assert.match(report, /Unattributed stock \(no vendor\).*1450.*1150/, "unattributed: 1,450 L in, 1,150 L left")
  assert.match(report, /adb_h0.*Vendor A.*the only stock on hand then/)
  assert.match(report, /adb_h1.*Unattributed stock \(no vendor\).*unknown: Vendor A, Vendor B held stock/)

  /* ---------------------------------------------------------------- 8. rollback */
  const step2 = rollback.slice(rollback.indexOf("\nbegin;") + 1)
  await assert.rejects(db.exec(step2), /Not confirmed/, "refused without the typed confirmation")
  await db.exec("rollback").catch(() => undefined)
  assert.equal(Number((await run(db, `select count(*)::text as n from fuel.adblue_vendors`))[0].n), 2, "…and nothing changed")
  const backup = (await run(db, rollback.slice(rollback.indexOf("select jsonb_build_object("), rollback.indexOf("as adblue_vendors_backup;") + "as adblue_vendors_backup".length)))[0].adblue_vendors_backup as unknown as { adblue_vendors: unknown[]; purchase_vendor: Record<string, string> }
  assert.equal(backup.adblue_vendors.length, 2, "STEP 1 exports the vendors")
  assert.equal(backup.purchase_vendor.adp_b2, B, "…and every link")
  const rowsBefore = (await run(db, `select (select count(*) from fuel.adblue_purchases) || '/' || (select count(*) from fuel.adblue_entries) || '/' || (select count(*) from audit.events) as c`))[0].c
  await db.exec(`select set_config('vt.confirm_adblue_vendors_rollback', 'dqnoducqiootfvkzskhu', false); ${step2}`)
  assert.deepEqual((await fingerprint(db)).split("|"), before.split("|"), "functions, view, policies and triggers exactly as before the migration")
  assert.equal((await run(db, `select (select count(*) from fuel.adblue_purchases) || '/' || (select count(*) from fuel.adblue_entries) || '/' || (select count(*) from audit.events) as c`))[0].c, rowsBefore, "every purchase, entry and audit event kept")
  assert.deepEqual(await stops(db), [], "the preflight reports no STOP again")
  await assert.rejects(postStops(db), /vendor_id|before_vendor_tracking|adblue_vendors|tyre_masters/, "…and the post-apply check can't run")
  await assert.rejects(db.exec(`select set_config('vt.confirm_adblue_vendors_rollback', 'dqnoducqiootfvkzskhu', false); ${step2}`), /not installed/, "a second rollback stops")

  console.log("AdBlue vendors deploy: reviewed migration, preflight, guards (atomic), migration, historical reconciliation, delete = Owner / Dev in the database, cutover report and rollback: all checks passed")
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
