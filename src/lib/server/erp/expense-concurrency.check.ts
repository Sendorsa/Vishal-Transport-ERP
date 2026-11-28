/**
 * Expense broker ledger under GENUINELY concurrent sessions:  EXPENSE_DB_PG_DIR=<data dir> npm run check:expense-concurrency
 * Needs a LOCAL throwaway PostgreSQL server listening only on its Unix socket in that directory (no host, no network) —
 * PGlite has one connection, so this can't run there. Several real sessions write the same broker at once:
 *   1. the race is real: with an identical artificial delay inside the COMMIT-time checks, a copy of the migration WITHOUT
 *      the per-broker lock lets two sessions overpay; the migration WITH it refuses one of them;
 *   2. the real migration (no delay), many rounds of simultaneous payments / bill edits: never a negative balance at any
 *      date, and a refused transaction leaves nothing (no entry, no audit event);
 *   3. opening balances: two at once (unique index), and an opening racing an earlier-dated bill (opening-first check);
 *   4. through the app (engine) on parallel connections: simultaneous payments, the duplicate-payment confirmation and
 *      one request id sent at once;
 *   5. section-month locks (F2): two sessions, a lock being added and an Expense write overlapping — a write in progress
 *      when a month is locked, a lock in progress when a write starts, an entry's date moved into / out of a month being
 *      locked, a vehicle line changed either way round. A copy of the migration WITHOUT `lock table … in share mode`
 *      lets every one commit a write into a locked month; the migration serialises them (the lock waits for the write,
 *      or the write waits for the lock and is refused). Plus the app's own lock / write at once, and a single statement
 *      outside a transaction block.
 */
import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import postgres from "postgres"
import type { RequestIdentity } from "@/lib/request-scope"

const PG_DIR = process.env.EXPENSE_DB_PG_DIR
const MIG = new URL("../../../../supabase/migrations/", import.meta.url)
const U = "00000000-0000-0000-0000-0000000000c1"
const P = "10000000-0000-0000-0000-0000000000c1"
const BROKER = "Race Broker"
const KEY = "RACE BROKER"

type Sql = ReturnType<typeof postgres>
let dbNo = 0
const OPTS = { path: ".s.PGSQL.54317", user: "postgres", prepare: false, onnotice: () => undefined } as const

/** A new database on the local server with every migration (the Expense one as given). */
async function database(expenseMigration: string): Promise<Sql> {
  const admin = postgres({ ...OPTS, database: "postgres", max: 1 })
  const name = `expense_conc_${process.pid}_${++dbNo}`
  await admin.unsafe(`create database ${name}`)
  await admin.end()
  const one = postgres({ ...OPTS, database: name, max: 1 })
  await one.unsafe(`
    do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
    do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
    do $$ begin create role service_role nologin bypassrls; exception when duplicate_object then null; end $$;
    create schema auth;
    create table auth.users (id uuid primary key, email text);
    create table auth.identities (id uuid primary key default gen_random_uuid(), user_id uuid references auth.users (id), provider text, identity_data jsonb, created_at timestamptz default now());
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema public, auth to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated;
  `).simple()
  for (const f of readdirSync(MIG).filter((f) => f.endsWith(".sql") && f < "20261128").sort()) await one.unsafe(readFileSync(new URL(f, MIG), "utf8")).simple()
  await one.unsafe(expenseMigration).simple()
  await one.unsafe(`
    insert into auth.users values ('${U}', 'dev@example.com');
    insert into public.profiles (id, user_id, email, full_name, role, status, activated_at) values ('${P}', '${U}', 'dev@example.com', 'Dev Person', 'DEV', 'ACTIVE', now());
    insert into audit.events (actor_kind, action, module, record_type, record_id) values ('SYSTEM', 'CREATED', 'Accounts', 'User account', '${P}');
  `).simple()
  await one.end()
  return postgres({ ...OPTS, database: name, max: 20 })
}

let n = 0
const rid = (p: string) => `exp_${p}${String(++n).padStart(10, "0")}`
const ev = (id: string, action = "CREATED") => `insert into audit.events (actor_kind, action, module, record_type, record_id) values ('SYSTEM', '${action}', 'Expense', 'Broker', '${id}');`
const bill = (id: string, amount: number, date = "2026-09-01") => `${ev(id)} insert into expense.entries (id, section, date, entry_type, broker_name, description, amount) values ('${id}', 'BROKER', '${date}', 'CHARGE', '${BROKER}', 'bill', ${amount});`
const pay = (id: string, amount: number, date = "2026-09-10") => `${ev(id)} insert into expense.entries (id, section, date, entry_type, broker_name, paid_amount, payment_date) values ('${id}', 'BROKER', '${date}', 'PAYMENT', '${BROKER}', ${amount}, '${date}');`
const opening = (id: string, amount: number, date: string, broker = BROKER) => `${ev(id)} insert into expense.entries (id, section, date, entry_type, broker_name, amount) values ('${id}', 'BROKER', '${date}', 'BROUGHT_FORWARD', '${broker}', ${amount});`

/** The lowest running balance of the broker in ledger order (the trigger's order) and the final balance. */
async function ledger(sql: Sql, key = KEY) {
  const [r] = await sql.unsafe(`
    select coalesce(min(bal), 0)::float8 low, coalesce((array_agg(bal order by rn desc))[1], 0)::float8 final from (
      select row_number() over w rn, sum(case when entry_type = 'PAYMENT' then -paid_amount else amount - paid_amount end) over w bal
      from expense.entries where section = 'BROKER' and broker_key = '${key}'
      window w as (order by date, case entry_type when 'BROUGHT_FORWARD' then 0 when 'CHARGE' then 1 else 2 end, created_at, id collate "C")) x`)
  return r as unknown as { low: number; final: number }
}

/** Every session runs its statements in its own open transaction; then all COMMIT at the same moment. */
async function race(sql: Sql, work: string[]) {
  const sessions = await Promise.all(work.map(() => sql.reserve()))
  try {
    await Promise.all(sessions.map((s, i) => s.unsafe(`begin; ${work[i]}`).simple()))
    return await Promise.allSettled(sessions.map((s) => s.unsafe("commit")))
  } finally {
    for (const s of sessions) {
      await s.unsafe("rollback").catch(() => undefined)
      s.release()
    }
  }
}
/** Sessions that may block one another on a unique index: each commits as soon as its own work is done (still all at once). */
async function raceEach(sql: Sql, work: string[]) {
  const sessions = await Promise.all(work.map(() => sql.reserve()))
  try {
    return await Promise.allSettled(sessions.map((s, i) => s.unsafe(`begin; ${work[i]} commit;`).simple()))
  } finally {
    for (const s of sessions) {
      await s.unsafe("rollback").catch(() => undefined)
      s.release()
    }
  }
}
const ok = (r: PromiseSettledResult<unknown>[]) => r.filter((x) => x.status === "fulfilled").length
const reasons = (r: PromiseSettledResult<unknown>[]) => r.filter((x): x is PromiseRejectedResult => x.status === "rejected").map((x) => String((x.reason as Error).message))

/** The migration with an identical delay at the end of both COMMIT-time broker checks; optionally without the lock. */
function variant(withLock: boolean) {
  let text = readFileSync(new URL("20261128000000_expense_schema.sql", MIG), "utf8")
  for (const fn of ["broker_ledger_guard", "broker_opening_first"]) {
    const at = text.indexOf(`create function private.${fn}()`)
    const end = text.indexOf("  return null;\nend $$;", at)
    assert.ok(at > 0 && end > at, `${fn} found`)
    text = `${text.slice(0, end)}  perform pg_sleep(0.4); -- test only: hold the check open so the sessions overlap\n${text.slice(end)}`
  }
  const lockLine = "perform pg_advisory_xact_lock(hashtext('vishal-erp:expense-broker:' || k));"
  assert.equal(text.split(lockLine).length - 1, 2, "both checks take the per-broker lock")
  return withLock ? text : text.split(lockLine).join("null; -- lock removed (test control)")
}

const MONTH_LOCK_LINE = "  lock table expense.month_locks in share mode; -- see above: serialises with a lock being added\n"
/** The real migration, or (control) the same text without the month-lock guard's table lock. */
function monthLockVariant(withLock: boolean) {
  const text = readFileSync(new URL("20261128000000_expense_schema.sql", MIG), "utf8")
  assert.equal(text.split(MONTH_LOCK_LINE).length - 1, 1, "the month-lock guard takes the table lock once")
  return withLock ? text : text.replace(MONTH_LOCK_LINE, "")
}
const VEH1 = "veh_conc00000001"
const VEH2 = "veh_conc00000002"
const lockMonth = (month: string, section = "FITNESS") => { const id = `eml_conc_${section}_${month}`; return `${ev(id)} insert into expense.month_locks (id, section, month, locked_by_role) values ('${id}', '${section}', '${month}', 'DEV');` }
const fitness = (id: string, date: string, vehicle = VEH1) => `${ev(id)} insert into expense.entries (id, section, date, amount) values ('${id}', 'FITNESS', '${date}', 300); insert into expense.entry_vehicles (entry_id, line_no, vehicle_id) values ('${id}', 0, '${vehicle}');`
const moveDate = (id: string, date: string) => `${ev(id, "UPDATED")} update expense.entries set date = '${date}' where id = '${id}';`
const replaceLine = (id: string, vehicle: string) => `${ev(id, "UPDATED")} delete from expense.entry_vehicles where entry_id = '${id}'; insert into expense.entry_vehicles (entry_id, line_no, vehicle_id) values ('${id}', 0, '${vehicle}');`
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))
/**
 * Two sessions: session 1 runs `first` in an open transaction; session 2 then starts `second`. After 500 ms: did session 2
 * have to wait (and was it waiting on a lock — pg_stat_activity)? Then the LOCK's session commits as early as it can and
 * the WRITE's session last — the order in which a write could slip into a locked month. Returns what committed, in order.
 */
async function overlap(sql: Sql, first: string, second: string, lockIn: 1 | 2) {
  const [s1, s2] = [await sql.reserve(), await sql.reserve()]
  const order: string[] = []
  const name = (i: 1 | 2) => (i === lockIn ? "lock" : "write")
  try {
    await s1.unsafe(`begin; ${first}`).simple()
    const [{ pid }] = (await s2.unsafe("select pg_backend_pid() pid")) as unknown as { pid: number }[]
    let settled = false
    const work2 = s2.unsafe(`begin; ${second}`).simple().then(() => undefined).finally(() => { settled = true })
    work2.catch(() => undefined)
    await pause(500)
    const waited = !settled
    const [{ w }] = (await sql.unsafe(`select coalesce(wait_event_type, '') w from pg_stat_activity where pid = ${pid}`)) as unknown as { w: string }[]
    const commit = async (s: typeof s1, i: 1 | 2) => { await s.unsafe("commit"); order.push(name(i)) }
    let refused: string | null = null
    const finish2 = async () => { try { await work2; await commit(s2, 2) } catch (e) { refused = String((e as Error).message); order.push(`${name(2)} refused`) } }
    if (lockIn === 2 && !waited) { await finish2(); await commit(s1, 1) } // the lock is ready first: it commits, then the write
    else { await commit(s1, 1); await finish2() }
    return { waited, waitEvent: w, order, refused: refused as string | null, slipped: order.indexOf("lock") >= 0 && order.indexOf("write") > order.indexOf("lock") }
  } finally {
    for (const s of [s1, s2]) {
      await s.unsafe("rollback").catch(() => undefined)
      s.release()
    }
  }
}
/** F2 — the six overlaps on one database; returns each outcome. */
async function monthLockRaces(sql: Sql) {
  await sql.unsafe(`insert into audit.events (actor_kind, action, module, record_type, record_id) values ('SYSTEM', 'CREATED', 'Vehicles', 'Vehicle', '${VEH1}'), ('SYSTEM', 'CREATED', 'Vehicles', 'Vehicle', '${VEH2}');
    insert into core.vehicles (id, reg_no, company_code, type_code, fuel_type) values ('${VEH1}', 'TN70CC0001', 'VTHPL', 'BUS_55', 'DIESEL'), ('${VEH2}', 'TN70CC0002', 'VTHPL', 'BUS_55', 'DIESEL');`).simple()
  for (const [id, date] of [["exp_c_c1", "2025-12-10"], ["exp_c_c2", "2026-04-10"], ["exp_c_d1", "2026-05-10"], ["exp_c_d2", "2026-06-10"]]) await sql.unsafe(fitness(id, date)).simple()
  return {
    a_writeInProgressThenLock: await overlap(sql, fitness("exp_c_a", "2026-01-10"), lockMonth("2026-01"), 2),
    b_lockInProgressThenWrite: await overlap(sql, lockMonth("2026-02"), fitness("exp_c_b", "2026-02-10"), 1),
    c1_dateMovedIntoMonthBeingLocked: await overlap(sql, lockMonth("2026-03"), moveDate("exp_c_c1", "2026-03-10"), 1),
    c2_dateMovedOutOfMonthBeingLocked: await overlap(sql, lockMonth("2026-04"), moveDate("exp_c_c2", "2025-11-10"), 1),
    d1_vehicleLineInProgressThenLock: await overlap(sql, replaceLine("exp_c_d1", VEH2), lockMonth("2026-05"), 2),
    d2_lockInProgressThenVehicleLine: await overlap(sql, lockMonth("2026-06"), replaceLine("exp_c_d2", VEH2), 1),
  }
}

async function main() {
  if (!PG_DIR) throw new Error("Set EXPENSE_DB_PG_DIR to the data directory of a LOCAL throwaway PostgreSQL server (Unix socket only).")
  process.chdir(PG_DIR) // relative socket path (macOS limits socket paths to ~103 characters)

  /* ---------------------------------------------------------------- 1. the race is real; the lock closes it */
  const results: Record<string, unknown> = {}
  for (const withLock of [false, true]) {
    const sql = await database(variant(withLock))
    const label = withLock ? "with lock" : "WITHOUT lock (control)"
    // 1a. two payments of 6,000 against 10,000 owed — each fine alone, together 2,000 over.
    await sql.unsafe(bill(rid("b"), 10000)).simple()
    const r1 = await race(sql, [pay(rid("p"), 6000), pay(rid("p"), 6000)])
    const l1 = await ledger(sql)
    // 1b. a bill cut from 10,000 to 4,000 while 6,000 is paid — each fine alone, together 2,000 over.
    const k2 = "RACE TWO"
    const b2 = rid("b")
    await sql.unsafe(`${ev(b2)} insert into expense.entries (id, section, date, entry_type, broker_name, description, amount) values ('${b2}', 'BROKER', '2026-09-01', 'CHARGE', 'Race Two', 'bill', 10000);`).simple()
    const p2 = rid("p")
    const r2 = await race(sql, [`${ev(b2, "UPDATED")} update expense.entries set amount = 4000 where id = '${b2}';`, `${ev(p2)} insert into expense.entries (id, section, date, entry_type, broker_name, paid_amount, payment_date) values ('${p2}', 'BROKER', '2026-09-10', 'PAYMENT', 'Race Two', 6000, '2026-09-10');`])
    const l2 = await ledger(sql, k2)
    // 1c. an opening balance dated 10 Sep racing a bill dated 1 Sep for a new broker — each fine alone; together the
    // opening isn't first.
    const r3 = await race(sql, [opening(rid("o"), 5000, "2026-09-10", "Race Three"), `${ev("exp_c3bill000001")} insert into expense.entries (id, section, date, entry_type, broker_name, description, amount) values ('exp_c3bill000001', 'BROKER', '2026-09-01', 'CHARGE', 'Race Three', 'bill', 100);`])
    results[label] = { twoPayments: { committed: ok(r1), lowest: l1.low }, billCutAndPayment: { committed: ok(r2), lowest: l2.low }, openingAndEarlierBill: { committed: ok(r3) } }
    if (withLock) {
      assert.deepEqual([ok(r1), l1.low >= 0], [1, true], "1a with the lock: one payment refused, never overpaid")
      assert.match(reasons(r1)[0], /paid ₹2000.00 more than billed/)
      assert.deepEqual([ok(r2), l2.low >= 0], [1, true], "1b with the lock: the edit or the payment refused")
      assert.equal(ok(r3), 1, "1c with the lock: the opening or the earlier bill refused")
      assert.match(reasons(r3)[0], /opening balance must be dated before every other entry/)
    } else {
      assert.deepEqual([ok(r1), l1.low], [2, -2000], "1a control: without the lock BOTH payments commit — the broker is overpaid by 2,000 (the race is real)")
      assert.deepEqual([ok(r2), l2.low], [2, -2000], "1b control: without the lock the bill edit and the payment both commit — overpaid by 2,000")
      assert.equal(ok(r3), 2, "1c control: without the lock both commit — the opening is no longer first")
    }
    await sql.end()
  }

  /* ---------------------------------------------------------------- 2. the real migration under load */
  const sql = await database(readFileSync(new URL("20261128000000_expense_schema.sql", MIG), "utf8"))
  let committed = 0
  let refused = 0
  for (let round = 0; round < 40; round++) {
    const key = `Load ${round}`
    const owed = 1000 + (round % 7) * 500
    const b = rid("lb")
    await sql.unsafe(`${ev(b)} insert into expense.entries (id, section, date, entry_type, broker_name, description, amount) values ('${b}', 'BROKER', '2026-09-01', 'CHARGE', '${key}', 'bill', ${owed});`).simple()
    // 4–8 sessions at once: payments of 400–900, sometimes a cut of the bill.
    const work: string[] = []
    const ids: string[] = []
    for (let i = 0; i < 4 + (round % 5); i++) {
      const id = rid("lp")
      ids.push(id)
      work.push(i === 2 && round % 3 === 0
        ? `${ev(b, "UPDATED")} update expense.entries set amount = ${owed - 300} where id = '${b}';`
        : `${ev(id)} insert into expense.entries (id, section, date, entry_type, broker_name, paid_amount, payment_date) values ('${id}', 'BROKER', '2026-09-${String(2 + (i % 5)).padStart(2, "0")}', 'PAYMENT', '${key}', ${400 + ((round + i) % 6) * 100}, '2026-09-${String(2 + (i % 5)).padStart(2, "0")}');`)
    }
    const r = await race(sql, work)
    committed += ok(r)
    refused += r.length - ok(r)
    for (const msg of reasons(r)) assert.match(msg, /more than billed|could not serialize|deadlock detected/, `round ${round}: refused only by the ledger rule (or a detected deadlock): ${msg}`)
    const l = await ledger(sql, key.toUpperCase())
    assert.ok(l.low >= -0.005, `round ${round}: never overpaid at any date (lowest ${l.low})`)
    // No partial writes: every payment id either has its entry AND its audit event, or neither.
    const [{ bad }] = (await sql.unsafe(`select count(*)::int bad from unnest($1::text[]) t(pid)
      where (exists (select 1 from expense.entries e where e.id = t.pid)) <> (exists (select 1 from audit.events a where a.record_id = t.pid))`, [ids])) as unknown as { bad: number }[]
    assert.equal(bad, 0, `round ${round}: a refused transaction left nothing behind`)
  }
  assert.ok(refused > 0 && committed > 0, "both outcomes happened")

  /* ---------------------------------------------------------------- 3. opening balances at once */
  const o = await raceEach(sql, [opening(rid("o"), 5000, "2026-08-01", "Twin Opening"), opening(rid("o"), 7000, "2026-08-01", "Twin Opening"), opening(rid("o"), 9000, "2026-08-02", "twin  opening")])
  assert.equal(ok(o), 1, "3a three openings for one broker at once (names differing in case / spaces): exactly one")
  for (const msg of reasons(o)) assert.match(msg, /entries_one_opening|duplicate key/)
  const oc = (await sql.unsafe(`select count(*)::int n from expense.entries where broker_key = 'TWIN OPENING'`)) as unknown as { n: number }[]
  assert.equal(oc[0].n, 1, "…one row")

  /* ---------------------------------------------------------------- 5. section-month locks under two sessions (F2) */
  const monthLocks: Record<string, unknown> = {}
  {
    const control = await database(monthLockVariant(false))
    const c = await monthLockRaces(control)
    for (const [k, r] of Object.entries(c)) {
      assert.deepEqual([r.waited, r.refused, r.slipped], [false, null, true], `5 control ${k}: without the table lock nothing waits and the write commits AFTER the lock — into a locked month (the race is real)`)
    }
    monthLocks["WITHOUT table lock (control)"] = Object.fromEntries(Object.entries(c).map(([k, r]) => [k, { waited: r.waited, commitOrder: r.order.join(" → ") }]))
    await control.end()
  }
  {
    const fixed = await database(monthLockVariant(true))
    const f = await monthLockRaces(fixed)
    for (const [k, r] of Object.entries(f)) {
      assert.equal(r.waited, true, `5 ${k}: the second session waits for the first`)
      assert.equal(r.waitEvent, "Lock", `5 ${k}: …on a table lock (pg_stat_activity)`)
      assert.equal(r.slipped, false, `5 ${k}: no write commits after the lock`)
    }
    assert.deepEqual([f.a_writeInProgressThenLock.order, f.d1_vehicleLineInProgressThenLock.order], [["write", "lock"], ["write", "lock"]], "5a / 5d1 a write in progress: it commits first (the month was open), then the lock")
    for (const k of ["b_lockInProgressThenWrite", "c1_dateMovedIntoMonthBeingLocked", "c2_dateMovedOutOfMonthBeingLocked", "d2_lockInProgressThenVehicleLine"] as const) {
      assert.deepEqual(f[k].order, ["lock", "write refused"], `5 ${k}: the write waits for the lock, then is refused`)
      assert.match(f[k].refused ?? "", /is locked in Fitness/, `5 ${k}: …by the section-month lock`)
    }
    const state = (await fixed.unsafe(`select id, date::text d, (select vehicle_id from expense.entry_vehicles v where v.entry_id = e.id) v from expense.entries e where id like 'exp_c\_%' order by id`)) as unknown as { id: string; d: string; v: string }[]
    assert.deepEqual(state.map((r) => [r.id, r.d, r.v]), [["exp_c_a", "2026-01-10", VEH1], ["exp_c_c1", "2025-12-10", VEH1], ["exp_c_c2", "2026-04-10", VEH1], ["exp_c_d1", "2026-05-10", VEH2], ["exp_c_d2", "2026-06-10", VEH1]],
      "5 final state: a and d1 committed before their locks; b never written; c1 / c2 / d2 unchanged")
    // Every lock was added; a write after it is refused (and the trigger's table lock works for a single statement outside
    // a transaction block — an unchanged update needs no audit event).
    assert.equal(((await fixed.unsafe(`select count(*)::int n from expense.month_locks where id like 'eml_conc_%'`)) as unknown as { n: number }[])[0].n, 6)
    await fixed.unsafe(`update expense.entries set amount = amount where id = 'exp_c_c1'`)
    await assert.rejects(fixed.begin((tx) => tx.unsafe(fitness("exp_c_late", "2026-01-11")).simple()), /is locked in Fitness/, "5 after the lock: refused")
    monthLocks["with table lock"] = Object.fromEntries(Object.entries(f).map(([k, r]) => [k, { waited: r.waited, waitEvent: r.waitEvent, commitOrder: r.order.join(" → ") }]))
    await fixed.end()
  }

  /* ---------------------------------------------------------------- 4. through the app (engine), parallel connections */
  const { runInDatabase } = await import("./engine")
  const { PG_OPTIONS } = await import("./pg-options")
  const { api, PossibleDuplicateError } = await import("@/lib/api")
  const { blankExpense } = await import("@/domain/expenses")
  const pool = postgres({ ...OPTS, ...PG_OPTIONS, path: OPTS.path, max: 10, database: (sql.options as { database: string }).database })
  const transact = <T,>(fn: (q: (t: string, p?: unknown[]) => Promise<never[]>) => Promise<T>) => pool.begin((tx) => fn(async (t, p) => (await tx.unsafe(t, (p ?? []) as never[])) as never)) as Promise<T>
  const DEV: RequestIdentity = { profileId: P, userId: U, role: "DEV", email: "dev@example.com", name: "Dev Person" }
  const as = <T,>(call: () => Promise<T>) => runInDatabase(transact as never, DEV, true, {}, call)
  await as(() => api.brokers.create("App Broker"))
  await as(() => api.expenses.create({ ...blankExpense("BROKER", "2026-09-01"), entryType: "CHARGE", broker: "App Broker", description: "bill", amount: 5000, requestId: crypto.randomUUID() }))
  const appPay = (amount: number, k = crypto.randomUUID(), confirm = true) =>
    as(() => api.expenses.create({ ...blankExpense("BROKER", "2026-09-10"), entryType: "PAYMENT", broker: "App Broker", paidAmount: amount, paymentDate: "2026-09-10", requestId: k }, { confirmSameDay: confirm }))
  const a1 = await Promise.allSettled(Array.from({ length: 10 }, () => appPay(1000)))
  assert.equal(ok(a1), 5, "4a ten simultaneous 1,000 payments against 5,000 owed (confirmed): exactly five")
  for (const msg of reasons(a1)) assert.match(msg, /a payment can't be more than that/)
  assert.equal((await ledger(sql, "APP BROKER")).final, 0, "…nothing left owed, never negative")
  await as(() => api.expenses.create({ ...blankExpense("BROKER", "2026-09-01"), entryType: "CHARGE", broker: "App Broker", description: "bill 2", amount: 3000, requestId: crypto.randomUUID() }))
  const a2 = await Promise.allSettled([appPay(700, undefined, false), appPay(700, undefined, false)])
  assert.equal(ok(a2), 1, "4b two identical unconfirmed payments at once: one saved")
  assert.ok(a2.some((x) => x.status === "rejected" && x.reason instanceof PossibleDuplicateError), "…the other asks for confirmation, nothing written")
  const k = crypto.randomUUID()
  const a3 = await Promise.allSettled(Array.from({ length: 6 }, () => appPay(300, k)))
  const savedIds = new Set(a3.flatMap((x) => (x.status === "fulfilled" ? [x.value.id] : [])))
  const [{ rows }] = (await sql.unsafe(`select count(*)::int rows from expense.entries where request_id = '${k}'`)) as unknown as { rows: number }[]
  assert.deepEqual([ok(a3), savedIds.size, rows], [6, 1, 1], "4c one request id sent six times at once: one row, every call answered with it")
  // 4d the app locking a section-month while a bill is saved into it, at once (five months): one at a time — the bill is
  // saved before the lock, or refused after it; never saved into a locked month.
  let appLockFirst = 0
  for (const m of ["2025-01", "2025-02", "2025-03", "2025-04", "2025-05"]) {
    const [l, w] = await Promise.allSettled([as(() => api.expenseMonths.lock("BROKER", m)), as(() => api.expenses.create({ ...blankExpense("BROKER", `${m}-15`), entryType: "CHARGE", broker: "App Broker", description: `bill ${m}`, amount: 100, requestId: crypto.randomUUID() }))])
    assert.equal(l.status, "fulfilled", `4d ${m}: the lock is saved`)
    if (w.status === "rejected") { appLockFirst++; assert.match(String((w.reason as Error).message), /locked in Broker Charges/) }
    const [{ late }] = (await sql.unsafe(`select count(*)::int late from expense.entries e join audit.events c on c.record_id = e.id and c.action = 'CREATED'
      join audit.events lk on lk.record_id = (select id from expense.month_locks where section = 'BROKER' and month = '${m}') and lk.action = 'CREATED'
      where e.section = 'BROKER' and to_char(e.date, 'YYYY-MM') = '${m}' and c.at > lk.at`)) as unknown as { late: number }[]
    assert.equal(late, 0, `4d ${m}: no bill saved after the lock`)
  }
  await pool.end()
  await sql.end()

  const [{ v }] = (await postgres({ ...OPTS, database: "postgres", max: 1 }).unsafe("select current_setting('server_version') v")) as unknown as { v: string }[]
  console.log(JSON.stringify({ server: v, control_and_locked: results, load: { rounds: 40, committed, refused }, monthLocks, appMonthLock: { rounds: 5, lockFirst: appLockFirst } }, null, 1))
  console.log(`expense concurrency on PostgreSQL ${v}: all checks passed`)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
