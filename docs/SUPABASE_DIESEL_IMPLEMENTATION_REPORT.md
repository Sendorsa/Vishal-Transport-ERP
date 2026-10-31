# Supabase Diesel Database — Implementation Report

**Date:** 1 Nov 2026 (updated after the owner's approval of D-1 … D-18, and with the Production migration status, the same day)
**Scope:** Diesel Management only — Fuel Stations, Diesel, Diesel Tankers and AdBlue, station payments and TDS, plus the shared masters, month locks and audit trail they use.

**Companion documents:**
- `SUPABASE_DIESEL_DATABASE_SCHEMA.md`: the authoritative design (every table, constraint, the ER diagram, RLS, decisions).
- `SUPABASE_DIESEL_MIGRATION_PLAN.md`: rollout and rollback.
- `ERP_CODEBASE_AUDIT.md`: codebase audit and cleanup findings.

---

## 1. Overall status

| Stage | Status |
|---|---|
| **Designed** | Done. `SUPABASE_DIESEL_DATABASE_SCHEMA.md` |
| **Design approved** | **Yes, 1 Nov 2026:** all decisions D-1 … D-18, and keeping `finance.payment_categories` (§9) |
| **Implemented in files** | Done. 7 SQL files in `supabase/migrations/` (`20261101000000` … `20261101000600`), moved from `supabase/proposed/diesel/` after the approval (identical SHA-256 before and after the move). Since then only line 1 of each header comment has been updated; the SQL statements are unchanged |
| **Validated locally** | Done. `npm run check:supabase-diesel` runs every migration in `supabase/migrations/` in PGlite (PostgreSQL 18.6 in-process) and exercises the rules as Owner, Dev and Employee (§10) |
| **Executed against Supabase** | **The 8 migrations through `20261101000600` are applied** to the Production project `Vishal Transport erp` (`dqnoducqiootfvkzskhu`). The owner applied them after this report was first written; `npx supabase migration list --linked` confirmed it on 1 Nov 2026. **`20261101000700_accounts.sql` (accounts, written later) is pending and not applied**; it waits for the owner's go-ahead. There is no staging project (owner's decision). *(When this report was first written, nothing had been applied.)* |
| **Connected to the application** | **No, for business data:** the ERP still reads and writes only browser localStorage. The account-management pages (`/login`, Settings → User accounts) use Supabase Auth and need `20261101000700_accounts.sql`, which is not applied yet |
| **Data imported** | **None.** No localStorage, backup, Excel or demo data was read, copied or changed |

> **Applying a migration needs the owner's go-ahead for that step.** The 8 Diesel-phase migrations (through `20261101000600`) were applied to Production by the owner. Any later migration, starting with the pending `20261101000700_accounts.sql`, is first checked offline (`npm run check`) and with `npx supabase db push --dry-run --linked`. There is no staging project.

## 2. SQL files

All files are in `prototype/supabase/migrations/`, in filename order after the existing `20261028000000_erp_accounts.sql`. Their SQL is exactly as reviewed. On 1 Nov 2026, after the move, the out-of-date first header line ("PROPOSED — not applied anywhere", and in the roles file "before moving this file into supabase/migrations/") was replaced with "Diesel database, phase 1 — design approved by the owner on 1 Nov 2026 (D-1 … D-18)". Only comment lines changed: every non-comment line was checked identical to the approved originals.

| File | Creates |
|---|---|
| `20261101000000_erp_roles_three.sql` | Recreates `public.erp_role` as OWNER / DEV / EMPLOYEE. It refuses to run if any profile still holds ACCOUNTANT or OPS_MANAGER |
| `20261101000100_foundation.sql` | Extension `btree_gist` (in schema `extensions`); schemas `core`, `fuel`, `finance`, `audit`, `private`; the private helpers (below); `core.role_permissions`, seeded from the app's permission map |
| `20261101000200_core_master_data.sql` | Companies (VT, VTHPL), vehicle types, customers and their status periods, drivers, vehicles and their status periods, vehicle assignments, month locks |
| `20261101000300_fuel.sql` | Fuel stations (with the `dv_tanker` source row), tankers, diesel entries, tanker loads / transfers / adjustments, AdBlue purchases and entries, the two movement views, the stock locks and checks, entry guards |
| `20261101000400_finance_payments.sql` | Payment categories, payments, TDS rules, voucher numbering |
| `20261101000500_audit.sql` | `audit.events`, `audit.reviews`, append-only triggers, restore-once, the "no change without its audit event" check on every audited table |
| `20261101000600_rls_and_grants.sql` | Grants, and Row Level Security with policies on every table |

The private helpers in the foundation file are `new_id`, `today_ist`, `month_start`, `month_end`, `norm_reg`, `refuse_future_date`, `touch_updated_at`, `current_profile_id`, `erp_role`, `is_owner`, `is_owner_or_dev`, `can` and `module_resource`.

**Size:** 1,168 lines of SQL, plus the 259-line check `src/lib/supabase/diesel-schema.check.ts`.

## 3. Tables, views, indexes and policies

**22 new tables.** The existing `public.profiles` stays, so there are 23 in total.

| Schema | Tables |
|---|---|
| `core` (10) | `role_permissions`, `companies`, `vehicle_types`, `customers`, `customer_status_periods`, `drivers`, `vehicles`, `vehicle_status_periods`, `vehicle_assignments`, `month_locks` |
| `fuel` (8) | `fuel_stations`, `tankers`, `diesel_entries`, `tanker_loads`, `tanker_transfers`, `tanker_adjustments`, `adblue_purchases`, `adblue_entries` |
| `finance` (2) | `payment_categories`, `payments` |
| `audit` (2) | `events`, `reviews` |

**2 reporting views:**
- `fuel.tanker_movements`: every litre in or out of each tanker, in the app's event order.
- `fuel.adblue_stock_movements`: AdBlue bulk stock in and out; direct vendor purchases are excluded.

**Indexes:** 34 created explicitly (9 of them unique), in addition to the primary keys and unique constraints.

| File | Explicit indexes |
|---|---|
| core | 8 |
| fuel | 18 |
| finance | 3 |
| audit | 5 |

- **Exclusion constraints** (`btree_gist`) stop overlapping customer and vehicle status periods and vehicle assignments.
- **Uniqueness:** normalised vehicle registrations, customer codes, station names, tanker names and registrations are unique.

**RLS:** enabled on every new table, with 65 policies. The browser roles `anon` and `authenticated` start with no grants. Each table gets only the privileges its policies need:
- no DELETE on master tables;
- transfers and adjustments can only be inserted or deleted;
- the audit tables can only be inserted.

## 4. Security and permission design

- **Roles:** Owner, Dev, Employee only.
- **Permissions:**
  - `core.role_permissions` mirrors `MAP` in `src/lib/permissions.ts`. The check asserts that the table and `can()` agree for every role, module and action.
  - `private.can(resource, action)` is what the RLS policies call.
- **Owner-only actions** are tested by name with `private.is_owner()`, never through the shared permission check:
  - locking and unlocking a month;
  - writing in a locked month;
  - restoring a deletion;
  - reviewing a deletion.
- **Month lock:**
  - `private.month_open(date)`: every write by a role other than the Owner must fall in an open month.
  - The month changes at 00:00 IST (`private.today_ist()`).
  - An edit is checked against both the old date and the new date.
- **Identity** comes from the verified Supabase session (`auth.uid()` → `public.profiles`). The browser's role switcher is never trusted.
- **Write path (D-1, recommended):** Next.js server code opens one Postgres transaction per operation, runs as `authenticated` with verified claims, and reuses the existing `src/lib/api` and `src/domain` logic. The custom schemas stay unexposed in the Data API.
- **Secrets:**
  - `SUPABASE_SECRET_KEY` is a placeholder in `.env.local` and read by no code.
  - It must never be put in a `NEXT_PUBLIC_` variable.
  - `supabaseEnv()` refuses a secret key placed in the public variable.
  - The server-only connection string (`SUPABASE_DB_URL`) will be added only when D-1 is approved.

## 5. Diesel, tanker and AdBlue inventory logic

**Diesel entries** (`fuel.diesel_entries`):
- **A pump fill** names a real fuel station. **A tanker fill** names the `dv_tanker` source row and one tanker.
  - A composite foreign key `(station_id, from_tanker)` → `fuel_stations(id, is_tanker_source)` makes any other combination impossible.
  - A tanker fill is always CREDIT.
- **Amount** is generated by the database in NUMERIC: litres × rate, exact to the paisa.
- **Required fields:** `rate > 0` and an odometer (D-16).
- **No future dates** for diesel entries (D-18).
- **The vehicle's odometer cache** is updated by a trigger.

**Tanker stock is calculated, never stored:**
- Opening + opening stock + loads + transfers in ± adjustments − fills − transfers out.
- **Event order** matches `tankerMoves` in the app: by date; then loads and positive adjustments, transfers out, transfers in, and finally fills / negative adjustments; then creation time, then id.
- **Opening stock** is a load with no station: at most one per tanker. It can't be edited and is never a purchase.
- **Never below zero at any point in time:**
  - Each write first locks the affected tanker row (`FOR UPDATE`) in a BEFORE trigger.
  - At COMMIT, a deferred check recomputes the running balance for that tanker and refuses the transaction if it dips below zero on any date.
- **Each tanker's stock is its own.** A transfer moves litres between tankers and never counts as a purchase.

**AdBlue:**
- **Bulk purchases:** litres = buckets × litres per bucket and cost = buckets × price per bucket, both generated.
- **A stock draw** (`STOCK`) has no vendor, rate or payment mode. It is costed by the app at the weighted average, as today.
- **A direct vendor purchase** (`DIRECT`) carries vendor, rate and payment mode. Its amount is generated, and it never enters stock.
- **Stock check:** an advisory lock is taken when a write starts, and a deferred check at COMMIT keeps stock from ever going below zero. Purchases come before draws on the same day.
- **No AdBlue opening stock** (owner, 31 Oct 2026).

## 6. Station ledger and payment logic

- **The ledger stays calculated by the app** (`stationLedger`): Opening + Fuel Purchased − Payments Made = Closing.
  - The database stores what it needs: the station's opening balance and date, the loads and fills, and the payments.
- **Opening balance:** Owner / Dev only, and subject to the month lock on its date.
- **The tanker-source flag** (`is_tanker_source`) can't be changed.
- **Payments** (`finance.payments`):
  - A station payment can never point to `dv_tanker` (composite foreign key).
  - `for_month` can't be after the payment date's month.
  - No payment is dated in the future.
- **TDS:**
  - mode `TDS`, amount 0, `for_month` required;
  - dated the last day of the month;
  - at most one per station per month (a unique index).
- **Voucher numbers:** `{prefix}-PAY-{FY}-0001`, assigned by a trigger under a per-prefix advisory lock, the same format as `nextSeq` in the app.
- **Phase-1 rule:** `payments` accepts only fuel-station payments (`payments_phase1_fuel_station_only`), until other payment types get their own phase.

## 7. Audit and month-lock mechanisms

**The audit trail:**
- **Who writes events:** the app writes each event (label, before / after snapshot, changes, reason) in the same transaction as the change (D-8).
- **What the database guarantees:**
  - **Append-only:** UPDATE, DELETE and TRUNCATE on `audit.events` and `audit.reviews` are refused for every role.
  - **No change without its event:** a deferred check (`<table>_require_audit`) on 18 audited tables refuses a transaction that changed a row but wrote no matching event. A delete needs a DELETED event, and a DELETED event needs a reason of at least 3 characters.
  - **Restore once:** `restores_event_id` is unique, and must point to a DELETED event for the same record. Only the Owner can insert one.
  - **Reviews:** only of DELETED events, Owner only, append-only.
- **Who may insert which events:**
  - DATA_RESET can't be inserted through RLS.
  - DELETED needs the module's `delete` permission.
  - MONTH_LOCKED / MONTH_UNLOCKED are Owner only.

**Month locks:**
- `core.month_locks` holds the Owner's overrides (lock early / unlock for users). Owner only.
- Without an override, a month locks automatically when the next one starts in India time.

## 8. Future module expansion

- **New modules get their own schema or tables:** trips and invoices in `ops` / `finance`, and later consumables such as Engine Oil, Coolant and Charging.
- **They reuse the `core` masters and the same helpers:** `private.can`, `month_open`, `require_audit_event`, `new_id`.
- **A new module needs four things:**
  1. a resource in `RESOURCES` and a row in `core.role_permissions`;
  2. its tables, with RLS through `private.can`;
  3. a `<table>_require_audit` trigger;
  4. a mapping in `private.module_resource` for its audit module.
- **Master tables carry only Diesel's columns today (D-7).** Billing, compliance and HR columns are added by their module's migration.
- **`finance.payment_categories`** is the extension point for other payment types. The phase-1 constraint is dropped when they arrive.
- Details: schema document §11.

## 9. Decisions — approved

**All of D-1 … D-18 were approved by the owner on 1 Nov 2026**, as recommended below. Full text: schema document §12.

**These are design approvals, not authorisation to apply the migrations to Supabase.**

| # | Decision | Approved as |
|---|---|---|
| D-1 | Where writes run: (B) Next.js server, one Postgres transaction per operation, reusing `src/lib/api` + `src/domain`; or (A) PL/pgSQL functions | **B.** Needs a server-only DB connection string and a Postgres driver when implemented |
| D-2 | Recreate `erp_role` as OWNER / DEV / EMPLOYEE | Approve. No account exists yet |
| D-3 | Employee reads customers, vehicles, drivers and station payments through `diesel:view` | Approve as written |
| D-4 | Text ids in the app's shape (`dsl_…`, `dv_tanker`) instead of UUIDs | Keep text ids |
| D-5 | Uniqueness: customer code, vehicle registration, station name, tanker name and registration | Approve |
| D-6 | Keep `dv_tanker` as a `fuel_stations` row protected by composite foreign keys | Keep |
| D-7 | Master tables carry only what Diesel uses | Approve |
| D-8 | The app writes audit events; the database enforces presence, append-only and restore-once | Approve |
| D-9 | No Reset / Clear all data / Restore from file against the shared database | Approve; backups = point-in-time recovery + exports |
| D-10 | No data import; the owner enters masters and opening figures as of go-live | As instructed |
| D-11 | Customer logo stays a small data URL in a text column | Keep for now |
| D-12 | Precision: money (14,2), litres (12,3), rates (12,4), km (12,1); amounts generated in NUMERIC (may be 1 paisa above the browser's float on an exact half-paisa product) | Approve |
| D-13 | Supabase plan with point-in-time recovery before go-live | Pro + PITR |
| D-14 | Cache columns (vehicle status / customer / odometer, customer status) maintained in the same transaction | Keep |
| D-15 | No `tanker_dispenses` table (no new external dispenses since 31 Oct 2026; nothing imported) | Approve |
| D-16 | Stricter than imported history: tankers need a registration, fills need `rate > 0` and an odometer, no AdBlue opening stock | Approve |
| D-17 | SQL staged in `supabase/proposed/diesel/`; moved unchanged on approval | Approved. **Moved 1 Nov 2026** into `supabase/migrations/`, unchanged |
| D-18 | Diesel entries can't be dated in the future (database rule) | Approve |

**Rules kept in the API only** (deliberately not duplicated in SQL):
- archived-tanker refusal;
- diesel-only and not-own-tanker rules for tanker fills;
- the assignment check on new entries;
- AdBlue odometer order;
- the "no earlier records" rule for opening balance / opening stock.

**Also decided on 1 Nov 2026:**
- **Dropping ACCOUNTANT / OPS_MANAGER from `erp_role`** is approved as part of D-2 (migration `20261101000000_erp_roles_three.sql`).
- **`finance.payment_categories` is kept** as the future extension point for other payment types. It is **not** replaced by a CHECK constraint, even though it holds a single row (`DIESEL_SETTLEMENT`) today.

## 10. Verification results

Run from `prototype/`, one command at a time, on the code as it stands. The commands were run, and the exit codes observed, in this session.

| Command | Result | Exit code | Duration |
|---|---|---|---|
| `npm run check` (11 suites, incl. `check:supabase` and `check:supabase-diesel` on the active migrations) | All 11 suites passed | **0** | 78 s |
| `npm run typecheck` | Passed | **0** | 1 s |
| `npx eslint` | Passed, no warnings or errors | **0** | 5 s |
| `npm run build` | Passed: compiled, TypeScript finished, 30 routes built; fresh `.next/BUILD_ID` | **0** | 3 s |

Run 1 Nov 2026, finishing 01:23 IST, **after** the 7 files moved into `supabase/migrations/` and the two checks were updated.
- **Short durations:** the machine was idle and Turbopack / TypeScript reused their caches. The build still wrote a new `.next/BUILD_ID` (01:23:40).
- **The previous run** (00:41–01:01 IST, before the move) also passed all four with exit 0: check 104 s, typecheck 7 s, ESLint 229 s, build 827 s. That build was slowed by about 3,400 VS Code ripgrep processes and stuck macOS services (`tccd`, `automountd`), not by the project.
- **Also run on their own after the move:** `npm run check:supabase` and `npm run check:supabase-diesel`, both passing.

**What `check:supabase-diesel` covers:**
- All migrations apply cleanly.
- `role_permissions` equals `can()` for every role, module and action.
- RLS per role, including Employee refused money and deletes.
- Month locks for Dev and Employee, while the Owner can still write.
- The tanker-fill shape, and exact NUMERIC amounts.
- Per-tanker stock never below zero, including the same-day order of transfers.
- AdBlue stock never below zero; direct purchases kept out of stock.
- Opening stock and opening balance rules.
- Voucher numbering, and TDS: month-end date, one per station per month, amount 0.
- Audit presence at COMMIT, append-only, restore-once and reviews.

**Earlier history in this session:**
- **First production build: failed with TS6053.** It was run while `src/components/ui/scroll-area.tsx` was being deleted, so its type check looked for a file that was gone. That was a timing artefact, not a code error.
- **Full sequential run of 31 Oct – 1 Nov: all four passed with exit 0.**

| Command | Exit code | Duration |
|---|---|---|
| `npm run check` | 0 | 5,430 s |
| `npm run typecheck` | 0 | 2,951 s |
| `npx eslint` | 0 | 649 s |
| `npm run build` | 0 | 322 s, 30 routes |

- **Three background commands ended with exit code 144.** Each was stopped deliberately (`pkill` / `kill`), not a failure:
  - a slow unused-file scanner;
  - a hung `du` on `node_modules`;
  - an overlapping check run.

  No result was taken from them.

## 11. Known limitations and outstanding issues

1. **Concurrency is designed, not exercised.** PGlite is a single connection, so the row and advisory locks have not been tested under two simultaneous writers. Test on staging (step 4 below).
2. **PostgreSQL version.** Validated on PostgreSQL 18.6 (PGlite), which may differ from the Supabase project's version. Run `supabase db push --dry-run` on staging before applying.
3. **Stand-in auth.** The check uses a minimal `auth` schema and API roles, not Supabase's real ones.
4. **Not connected.** No Postgres repository, server transaction wrapper or sign-in (`proxy.ts`) exists yet. `database.types.ts` covers only the `public` schema (now with the three-role enum); the Diesel schemas aren't exposed through the Data API (D-1), and `supabase gen types` needs a linked project or a local Supabase stack, neither of which exists. Those come after approval (migration plan §4–5).
5. **Rules kept in the API only** (§9) are not enforced by the database. A bug in the server code could bypass them; the database's own guards still hold.
6. **1-paisa difference (D-12).** Amounts generated in NUMERIC can be 1 paisa above the browser's float result on an exact half-paisa product.
7. **No external dispense table (D-15)** and **stricter constraints (D-16):** imported browser history with stock pools, rate-less fills or AdBlue opening stock would not fit. No import is planned.
8. **Git.** The repository holds only the "Create Next App" starting commit; the ERP work, including these files, is uncommitted.

## 12. Next steps before applying to Supabase

**Done on 1 Nov 2026:**
- Owner approval of D-1 … D-18 and of keeping `finance.payment_categories`.
- The 7 files moved unchanged into `supabase/migrations/` (D-17).
- `check:supabase` and `check:supabase-diesel` validate the active migrations; `database.types.ts` has the three-role enum.

> **Superseded (1 Nov 2026): there is no staging project.** The owner decided to use the existing Production project directly. Each migration is checked offline and with `supabase db push --dry-run`, then applied with the owner's go-ahead. Accounts are pre-created by DEV and activated by Google sign-in only (`SUPABASE_SETUP.md` §6). The staging steps below are kept only as a record.

**Waiting for the owner's go-ahead:**
1. **Commit** the current work to git, so the migrations have a reviewable history.
2. ~~**Staging project first**, never production~~ (superseded):
   - create or pick a staging (or branch) project and link the CLI;
   - `npx supabase db push --dry-run`, then `db push`;
   - generate types (`supabase gen types`) into `database.types.ts`;
   - test the stock locks with two concurrent sessions.
3. **Phase 2 auth:** Google sign-in; the first DEV pre-created by `private.bootstrap_first_dev` (SQL editor), then DEV adds the other accounts (`SUPABASE_SETUP.md` §6).
4. **Adapter behind a switch** (`local` / `supabase`); every `npm run check` suite must pass on both backends.
5. **Production:** only after the offline acceptance suite shows the same figures as the browser (no staging trial). The owner enters masters and opening figures by hand; no data import.
