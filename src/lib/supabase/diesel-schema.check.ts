/**
 * Offline validation of the Diesel schema (supabase/migrations/20261101*) — never touches a real project.
 * Runs every migration in supabase/migrations/, in order, in a real PostgreSQL (PGlite) with a stand-in for Supabase's
 * auth schema and API roles, and exercises the rules as the signed-in roles would: permissions and month locks (RLS),
 * the tanker-fill shape, exact amounts, stock never below zero, voucher numbering, TDS, audit guarantees and restore.
 * Single connection: concurrency (row / advisory locks) is designed, not exercised here.
 */
import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { PGlite } from "@electric-sql/pglite"
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist"
import { can, RESOURCES, type Action } from "@/lib/permissions"
import type { Role } from "@/lib/types"
import { todayISO } from "@/lib/format"

const OWNER = "00000000-0000-0000-0000-0000000000a1"
const DEV = "00000000-0000-0000-0000-0000000000a2"
const EMP = "00000000-0000-0000-0000-0000000000a3"
const PROFILE: Record<string, string> = { [OWNER]: "10000000-0000-0000-0000-000000000001", [DEV]: "10000000-0000-0000-0000-000000000002", [EMP]: "10000000-0000-0000-0000-000000000003" }

async function main() {
  const db = new PGlite({ extensions: { btree_gist } })
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth;
    create table auth.users (id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema public, auth to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  `)
  const url = new URL("../../../supabase/migrations/", import.meta.url)
  for (const f of readdirSync(url).filter((f) => f.endsWith(".sql")).sort()) {
    try {
      await db.exec(readFileSync(new URL(f, url), "utf8"))
    } catch (e) {
      throw new Error(`${f}: ${e instanceof Error ? e.message : e}`)
    }
  }

  const q = async <T = Record<string, unknown>>(sql: string) => (await db.query<T>(sql)).rows
  const one = async <T = Record<string, unknown>>(sql: string) => (await q<T>(sql))[0]

  /* ---------------------------------------------------------------- roles and permissions mirror the app */
  const roles = (await q<{ r: string }>(`select unnest(enum_range(null::public.erp_role))::text as r`)).map((x) => x.r)
  assert.deepEqual(roles, ["OWNER", "DEV", "EMPLOYEE"] satisfies Role[], "erp_role = Owner / Dev / Employee only")
  const perms = await q<{ role: Role; permission: string }>(`select role::text as role, permission from core.role_permissions`)
  const dbCan = (role: Role, r: string, a: string) => perms.some((p) => p.role === role && ["*", `${r}:*`, `${r}:${a}`].includes(p.permission))
  for (const role of roles as Role[]) for (const r of RESOURCES) for (const a of ["view", "create", "edit", "delete", "finance"] as Action[])
    assert.equal(dbCan(role, r, a), can(role, r, a), `role_permissions = can(): ${role} ${r}:${a}`)

  /* ---------------------------------------------------------------- accounts */
  await db.exec(`
    insert into auth.users values ('${OWNER}', 'owner@example.com'), ('${DEV}', 'dev@example.com'), ('${EMP}', 'staff@example.com');
    insert into public.profiles (id, user_id, email, role, status, activated_at) values
      ('${PROFILE[OWNER]}', '${OWNER}', 'owner@example.com', 'OWNER', 'ACTIVE', now()),
      ('${PROFILE[DEV]}', '${DEV}', 'dev@example.com', 'DEV', 'ACTIVE', now()),
      ('${PROFILE[EMP]}', '${EMP}', 'staff@example.com', 'EMPLOYEE', 'ACTIVE', now());
  `)

  /** One business write as a signed-in user, in one transaction (deferred checks run at COMMIT). */
  const tx = async (who: string, sql: string) => {
    await db.exec("begin")
    try {
      await db.exec(`set local role authenticated; select set_config('request.jwt.claim.sub', '${who}', true);`)
      await db.exec(sql)
      await db.exec("commit")
    } catch (e) {
      await db.exec("rollback").catch(() => undefined)
      throw e
    }
  }
  const asUser = async <T = Record<string, unknown>>(who: string | null, sql: string) => {
    await db.exec("begin")
    try {
      await db.exec(who ? `set local role authenticated; select set_config('request.jwt.claim.sub', '${who}', true);` : "set local role anon;")
      return (await db.query<T>(sql)).rows
    } finally {
      await db.exec("rollback")
    }
  }
  /** The audit event the app writes with each change. */
  const ev = (action: string, module: string, type: string, recordId: string, reason?: string, extra = "") =>
    `insert into audit.events (actor_kind, actor_user_id, actor_role, action, module, record_type, record_id, reason${extra ? ", restores_event_id" : ""})
     values ('SESSION', private.current_profile_id(), private.erp_role(), '${action}', '${module}', '${type}', '${recordId}', ${reason ? `'${reason}'` : "null"}${extra ? `, '${extra}'` : ""});`
  const refused = (p: Promise<unknown>, re: RegExp, why: string) =>
    assert.rejects(p, (e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e)
      if (!re.test(msg)) throw new Error(`${why}: expected ${re}, got: ${msg}`)
      return true
    }, why)

  const today = todayISO()
  const thisMonth = today.slice(0, 7)
  const prev = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 2, 1))
  const lastMonthDay = prev.toISOString().slice(0, 10) // 1st of last month (auto-locked for Dev / Employee)
  const lastMonthEnd = new Date(Date.UTC(prev.getUTCFullYear(), prev.getUTCMonth() + 1, 0)).toISOString().slice(0, 10)
  const tomorrow = new Date(Date.parse(today) + 86_400_000).toISOString().slice(0, 10)

  /* ---------------------------------------------------------------- master data (Owner) */
  assert.equal((await one<{ n: number }>(`select count(*)::int as n from fuel.fuel_stations where id = 'dv_tanker' and is_tanker_source`)).n, 1, "dv_tanker source row seeded")
  await tx(OWNER, `
    insert into core.vehicle_types (code, name, category, default_mileage) values ('BUS_41', '41-seater bus', 'BUS', 4.9), ('CAR', 'Car', 'CAR', 12);
    ${ev("UPDATED", "Settings", "Settings", "settings")}
    insert into core.customers (id, code, short_name, name, company_code) values ('cus_minda', 'MINDA', 'Minda', 'Minda Industries', 'VTHPL');
    insert into core.customer_status_periods (customer_id, status, start_date) values ('cus_minda', 'ACTIVE', '2026-01-01');
    ${ev("CREATED", "Customers", "Customer", "cus_minda")}
  `)
  for (const [id, reg, type, fuel] of [["veh_bus", "TN70AM1921", "BUS_41", "DIESEL"], ["veh_car", "KA51MW5115", "CAR", "PETROL"], ["veh_jio", "TN70AX9480", "BUS_41", "DIESEL"], ["veh_off", "KA53C0538", "BUS_41", "DIESEL"]])
    await tx(OWNER, `
      insert into core.vehicles (id, reg_no, company_code, type_code, fuel_type, assigned_customer_id) values ('${id}', '${reg}', 'VT', '${type}', '${fuel}', ${id === "veh_bus" ? "'cus_minda'" : "null"});
      insert into core.vehicle_status_periods (vehicle_id, status, start_date) values ('${id}', 'ACTIVE', '2026-01-01');
      insert into core.vehicle_assignments (vehicle_id, customer_id, start_date) values ('${id}', ${id === "veh_bus" ? "'cus_minda'" : "null"}, '${today}');
      ${ev("CREATED", "Vehicles", "Vehicle", id)}
    `)
  await refused(tx(OWNER, `insert into core.vehicles (reg_no, company_code, type_code, fuel_type) values ('tn 70 am-1921', 'VT', 'BUS_41', 'DIESEL'); ${ev("CREATED", "Vehicles", "Vehicle", "x")}`), /vehicles_reg_no_key/, "registration unique (spaces / case ignored)")
  await refused(tx(OWNER, `insert into core.vehicle_assignments (vehicle_id, customer_id, start_date) values ('veh_bus', null, '${today}'); ${ev("TRANSFERRED", "Vehicles", "Vehicle assignment", "veh_bus")}`), /vehicle_assignments_no_overlap/, "assignment periods never overlap")
  await tx(OWNER, `
    insert into fuel.fuel_stations (id, name, location) values ('dv_raghuveer', 'Raghuveer Fuel Station', 'Krishnagiri');
    ${ev("CREATED", "Fuel Stations", "Fuel station", "dv_raghuveer")}
    insert into fuel.tankers (id, name, reg_no, vehicle_id) values ('tnk_jio', 'JIO', 'TN70AX9480', 'veh_jio'), ('tnk_office', 'Office', 'KA53C0538', 'veh_off');
    ${ev("CREATED", "Diesel Tanker", "Tanker", "tnk_jio")} ${ev("CREATED", "Diesel Tanker", "Tanker", "tnk_office")}
  `)
  await refused(tx(OWNER, `insert into fuel.fuel_stations (name) values ('  raghuveer fuel station '); ${ev("CREATED", "Fuel Stations", "Fuel station", "x")}`), /fuel_stations_name_key/, "station names unique (case / spaces)")
  await refused(tx(OWNER, `insert into fuel.tankers (name, reg_no) values ('Pool', ''); ${ev("CREATED", "Diesel Tanker", "Tanker", "x")}`), /check constraint/, "every tanker has a registration (no stock pools)")

  /* ---------------------------------------------------------------- audit: no change without its event */
  await refused(tx(OWNER, `insert into fuel.fuel_stations (name) values ('Shrudu Petro')`), /has no audit event/, "a change without an audit event is refused at commit")
  assert.equal((await one<{ n: number }>(`select count(*)::int as n from fuel.fuel_stations where name = 'Shrudu Petro'`)).n, 0, "…and nothing is saved")

  /* ---------------------------------------------------------------- tanker load = the purchase; amount exact */
  await tx(EMP, `insert into fuel.tanker_loads (id, tanker_id, date, station_id, litres, rate, amount) values ('tkl_1', 'tnk_jio', '${today}', 'dv_raghuveer', 1000, 94.80, 1); ${ev("CREATED", "Diesel Tanker", "Tanker load", "tkl_1")}`)
  assert.equal((await one<{ amount: string }>(`select amount::text from fuel.tanker_loads where id = 'tkl_1'`)).amount, "94800.00", "load amount = litres × rate (recalculated, never trusted)")
  await refused(tx(EMP, `insert into fuel.tanker_loads (tanker_id, date, station_id, litres, rate, amount) values ('tnk_jio', '${today}', 'dv_tanker', 10, 90, 0); ${ev("CREATED", "Diesel Tanker", "Tanker load", "x")}`), /foreign key/, "a load is never bought from the tanker source")

  /* ---------------------------------------------------------------- tanker fill = internal consumption */
  await tx(EMP, `insert into fuel.diesel_entries (id, company_code, date, vehicle_id, customer_id, station_id, tanker_id, litres, rate, odometer_km) values ('dsl_t1', 'VT', '${today}', 'veh_bus', 'cus_minda', 'dv_tanker', 'tnk_jio', 300, 95, 1000); ${ev("CREATED", "Diesel", "Diesel entry (from tanker)", "dsl_t1")}`)
  assert.equal((await one<{ amount: string }>(`select amount::text from fuel.diesel_entries where id = 'dsl_t1'`)).amount, "28500.00", "fill amount = litres × source rate")
  assert.equal((await one<{ km: string }>(`select odometer_km::text as km from core.vehicles where id = 'veh_bus'`)).km, "1000.0", "a fill raises the vehicle's last known km (Employee can't edit vehicles)")
  await refused(tx(EMP, `insert into fuel.diesel_entries (company_code, date, vehicle_id, station_id, tanker_id, litres, rate, odometer_km) values ('VT', '${today}', 'veh_bus', 'dv_tanker', 'tnk_jio', 800, 95, 1100); ${ev("CREATED", "Diesel", "Diesel entry", "x")}`), /Insufficient tanker inventory in JIO\. Available: 700(\.00)? L/, "a fill can't overdraw its tanker")
  await refused(tx(EMP, `insert into fuel.diesel_entries (company_code, date, vehicle_id, station_id, tanker_id, litres, rate, odometer_km) values ('VT', '${today}', 'veh_bus', 'dv_tanker', 'tnk_office', 10, 95, 1100); ${ev("CREATED", "Diesel", "Diesel entry", "x")}`), /Insufficient tanker inventory in Office\. Available: 0/, "each tanker's stock is its own")
  await refused(tx(EMP, `insert into fuel.diesel_entries (company_code, date, vehicle_id, station_id, tanker_id, litres, rate, odometer_km) values ('VT', '${today}', 'veh_bus', 'dv_raghuveer', 'tnk_jio', 10, 95, 1100); ${ev("CREATED", "Diesel", "Diesel entry", "x")}`), /foreign key/, "a pump fill can't name a tanker")
  await refused(tx(EMP, `insert into fuel.diesel_entries (company_code, date, vehicle_id, station_id, litres, rate, odometer_km) values ('VT', '${today}', 'veh_bus', 'dv_tanker', 10, 95, 1100); ${ev("CREATED", "Diesel", "Diesel entry", "x")}`), /foreign key/, "a tanker fill must name its tanker")
  await refused(tx(EMP, `insert into fuel.diesel_entries (company_code, date, vehicle_id, station_id, tanker_id, litres, rate, odometer_km, payment_mode) values ('VT', '${today}', 'veh_bus', 'dv_tanker', 'tnk_jio', 10, 95, 1100, 'CASH'); ${ev("CREATED", "Diesel", "Diesel entry", "x")}`), /check constraint/, "a tanker fill is never cash")

  // Pump fill: exact paise in NUMERIC.
  await tx(EMP, `insert into fuel.diesel_entries (id, company_code, date, vehicle_id, station_id, litres, rate, odometer_km, payment_mode) values ('dsl_p1', 'VT', '${today}', 'veh_car', 'dv_raghuveer', 37.64, 94.8, 500, 'CASH'); ${ev("CREATED", "Diesel", "Diesel entry", "dsl_p1")}`)
  assert.equal((await one<{ amount: string }>(`select amount::text from fuel.diesel_entries where id = 'dsl_p1'`)).amount, "3568.27", "37.64 L × ₹94.80 = ₹3,568.27")
  await refused(tx(EMP, `insert into fuel.diesel_entries (company_code, date, vehicle_id, station_id, litres, rate, odometer_km) values ('VT', '${tomorrow}', 'veh_car', 'dv_raghuveer', 10, 95, 600); ${ev("CREATED", "Diesel", "Diesel entry", "x")}`), /future/, "no future-dated entries")

  /* ---------------------------------------------------------------- transfers and adjustments */
  await tx(EMP, `insert into fuel.tanker_transfers (id, date, from_tanker_id, to_tanker_id, litres) values ('tkt_1', '${today}', 'tnk_jio', 'tnk_office', 200); ${ev("CREATED", "Diesel Tanker", "Tanker transfer", "tkt_1")}`)
  await refused(tx(EMP, `insert into fuel.tanker_transfers (date, from_tanker_id, to_tanker_id, litres) values ('${today}', 'tnk_office', 'tnk_jio', 500); ${ev("CREATED", "Diesel Tanker", "Tanker transfer", "x")}`), /Insufficient tanker inventory in Office\. Available: 0/, "a transfer can't overdraw its source (same day: transfers out run before transfers in, as valueTankers)")
  await refused(tx(EMP, `insert into fuel.tanker_transfers (date, from_tanker_id, to_tanker_id, litres) values ('${today}', 'tnk_jio', 'tnk_jio', 5); ${ev("CREATED", "Diesel Tanker", "Tanker transfer", "x")}`), /check constraint/, "a transfer needs two tankers")
  await refused(tx(EMP, `insert into fuel.tanker_adjustments (date, tanker_id, litres, reason) values ('${today}', 'tnk_jio', -10000, 'Dip reading'); ${ev("CREATED", "Diesel Tanker", "Tanker stock adjustment", "x")}`), /Insufficient tanker inventory/, "an adjustment can't take a tanker below zero")
  await refused(tx(EMP, `insert into fuel.tanker_adjustments (date, tanker_id, litres, reason) values ('${today}', 'tnk_jio', -5, '  ok '); ${ev("CREATED", "Diesel Tanker", "Tanker stock adjustment", "x")}`), /check constraint/, "an adjustment needs a reason")
  const stock = await q<{ tanker_id: string; litres: string }>(`select tanker_id, sum(litres)::text as litres from fuel.tanker_movements group by tanker_id order by tanker_id`)
  assert.deepEqual(stock, [{ tanker_id: "tnk_jio", litres: "500.000" }, { tanker_id: "tnk_office", litres: "200.000" }], "JIO 1,000 − 300 − 200 = 500 L; Office 200 L")
  await refused(tx(OWNER, `delete from fuel.tanker_loads where id = 'tkl_1'; ${ev("DELETED", "Diesel Tanker", "Tanker load", "tkl_1", "Wrong load")}`), /Insufficient tanker inventory/, "a load whose diesel is used can't be deleted")

  /* ---------------------------------------------------------------- opening stock (fresh start) */
  await refused(tx(EMP, `insert into fuel.tanker_loads (tanker_id, date, opening, litres, rate, amount) values ('tnk_office', '${today}', true, 142, 0, 0); ${ev("CREATED", "Diesel Tanker", "Tanker load", "x")}`), /row-level security/, "opening stock: Owner / Dev only")
  await tx(DEV, `insert into fuel.tanker_loads (id, tanker_id, date, opening, litres, rate, amount) values ('tkl_open', 'tnk_office', '${today}', true, 142, 0, 13500); ${ev("CREATED", "Diesel Tanker", "Tanker load", "tkl_open")}`)
  assert.deepEqual(await one(`select rate::text, amount::text from fuel.tanker_loads where id = 'tkl_open'`), { rate: "95.0700", amount: "13500.00" }, "opening keeps its value; rate = value ÷ litres")
  await refused(tx(DEV, `insert into fuel.tanker_loads (tanker_id, date, opening, litres, rate, amount) values ('tnk_office', '${today}', true, 1, 0, 0); ${ev("CREATED", "Diesel Tanker", "Tanker load", "x")}`), /tanker_loads_one_opening/, "one opening stock per tanker")
  await tx(OWNER, `update fuel.tanker_loads set litres = 150 where id = 'tkl_open'`) // RLS: opening rows aren't editable
  assert.equal((await one<{ l: string }>(`select litres::text as l from fuel.tanker_loads where id = 'tkl_open'`)).l, "142.000", "opening stock isn't edited")
  await refused(db.exec(`update fuel.tanker_loads set litres = 150 where id = 'tkl_open'`), /Opening stock can't be edited/, "…not even by the server role")

  /* ---------------------------------------------------------------- AdBlue */
  await tx(EMP, `insert into fuel.adblue_purchases (id, date, vendor_name, buckets, litres_per_bucket, price_per_bucket) values ('adp_1', '${today}', 'Om Sai', 10, 20, 900); ${ev("CREATED", "AdBlue", "AdBlue purchase", "adp_1")}`)
  assert.deepEqual(await one(`select total_litres::text, total_cost::text from fuel.adblue_purchases where id = 'adp_1'`), { total_litres: "200.000", total_cost: "9000.00" }, "10 × 20 L at ₹900 = 200 L for ₹9,000.00")
  await tx(EMP, `insert into fuel.adblue_entries (id, vehicle_id, date, closing_km, quantity_litres) values ('adb_1', 'veh_bus', '${today}', 1000, 15); ${ev("CREATED", "AdBlue", "AdBlue entry", "adb_1")}`)
  await refused(tx(EMP, `insert into fuel.adblue_entries (vehicle_id, date, closing_km, quantity_litres) values ('veh_bus', '${today}', 1100, 500); ${ev("CREATED", "AdBlue", "AdBlue entry", "x")}`), /Insufficient AdBlue inventory\. Available stock: 185(\.00)?L/, "a draw can't exceed stock")
  await tx(EMP, `insert into fuel.adblue_entries (id, source, vehicle_id, date, closing_km, quantity_litres, vendor_name, rate, payment_mode) values ('adb_d', 'DIRECT', 'veh_bus', '${today}', 1050, 30, 'Highway Fuels', 95.5, 'CASH'); ${ev("CREATED", "AdBlue", "AdBlue entry", "adb_d")}`)
  assert.equal((await one<{ amount: string }>(`select amount::text from fuel.adblue_entries where id = 'adb_d'`)).amount, "2865.00", "direct purchase amount = litres × rate")
  assert.equal((await one<{ s: string }>(`select sum(litres)::text as s from fuel.adblue_stock_movements`)).s, "185.000", "a direct purchase never touches bulk stock")
  await refused(tx(EMP, `insert into fuel.adblue_entries (vehicle_id, date, closing_km, quantity_litres, vendor_name) values ('veh_bus', '${today}', 1100, 5, 'X'); ${ev("CREATED", "AdBlue", "AdBlue entry", "x")}`), /check constraint/, "a stock draw has no vendor")
  await refused(tx(OWNER, `delete from fuel.adblue_purchases where id = 'adp_1'; ${ev("DELETED", "AdBlue", "AdBlue purchase", "adp_1", "Duplicate")}`), /Insufficient AdBlue inventory/, "a purchase whose AdBlue is used can't be deleted")

  /* ---------------------------------------------------------------- month lock (RLS) */
  await refused(tx(EMP, `insert into fuel.diesel_entries (company_code, date, vehicle_id, station_id, litres, rate, odometer_km) values ('VT', '${lastMonthDay}', 'veh_car', 'dv_raghuveer', 10, 95, 400); ${ev("CREATED", "Diesel", "Diesel entry", "x")}`), /row-level security/, "last month is locked for Employee")
  await refused(tx(DEV, `insert into fuel.diesel_entries (company_code, date, vehicle_id, station_id, litres, rate, odometer_km) values ('VT', '${lastMonthDay}', 'veh_car', 'dv_raghuveer', 10, 95, 400); ${ev("CREATED", "Diesel", "Diesel entry", "x")}`), /row-level security/, "…and for Dev")
  await tx(OWNER, `insert into fuel.diesel_entries (id, company_code, date, vehicle_id, station_id, litres, rate, odometer_km) values ('dsl_old', 'VT', '${lastMonthDay}', 'veh_car', 'dv_raghuveer', 10, 95, 400); ${ev("CREATED", "Diesel", "Diesel entry", "dsl_old")}`)
  await refused(tx(DEV, `insert into core.month_locks (month, state, changed_by_role) values ('${thisMonth}', 'LOCKED', 'OWNER'); ${ev("MONTH_LOCKED", "Month Lock", "Month lock", thisMonth)}`), /row-level security/, "only the Owner locks a month")
  await tx(OWNER, `insert into core.month_locks (month, state, changed_by_role, changed_by) values ('${thisMonth}', 'LOCKED', 'OWNER', private.current_profile_id()); ${ev("MONTH_LOCKED", "Month Lock", "Month lock", thisMonth)}`)
  await refused(tx(EMP, `insert into fuel.diesel_entries (company_code, date, vehicle_id, station_id, litres, rate, odometer_km) values ('VT', '${today}', 'veh_car', 'dv_raghuveer', 10, 95, 700); ${ev("CREATED", "Diesel", "Diesel entry", "x")}`), /row-level security/, "a month locked early is closed to Employee")
  await tx(EMP, `update fuel.diesel_entries set litres = 40 where id = 'dsl_p1'`) // RLS: the row isn't editable, so nothing changes
  assert.equal((await one<{ l: string }>(`select litres::text as l from fuel.diesel_entries where id = 'dsl_p1'`)).l, "37.640", "…including edits")
  await tx(OWNER, `update core.month_locks set state = 'OPEN' where month = '${thisMonth}'; ${ev("MONTH_UNLOCKED", "Month Lock", "Month lock", thisMonth)}`)

  /* ---------------------------------------------------------------- fuel station payments and TDS */
  await tx(OWNER, `insert into finance.payments (id, company_code, direction, date, party_type, station_id, party_name, category_code, amount, mode, for_month) values ('pay_1', 'VT', 'OUT', '${today}', 'VENDOR', 'dv_raghuveer', 'Raghuveer Fuel Station', 'DIESEL_SETTLEMENT', 70000, 'NEFT', '${lastMonthDay.slice(0, 7)}'); ${ev("PAYMENT_RECORDED", "Fuel Stations", "Fuel station payment", "pay_1")}`)
  await tx(OWNER, `insert into finance.payments (id, company_code, direction, date, party_type, station_id, party_name, category_code, amount, mode, for_month) values ('pay_2', 'VT', 'OUT', '${today}', 'VENDOR', 'dv_raghuveer', 'Raghuveer Fuel Station', 'DIESEL_SETTLEMENT', 500, 'CASH', '${thisMonth}'); ${ev("PAYMENT_RECORDED", "Fuel Stations", "Fuel station payment", "pay_2")}`)
  const fy = Number(today.slice(5, 7)) >= 4 ? Number(today.slice(0, 4)) : Number(today.slice(0, 4)) - 1
  assert.deepEqual((await q<{ payment_no: string }>(`select payment_no from finance.payments order by payment_no`)).map((r) => r.payment_no), [`VT-PAY-${fy}${String((fy + 1) % 100).padStart(2, "0")}-0001`, `VT-PAY-${fy}${String((fy + 1) % 100).padStart(2, "0")}-0002`], "voucher numbers as nextSeq")
  const pay = (values: string, id: string) => `insert into finance.payments (id, company_code, direction, date, party_type, station_id, party_name, category_code, amount, tds_amount, mode, for_month) values ('${id}', ${values}; ${ev("PAYMENT_RECORDED", "Fuel Stations", "Fuel station payment", id)}`
  await refused(tx(OWNER, pay(`'VT', 'OUT', '${today}', 'VENDOR', 'dv_tanker', 'Diesel Tanker', 'DIESEL_SETTLEMENT', 10, 0, 'NEFT', null)`, "pay_x1")), /foreign key/, "nobody pays the tanker source")
  await refused(tx(OWNER, pay(`'VT', 'OUT', '${today}', 'VENDOR', 'dv_raghuveer', 'R', 'DIESEL_SETTLEMENT', 10, 0, 'NEFT', '2099-01')`, "pay_x2")), /check constraint/, "not paid against a later month")
  await refused(tx(OWNER, pay(`'VT', 'OUT', '${tomorrow}', 'VENDOR', 'dv_raghuveer', 'R', 'DIESEL_SETTLEMENT', 10, 0, 'NEFT', null)`, "pay_x3")), /future/, "no future-dated payment")
  await refused(tx(EMP, pay(`'VT', 'OUT', '${today}', 'VENDOR', 'dv_raghuveer', 'R', 'DIESEL_SETTLEMENT', 10, 0, 'NEFT', null)`, "pay_x4")), /row-level security/, "Employee doesn't record payments")
  assert.equal((await asUser<{ n: number }>(EMP, `select count(*)::int as n from finance.payments`))[0].n, 2, "…but sees station payments on the ledger (diesel:view)")
  await tx(OWNER, pay(`'VT', 'OUT', '${lastMonthEnd}', 'VENDOR', 'dv_raghuveer', 'R', 'DIESEL_SETTLEMENT', 0, 94.80, 'TDS', '${lastMonthEnd.slice(0, 7)}')`, "pay_tds5"))
  await refused(tx(OWNER, pay(`'VT', 'OUT', '${lastMonthEnd}', 'VENDOR', 'dv_raghuveer', 'R', 'DIESEL_SETTLEMENT', 0, 1, 'TDS', '${lastMonthEnd.slice(0, 7)}')`, "pay_tds6")), /payments_one_tds_per_station_month/, "one TDS per station per month")
  await refused(tx(OWNER, pay(`'VT', 'OUT', '${lastMonthDay}', 'VENDOR', 'dv_raghuveer', 'R', 'DIESEL_SETTLEMENT', 0, 1, 'TDS', '${lastMonthDay.slice(0, 7)}')`, "pay_tds7")), /check constraint/, "TDS is dated the month's last day")
  await refused(tx(OWNER, pay(`'VT', 'IN', '${today}', 'CUSTOMER', null, 'Minda', null, 100, 0, 'NEFT', null)`, "pay_rct8")), /payments_phase1_fuel_station_only/, "phase 1 stores station payments only")

  /* ---------------------------------------------------------------- opening balance */
  await refused(tx(EMP, `update fuel.fuel_stations set opening_balance = 9455.49, opening_balance_date = '${today}' where id = 'dv_raghuveer'; ${ev("UPDATED", "Fuel Stations", "Fuel station", "dv_raghuveer")}`), /Only the Owner or Dev/, "opening balances: Owner / Dev")
  await tx(DEV, `update fuel.fuel_stations set opening_balance = -2500, opening_balance_date = '${today}' where id = 'dv_raghuveer'; ${ev("UPDATED", "Fuel Stations", "Fuel station", "dv_raghuveer")}`)
  assert.equal((await one<{ b: string }>(`select opening_balance::text as b from fuel.fuel_stations where id = 'dv_raghuveer'`)).b, "-2500.00", "a Credit opening balance is kept signed")

  /* ---------------------------------------------------------------- delete, reason, restore, review */
  await refused(tx(OWNER, `delete from fuel.diesel_entries where id = 'dsl_p1'`), /has no audit event/, "a delete needs its DELETED event")
  await refused(tx(OWNER, `delete from fuel.diesel_entries where id = 'dsl_p1'; ${ev("DELETED", "Diesel", "Diesel entry", "dsl_p1", "  x ")}`), /check constraint/, "…with a reason of at least 3 characters")
  await refused(tx(EMP, `delete from fuel.diesel_entries where id = 'dsl_p1'; ${ev("DELETED", "Diesel", "Diesel entry", "dsl_p1", "Wrong vehicle")}`), /row-level security/, "Employee can't delete (nor write a deletion event)")
  await tx(OWNER, `delete from fuel.diesel_entries where id = 'dsl_p1'; ${ev("DELETED", "Diesel", "Diesel entry", "dsl_p1", "Wrong vehicle")}`)
  const del = (await one<{ id: string }>(`select id from audit.events where action = 'DELETED' and record_id = 'dsl_p1' order by at limit 1`)).id
  const restore = (who: string) => tx(who, `insert into fuel.diesel_entries (id, company_code, date, vehicle_id, station_id, litres, rate, odometer_km, payment_mode) values ('dsl_p1', 'VT', '${today}', 'veh_car', 'dv_raghuveer', 37.64, 94.8, 500, 'CASH'); ${ev("RESTORED", "Diesel", "Diesel entry", "dsl_p1", "Deleted by mistake", del)}`)
  await refused(restore(DEV), /row-level security/, "only the Owner restores")
  await restore(OWNER)
  await refused(tx(OWNER, `delete from fuel.diesel_entries where id = 'dsl_p1'; ${ev("DELETED", "Diesel", "Diesel entry", "dsl_p1", "Again")}`).then(() => restore(OWNER)), /audit_events_restores_event_id_key|duplicate key/, "a deletion is restored once")
  await refused(tx(DEV, `insert into audit.reviews (event_id, actor_user_id, actor_role) values ('${del}', private.current_profile_id(), 'DEV')`), /row-level security/, "only the Owner reviews deletions")
  await tx(OWNER, `insert into audit.reviews (event_id, actor_user_id, actor_role) values ('${del}', private.current_profile_id(), 'OWNER')`)
  const created = (await one<{ id: string }>(`select id from audit.events where action = 'CREATED' limit 1`)).id
  await refused(tx(OWNER, `insert into audit.reviews (event_id, actor_user_id, actor_role) values ('${created}', private.current_profile_id(), 'OWNER')`), /Only deletion events/, "only deletions are reviewed")
  await refused(db.exec(`update audit.events set reason = 'changed' where id = '${del}'`), /append-only/, "audit events are never edited — not even by the database owner")
  await refused(db.exec(`delete from audit.events`), /append-only/, "…or deleted")
  await refused(db.exec(`truncate audit.events cascade`), /append-only/, "…or truncated")

  /* ---------------------------------------------------------------- who reads what */
  const audited = async (who: string) => (await asUser<{ m: string }>(who, `select distinct module as m from audit.events order by 1`)).map((r) => r.m)
  assert.ok((await audited(DEV)).includes("Month Lock"), "Dev reads the whole audit log")
  assert.deepEqual(await audited(EMP), ["AdBlue", "Diesel", "Diesel Tanker", "Fuel Stations", "Vehicles"], "Employee reads only the history of modules it can view")
  assert.equal((await asUser<{ n: number }>(EMP, `select count(*)::int as n from audit.reviews`))[0].n, 0, "Employee doesn't see deletion reviews")
  await refused(asUser(null, `select * from fuel.diesel_entries`), /permission denied/, "signed-out visitors read nothing")
  await db.exec(`insert into auth.users values ('00000000-0000-0000-0000-0000000000a9', 'stranger@example.com')`)
  assert.equal((await asUser<{ n: number }>("00000000-0000-0000-0000-0000000000a9", `select count(*)::int as n from fuel.diesel_entries`))[0].n, 0, "a Google account without an ERP account sees nothing")

  /* ---------------------------------------------------------------- archived vehicle */
  await tx(OWNER, `
    update core.vehicle_status_periods set end_date = '${today}'::date - 1 where vehicle_id = 'veh_car' and end_date is null;
    insert into core.vehicle_status_periods (vehicle_id, status, start_date) values ('veh_car', 'ARCHIVED', '${today}');
    update core.vehicles set status = 'ARCHIVED' where id = 'veh_car';
    ${ev("ARCHIVED", "Vehicles", "Vehicle", "veh_car")}
  `)
  await refused(tx(OWNER, `insert into fuel.diesel_entries (company_code, date, vehicle_id, station_id, litres, rate, odometer_km) values ('VT', '${today}', 'veh_car', 'dv_raghuveer', 10, 95, 900); ${ev("CREATED", "Diesel", "Diesel entry", "x")}`), /archived/, "an archived vehicle takes no new entries")

  await db.close()
  console.log("supabase diesel schema: migrations, RLS, month locks, tanker and AdBlue stock, payments, TDS and audit: all checks passed")
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
