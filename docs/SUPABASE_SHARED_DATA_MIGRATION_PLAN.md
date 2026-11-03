# Shared Multi-User Data on Supabase — Full ERP Migration Plan

**Revision 3 — 3 Nov 2026: IMPLEMENTED IN CODE; PRODUCTION NOT YET DONE.** The owner authorised the full implementation the same day. What exists now:
- **Built and tested offline:** migrations `20261103000000` (OD-1 in the database), `20261103000100` (`erp_server` login), `20261103000200` (full ERP schema + openings); the server engine (`src/lib/server/erp/`), `POST /api/erp` and `GET /api/erp/changes`, the browser client (`src/lib/api/client.ts`), 20-second sync, optimistic concurrency, the openings and Assigned since, the role model (OD-1), and the Production scripts (`supabase/scripts/01…03`). `npm run check` (15 suites incl. `check:erp-db`), typecheck, ESLint and both builds pass.
- **Not done — blocked on credentials:** Gate G0, the Production backup / reset, applying the migrations, the `erp_server` password, Vercel env, and the two-device smoke test. This machine has no Supabase access token, database password or project URL. Exact steps: `SUPABASE_SETUP.md` §8.
- Revision 2 (below) remains the design; where the implementation differs it is noted in CLAUDE.md "Shared database".

**Goal:** every approved user sees the same business data on every account, browser and device, with Supabase PostgreSQL as the single source of truth.

**Builds on:**
- `SUPABASE_DIESEL_DATABASE_SCHEMA.md`: the Fuel Phase-1 design, D-1 … D-18;
- `SUPABASE_INTEGRATION_PLAN.md`: the server adapter, auth and roles, M-1 … M-5;
- `SUPABASE_DIESEL_MIGRATION_PLAN.md`.

Where this plan differs from them, this plan wins once approved.

## Owner decisions applied in this revision

| # | Decision | Where |
|---|---|---|
| OD-1 | DEV inherits every OWNER business permission, including month locking, locked-month edits, deletion review and Restore / Push Back. DEV alone has account and system administration. | §9.1 |
| OD-2 | A clean go-live baseline, with **no automatic historical imports**. | §9.2, §17 |
| OD-3 | Explicit opening-balance support for **AdBlue stock**, **unpaid customer invoices** and **vehicle opening odometers**. | §9.3 – §9.5 |
| OD-4 | An **"Assigned since"** date when creating a vehicle or assigning it for the first time. | §9.6 |
| OD-5 | **20-second polling** for cross-device sync. | §9.7 |
| OD-6 | **Optimistic concurrency checks:** no silent last-write-wins. | §9.8 |
| OD-7 | Resolve, with evidence, the conflict between an earlier SQL search that found **no fuel / pump / station tables** and the claim of **22 Production tables**. | §1 (**Gate G0**) |

**Conflicts with CLAUDE.md created by these decisions.** The owner's later instructions stand. CLAUDE.md and the pinning checks are updated **in the implementation step**, not now:
- **OD-1** reverses:
  - "Owner-only, refused to Dev";
  - "Dev sees the log read-only";
  - "never add `"*"` to another role";
  - and in "Monthly Sheet Lock", Dev following the lock.
- **OD-3 (AdBlue)** reverses "No manual opening stock (owner, 31 Oct 2026) … don't reintroduce it". `npm run check:fresh-start` currently asserts that it's absent.
- **OD-3 (odometer)** extends the KM Run definition: the first fill can measure from an opening reading.

---

## 0. Summary

| Area | State (3 Nov 2026) |
|---|---|
| Business data | **100% browser localStorage**, per browser and per device (verified). |
| Auth | Google sign-in, the gate, the account role and Settings → User accounts are built in code (verified). Whether `20261101000700_accounts.sql` is applied is **unverified**. |
| Supabase business schema | **UNVERIFIED — conflicting evidence (§1).** Earlier documents report 8 migrations and 22 tables in Production. An earlier SQL search reportedly found no fuel tables. **No live catalog output was ever recorded in the repository.** Gate G0 must close before any database work. |
| What the full ERP still needs | Trips, invoices (incl. opening invoices), receipts and expenses, settings, master columns, the openings (AdBlue, invoices, odometer, assigned-since), the concurrency token, and the server data path. |
| Must fix before any server execution | F-2 (the server-side Owner fallback), F-3 (audit actor without a user). |

---

## 1. Gate G0 — Production schema state (OD-7)

### 1.1 The two claims, and what each rests on

| Claim | Source | Is it evidence of the live database? |
|---|---|---|
| "8 migrations applied; 22 custom-schema tables with RLS" | `SUPABASE_INTEGRATION_PLAN.md` ("as reported by the owner"); `SUPABASE_DIESEL_DATABASE_SCHEMA.md` and `SUPABASE_DIESEL_MIGRATION_PLAN.md` ("`npx supabase migration list --linked` confirmed it on 1 Nov 2026"); `SUPABASE_SETUP.md` §7; CLAUDE.md | **Second-hand.** No command output, catalog dump or screenshot is stored anywhere in the repository. **"22" is exactly the number of tables the migration files create:** `core` 10 (incl. `role_permissions`), `fuel` 8, `finance` 2, `audit` 2. So it may have been counted from the files, not from the database. |
| "An SQL table search found no fuel / pump / station tables" | The owner's report. There's no record of the query, which project it ran on, or which role ran it. | **Second-hand.** The query text is needed to judge it. |

**A correction to Revision 1:** its summary said the schema was "applied to Production". That repeated the earlier documents; I didn't verify it. It's withdrawn until G0 closes.

**Verified locally (read-only):**
- The Supabase CLI on this machine is linked to project `dqnoducqiootfvkzskhu`, "Vishal Transport erp", PostgreSQL 17.11 (`prototype/supabase/.temp/`, written 1 Nov 02:07).
- The app's `prototype/.env.local` has an **empty** `NEXT_PUBLIC_SUPABASE_URL`. Which project Vercel points at isn't recorded in the repository.

### 1.2 Hypotheses (several could be true at once)

| # | Hypothesis | Fits "no tables" + "22 tables"? | Local evidence for or against |
|---|---|---|---|
| H1 | **The search looked only at `public`.** The Table Editor, the SQL snippets most people use (`information_schema.tables where table_schema = 'public'`) and `supabase gen types` all default to `public`. Every business table is in `core` / `fuel` / `finance` / `audit`; `public` holds only `profiles`. | Yes: tables exist, the search couldn't see them | Design fact (verified in the migration files). Strong candidate |
| H2 | **The search matched names that don't exist.** No table is called `pump*` (it's `fuel.fuel_stations`); `station` matches only `fuel_stations`; `fuel` matches the schema name, which a `table_name` filter ignores. | Partly | Verified in the files |
| H3 | **A privilege-filtered catalog.** `information_schema.tables` lists only tables the **querying role** has some privilege on. Run through the Data API / an MCP tool as `anon` (no grants) or `authenticated` (no `USAGE` on schemas outside `public` in some setups), it would show none. `pg_class` would. | Yes | Depends on how the search was run (unknown) |
| H4 | **Recorded but not executed.** `SUPABASE_SETUP.md` §B tells SQL-editor users to run `supabase migration repair --status applied <version>`. That **marks a version as applied without running it**, so `migration list` reports it as remote while the tables don't exist. | Yes: both reports honest, and the tables missing | Plausible, given the documented procedure |
| H5 | **A different project or a different moment.** The search ran on another project in the organisation, a local `supabase start`, or before the 1 Nov push. | Yes | `.env.local` empty; Vercel target unknown |
| H6 | **A partial apply.** The SQL editor ran some files or part of a file. | Yes, if the search used one of the missing names | Unknown |

### 1.3 How to settle it (read-only, by the owner, in the dashboard SQL editor)

**Before running:** confirm the browser URL shows project **`dqnoducqiootfvkzskhu`**. Note that the SQL editor runs as `postgres`, so H3 doesn't apply to these queries.

**Query 1 — what physically exists** (`pg_catalog` only; works whatever was applied; changes nothing):

```sql
select json_build_object(
  'database', current_database(),
  'run_as', current_user,
  'server_version', current_setting('server_version'),
  'erp_schemas', (select json_agg(nspname order by nspname) from pg_namespace
                  where nspname in ('core', 'fuel', 'finance', 'audit', 'private')),
  'tables', (select json_agg(n.nspname || '.' || c.relname order by n.nspname, c.relname)
             from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where c.relkind in ('r', 'p') and n.nspname in ('public', 'core', 'fuel', 'finance', 'audit')),
  'rls_off', (select json_agg(n.nspname || '.' || c.relname)
              from pg_class c join pg_namespace n on n.oid = c.relnamespace
              where c.relkind = 'r' and not c.relrowsecurity and n.nspname in ('core', 'fuel', 'finance', 'audit')),
  'fuel_like_names_anywhere', (select json_agg(n.nspname || '.' || c.relname order by 1)
             from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where c.relkind in ('r', 'p', 'v') and c.relname ~* '(fuel|pump|station|tanker|diesel|adblue)'
               and n.nspname not in ('pg_catalog', 'information_schema')),
  'approx_rows', (select json_agg(schemaname || '.' || relname || '=' || n_live_tup order by schemaname, relname)
             from pg_stat_user_tables where schemaname in ('core', 'fuel', 'finance', 'audit', 'public')),
  'migrations_table_exists', to_regclass('supabase_migrations.schema_migrations') is not null
) as g0;
```

**Query 2 — what the CLI has recorded** (only if `migrations_table_exists` is true):

```sql
select version, name from supabase_migrations.schema_migrations order by version;
```

**Also, when convenient:** the exact text of the earlier "no tables" search, and where it ran (SQL editor, Table Editor, an AI assistant, an MCP tool, the CLI).

### 1.4 Reading the result

| Result | Means | Plan consequence |
|---|---|---|
| **A.** 5 ERP schemas, 22 tables (+ `public.profiles`), RLS on all, versions recorded | The schema exists. The earlier search was filtered (H1 / H2 / H3) | Proceed. Commit the JSON as evidence (`docs/evidence/G0-catalog-<date>.json`, no secrets in it) |
| **B.** Versions recorded, schemas / tables missing | H4: recorded, never executed | **Never `db push` as-is**: the CLI would skip them. With the owner's go-ahead: `migration repair --status reverted` for the unexecuted versions, then dry-run, then push. The schema is empty, so nothing is lost |
| **C.** No ERP schemas and nothing recorded | Never applied here (or H5) | Find the right project (Vercel env). Then apply `…000000` … `…000600` unchanged (dry-run first), before any new migration |
| **D.** Some schemas or tables present | H6: partial apply | **Stop.** Compare object by object with the PGlite catalog (integration plan Appendix A). The owner decides: forward-fix migration, or PITR / a fresh project |
| **E.** The tables are in another project | H5 | Align the CLI link, Vercel env and `SUPABASE_SETUP.md` to one project before anything else |

**Gate G0 rule:**
- **Until one of A – E is recorded with its query output, nothing runs against Supabase:** no new migration, no `db push`, no adapter test against Production.
- **The documents claiming "applied"** (CLAUDE.md, the schema / migration / integration plans, `SUPABASE_SETUP.md`) are corrected to match the evidence in the implementation step.

---

## 2. Current storage architecture (verified)

```
components → src/lib/api/hooks.ts (TanStack Query, per-collection keys)
          → src/lib/api/index.ts  (`api.*`: permissions, month lock, validation, audit — 1,655 lines)
          → src/lib/api/repository.ts (createLocalRepository: list/get/create/update/remove)
          → src/lib/storage/local-store.ts (the ONLY file that touches window.localStorage)
```

**`api/index.ts` today:**
- 108 `readCollection` calls, all synchronous;
- 4 `writeCollection`;
- 61 `tx(` (one write at a time per tab, every key rolled back on error);
- 48 `audit({`, 42 `assertCan`, 38 `assertMonthEditable`;
- 15 `currentRole()`, 16 `ensureSeeded()`.

**How the data is stored:**
- **Encoding:** one key per collection, `vt:<name>`, column-encoded and cached in memory.
- **Settings:** one JSON object in `vt:settings`, with vehicle types in `vt:vehicleTypes`.
- **Audit:** `vt:auditEvents` and `vt:auditReviews`, append-only, kept through resets.
- **Format:** `vt:meta` holds the format version and source.
- **Refresh:** the cross-tab refresh is the browser `storage` event. **Nothing refreshes across devices.** Queries use `staleTime: 60_000` and `refetchOnWindowFocus: false`.

**Calculated, never stored:** ledgers, stock, valuations, carry-forward, KPIs, KM Run, cash-at-pump rows, invoice status, reports.

## 3. Collection inventory (verified in `types.ts`, `local-store.ts`, `api/index.ts`)

| localStorage key | Type | Written by | In the designed Phase-1 schema | Target (this plan) |
|---|---|---|---|---|
| `vt:customers` | `Customer` (+ `statusHistory`) | `customers.*` | `core.customers` (Diesel columns only) + `customer_status_periods` | B-1: billing columns; `customer_pricing`, `customer_route_rates` |
| `vt:vehicles` | `Vehicle` (+ `statusHistory`) | `vehicles.*`; odometer cache from `diesel.create`, `audit.restoreDeleted` | `core.vehicles` (no compliance columns) + `vehicle_status_periods` | B-1: compliance columns; **B-7: opening odometer (OD-3)** |
| `vt:drivers` | `Driver` | `drivers.*` | `core.drivers` (no licence) | B-1: licence columns |
| `vt:vehicleAssignments` | `VehicleAssignment` | `vehicles.create / transfer / update` | `core.vehicle_assignments` (GiST no-overlap) | as is; **assigned-since (OD-4) is app logic** |
| `vt:monthLocks` | `MonthLock` | `monthLocks.set` | `core.month_locks` | M-5 (OD-1) |
| `vt:fuelStations` | `FuelStation` (+ `dv_tanker`, opening balance) | `fuelStations.*` | `fuel.fuel_stations` | as is |
| `vt:fuelEntries` | `DieselEntry`: **diesel, petrol and EV fills** (the fuel type lives on the vehicle; kWh in `litres`) | `diesel.*` | `fuel.diesel_entries` | as is. There's no separate petrol collection |
| `vt:adBlueEntries` | `AdBlueEntry` (STOCK / DIRECT) | `adblue.*` | `fuel.adblue_entries` | as is |
| `vt:adBluePurchases` | `AdBluePurchase` (+ legacy `opening`) | `adbluePurchases.*` | `fuel.adblue_purchases` (no `opening`, D-16) | **B-7: `opening` (OD-3)** |
| `vt:tankers` | `Tanker` | `tankers.*` | `fuel.tankers` | as is |
| `vt:tankerLoads` | `TankerLoad` (+ `opening`) | `tankerLoads.*` | `fuel.tanker_loads` | as is |
| `vt:tankerTransfers`, `vt:tankerAdjustments` | | `tankerTransfers.*`, `tankerAdjustments.*` | `fuel.*` | as is |
| `vt:tankerDispenses` | `TankerDispense` (history only) | `tankerDispenses.*` | none (D-15) | none; the adapter returns `[]` |
| `vt:payments` | `Payment`: station payments, TDS, receipts with `allocations`, expense vouchers, vehicle maintenance | `payments.*`, `fuelStationPayments.*` | `finance.payments`, **station-only check** | B-4: drop the check; `customer_id`, `vehicle_id`, `payment_allocations` |
| `vt:trips` | `Trip` | `trips.*`; `invoices.create / cancel` | — | B-2: `ops.trips` |
| `vt:invoices` | `Invoice` (`lines[].tripIds[]`) | `invoices.*` | — | B-3: `billing.*`; **opening invoices (OD-3)** |
| `vt:settings` | `Settings` (companies, expense categories, tax, TDS, SAC) | `settings.update` | `core.companies` (partial), `finance.payment_categories` (1 row) | B-5 |
| `vt:vehicleTypes` | `VehicleType[]` | `settings.update` | `core.vehicle_types` (no `default_seats`) | B-1 |
| `vt:auditEvents`, `vt:auditReviews` | | `audit()`, `audit.markReviewed` | `audit.events`, `audit.reviews` | as is. **Browser history is never copied (OD-2)** |
| `vt:meta`, `vt:ui:role / company / dieselMonth` | meta, UI preferences | | — | stay in the browser |

**Not storage:** reports and the dashboard (calculated); companies (inside settings); "vouchers" (`Payment` rows).

## 4. API inventory (every read and write; all writes run in `tx` with an audit event)

| Namespace | Reads | Writes (permission) | Business checks |
|---|---|---|---|
| `customers` | list, get | create, update, archive, restore | status history appended |
| `vehicles` | list, get | create, update, transfer, archive, restore | transfer: no future date, month lock, append-only periods |
| `assignments` | list | — | — |
| `drivers` | list, get | create, update, archive, restore (`settings:edit` or `vehicles:edit`) | — |
| `fuelStations` | list, get | create, update, archive, restore, **setOpeningBalance** (Owner / Dev) | opening refused when earlier records exist |
| `fuelStationPayments` | list | create, update, remove, **recordTds** | no future date; paid-against ≤ payment month; one TDS per station per month |
| `monthLocks` | list | set (**Owner by name**) | — |
| `diesel` | list (customer resolved, tanker fills valued) | create, update, remove | month lock; archived; assigned customer; pump vs tanker rules; stock ≥ 0 |
| `adblue` | list (weighted average) | create, update, remove | odometer between neighbours; stock ≥ 0 |
| `adbluePurchases` | list | create, update, remove | stock ≥ 0 |
| `tankerLoads` | list | create, update, remove, **createOpening** (Owner / Dev) | one opening per tanker; no earlier records; stock ≥ 0 |
| `tankerDispenses` | list | create, update, remove | stock ≥ 0 |
| `tankers` | list, get | create, update, archive, restore | unique registration and name |
| `tankerTransfers`, `tankerAdjustments` | list | create, remove | stock ≥ 0; reason |
| `trips` | list, get | create, update, remove | month lock; archived; assigned customer; priced; invoiced trips locked; numbering |
| `invoices` | list, get | create, issue, cancel | trips not already invoiced; totals; numbering; cancel refused with receipts |
| `payments` | list, get | create, remove | allocations ≤ outstanding + ₹0.50; numbering |
| `settings` | get | update | one "Settings" event |
| `admin` | exportBackup | restoreBackup, resetDemoData, clearAllData | **not offered against the shared database** (D-9) |
| `audit` | list, history, editedIds, unreviewedDeletions, checkRestore | markReviewed, restoreDeleted (**Owner by name**) | restore once; duplicate, stock, lock, number checks |

## 5. Calculations that depend on stored data

All are pure `src/domain` functions and run unchanged in database mode; † = also used by the API for validation.

| Figure | Functions | Inputs | Touched by this revision? |
|---|---|---|---|
| Station ledger, carry-forward, cash at pump, TDS | `stationLedger`, `openingOf`, `stationPaymentHistory`, `tdsDue`, `isStationPayment` † | stations, fills, loads, payments | no |
| Tanker stock and cost | `valueTankers` †, `tankerLedger`, `tankerPeriod`, `fillAmount` †, `loadsAsStationPurchases` | tanker records | no |
| AdBlue stock and cost | `valueInventory` †, `inventoryLedger`, `purchasedIn`, `vendorAnalytics`, `stockDraws` † | purchases, entries | **no code change:** they already handle `opening` (OD-3) |
| Diesel KM Run, KPIs, masters | `buildDieselIndex`, `fillRow`, `statsOf`, `buildMaster` | fills, vehicles, assignments | **yes: opening odometer seeds the previous reading (OD-3)** |
| AdBlue KM Run | `withRuns` | AdBlue entries | **yes, if RD-3 adds the AdBlue opening reading** |
| Customer on the entry date | `resolveCustomers` †, `assignmentOn` † | assignments | no (OD-4 only changes period start dates) |
| Historical status, month lock | `statusOn` †, `canEditMonth` † | periods, locks | **`canEditMonth`: OWNER or DEV (OD-1)** |
| Trip revenue, invoice totals | `calculateTripRevenue` †, `buildInvoice` † | pricing, trips, settings | no |
| Receivables, invoice status, aging, P&L, cash flow | `domain/analytics.ts` | everything | **opening invoices flow into receivables and aging automatically.** Revenue / P&L come from **trips** (`revenueInRange`, `profitAndLoss`), so they're unaffected |

## 6. Audit and permission enforcement today (verified)

- **Permissions:** `src/lib/permissions.ts`: OWNER `*`; DEV `FULL_ACCESS` (every resource, no Owner-only controls).
- **Owner-only checks by name:**
  - in the app: `monthLocks.set` (and `changedBy: "OWNER"`), `planRestore` / `restoreDeleted`, `unreviewedDeletions`, `markReviewed`, `canEditMonth`, the audit-log page and the sidebar badge;
  - in the designed database: `private.is_owner()` in `month_open`, the month-lock policies and the audit / review policies (`…000600`, re-created in `…000700`).
- **Audit:**
  - the app builds each event inside `tx`;
  - the designed database adds the deferred `require_audit_event`, append-only triggers for every role, and restore-once.
- **F-2:** `currentRole()` returns `"OWNER"` when there's no `window` (`src/lib/app-state.ts:77`).
- **F-3:** `currentActor()` records `userId` / `name` = null even when signed in.

## 7. Dependencies between modules

```
companies ─┬─ customers ─┬─ status periods ─ customer_pricing / route_rates
           │             └─ vehicle_assignments (assigned since — OD-4) ─┐
           ├─ vehicles (opening odometer — OD-3) ─ status periods        │
           │   └─ tankers                                                │ every dated entry resolves its customer here
           └─ drivers                                                    │
fuel_stations ─┬─ diesel_entries ◄──────────────────────────────────────┘ ── tankers (tanker fills)
               ├─ tanker_loads ─ tankers ─ transfers / adjustments
               └─ payments (station, TDS)
adblue_purchases (+ opening stock — OD-3) ─ adblue_entries
trips ─ invoice_line_trips ─ invoice_lines ─ invoices (+ opening invoices — OD-3) ─ payment_allocations ─ payments (receipts)
month_locks → every dated write;  audit.events → every write (and the sync cursor, OD-5)
```

**All modules share the customers and vehicles, so they switch backends together.** A module not yet in the database is hidden in database mode.

## 8. Findings (status after this revision)

| # | Finding | Resolution |
|---|---|---|
| F-1 | Role model conflict (code / designed database / CLAUDE.md vs. the owner's decision) | **Decided: OD-1** (§9.1) |
| F-2 | Server-side Owner fallback | Context-or-throw (§13) |
| F-3 | Audit actor without a user | Filled from the verified profile (§13) |
| F-4 | Non-fuel schema missing | B-1 … B-6 (§10) |
| F-5 | 108 synchronous reads | Unit of work (§13) |
| F-6 | No cross-device refresh | **OD-5** (§9.7) |
| F-7 | Last write wins | **OD-6** (§9.8) |
| F-8 | Opening positions not enterable | **OD-3** (§9.3 – §9.5) |
| F-9 | Assignment and status history start "today" | **OD-4** (§9.6) |
| F-10 | Entries typed into browsers since 1 Nov | **OD-2:** kept recoverable, never imported automatically; manual re-entry only (§9.2) |
| F-11 | Settings audit record id `settings` | B-5 keys the settings tables to it |
| F-12 | Database stricter than the app (unique code / registration) | Error mapping (§13) |
| F-13 | `…000700` re-creates the audit policy with `is_owner()` | M-5 re-creates it again |
| **F-14** | **Production schema state unverified** | **Gate G0 (§1)** |

---

## 9. Approved decisions — design and implications

Each decision lists the app changes, database changes, tests and rollback. The SQL is written only after this plan is approved and G0 is closed.

### 9.1 OD-1 — DEV inherits every OWNER business permission; DEV-only administration

**Role model:**

| Capability | DEV | OWNER | EMPLOYEE |
|---|:-:|:-:|:-:|
| Every business module: view, create, edit, delete (with reason) | ✓ | ✓ | as today's `MAP` (no change) |
| **Owner-level controls:** month lock / unlock; editing a locked month; deletion badge and review; Restore / Push Back; opening balances / stock / invoices / odometers | ✓ | ✓ | ✗ |
| Full Audit Log | ✓ | ✓ | ✗ |
| **Accounts and system administration** (add / role / deactivate / recovery; permission definitions; backend; DEV export) | ✓ | ✗ | ✗ |
| Change audit history; reset / clear / restore the shared database | ✗ | ✗ | ✗ |

**App changes:**
1. **`permissions.ts`:**
   - `DEV_ONLY = ["accounts", "system"]` (new resources);
   - `MAP`: **DEV `["*"]`**, **OWNER = every resource except `DEV_ONLY`** (`OWNER_ONLY` is retired);
   - `can()` refuses a `DEV_ONLY` resource to every role except DEV, whatever the map says.
2. **`hasOwnerAuthority(role)` = OWNER or DEV,** by name. It replaces every `currentRole() === "OWNER"`:
   - `monthLocks.set` (**`changedBy` = the actual role, never hard-coded `"OWNER"`**);
   - `planRestore` and `restoreDeleted`;
   - `unreviewedDeletions` and `markReviewed`;
   - `canEditMonth` (`domain/month-lock.ts`);
   - `features/audit/audit-log.tsx` and the sidebar badge (`app-sidebar.tsx`).
3. **Account functions keep `role === "DEV"` by name.** They're already DEV-only in `src/app/settings/users/actions.ts` and `…000700`. OWNER keeps no account administration.
4. **Navigation (`showInNav`):** OWNER sees every business module that is live in the current backend, plus the Audit Log. DEV sees everything.
5. **Attribution stays truthful:** a DEV month lock or restore is recorded as DEV (`actor_role`, `changed_by_role`).

**Database (M-5, a new migration):**
- `create or replace` `private.month_open` using `is_owner_or_dev()`;
- re-create "Owner locks / unlocks months" with `is_owner_or_dev()` and `changed_by_role = private.erp_role()`;
- re-create "Write own audit events" (**the `…000700` version**) so RESTORED and MONTH_LOCKED / UNLOCKED need `is_owner_or_dev()`;
- re-create "Owner reviews deletions" for OWNER or DEV with `actor_role = private.erp_role()`;
- `core.role_permissions`: DEV `*`; OWNER one row per business resource (no `accounts` / `system`).

**Tests:**
- `check:roles` re-pinned: DEV does every Owner-level action in the API; OWNER is refused accounts and system; EMPLOYEE is unchanged.
- `check:supabase-diesel`: `role_permissions` = `can()` for every role × resource × action, `can("OWNER", DEV_ONLY)` = false, and DEV passes `month_open` on a locked month.
- Update `month.check`, `restore.check`, `audit.check` and `actions.check` expectations ("Dev refused" → "Dev allowed").

**Rollback:**
- the app: revert the commit;
- the database: a new migration restoring the `is_owner()` versions (never edit M-5);
- **M-5 and the app change ship together:** neither is deployed alone.

### 9.2 OD-2 — Clean go-live baseline, no automatic historical imports

- **Baseline date B:** one date chosen by the owner (RD-1). Every opening record (§9.3 – §9.5, station opening balances, tanker opening stock) is dated **B**.
- **No import path is built:**
  - no Excel import into Supabase;
  - no localStorage-to-database copy;
  - no demo data;
  - the `import:*` scripts stay browser-only tools.
  - `admin.restoreBackup` / `resetDemoData` / `clearAllData` are refused for every role in database mode (D-9).
- **Existing browser data stays recoverable:**
  - before cut-off, every user exports a JSON backup from every browser they used;
  - localStorage is never cleared or modified by the switch;
  - the local backend keeps reading it (rollback, §18).
- **Transactions dated between B and go-live:** typed in by hand through the normal screens (audited, validated), or not at all. **No bulk tool.**

**Tests:**
- `check:clean-start` gains a database-mode case: a fresh database plus the reference rows only (companies VT / VTHPL, `dv_tanker`, `DIESEL_SETTLEMENT`, default expense categories) and nothing else;
- the admin reset / restore methods are refused in database mode for DEV, OWNER and EMPLOYEE.

**Rollback:** see §18. Browser data is untouched, so the local backend works as before.

### 9.3 OD-3a — AdBlue opening stock

**Reuses the existing record shape.** `AdBluePurchase.opening = true` is already reported correctly by the domain: it shows as Opening stock and is never "AdBlue Purchased", Average Purchase Rate, Vendors or Litres Purchased (`purchasedIn`, `vendorAnalytics`, `inventoryLedger.openingStock`). It enters stock and the weighted average (`valueInventory`). **No calculation code changes.**

**App:**
- `api.adbluePurchases.createOpening({ date, litres, value, notes })`, Owner-level (OD-1). Stored as `{ opening: true, vendorName: "", product: "Opening stock", buckets: 1, litresPerBucket: litres, pricePerBucket: value }`.
- **Rules (mirroring tanker `createOpening`):**
  - one opening in the workspace;
  - litres > 0;
  - **value > 0 required** (RD-2): with ₹0, the opening litres would dilute the average and draws would be under-costed;
  - not in the future;
  - month lock on the date;
  - **refused if any AdBlue purchase or STOCK entry is dated before it.**
- Not editable (the existing `update` already refuses `opening`). Delete with a reason and record it again. Restore keeps its one-opening check.
- **UI:** AdBlue → ⋮ → Record Opening Stock (Owner / DEV only).

**Database (B-7):** on `fuel.adblue_purchases`:
- `opening boolean not null default false`;
- the vendor check becomes `opening or btrim(vendor_name) <> ''`;
- a unique partial index allows one opening;
- the insert policy requires `opening ⇒ is_owner_or_dev()`;
- a trigger refuses UPDATE of an opening row.

The stock-movement view already counts every purchase as +.

**Tests (`check:fresh-start` inverted, plus `check:supabase-erp`):**
- Owner and DEV can record it; Employee is refused;
- a second one is refused;
- it's refused after an earlier AdBlue record;
- it isn't in AdBlue Purchased, Litres Purchased, Vendors or Average Purchase Rate;
- it is in Current Stock, Inventory Value and the weighted average;
- carry-forward is correct;
- a draw exceeding it is refused.

**Rollback:** delete the opening with a reason (audited); the column stays harmless.

### 9.4 OD-3b — Unpaid customer invoices at go-live ("opening invoices")

**Design: the outstanding invoices are entered as invoices.** The alternative, a customer balance field, wouldn't work with receipts, which allocate to invoices, nor with aging.

`Invoice.opening = true`:
- `lines: []`;
- `subtotal = total = outstanding amount at B`;
- taxes 0 (the tax was accounted in the old books);
- status `ISSUED`;
- the **original invoice number, invoice date and due date** (so aging is right).

**App:**
- `api.invoices.createOpening({ customerId, companyCode, invoiceNo, date, dueDate, outstanding, notes })`, Owner-level.
- **Rules:**
  - outstanding > 0;
  - date ≤ B, and never in the future;
  - invoice number unique;
  - customer exists (an archived customer is allowed: old debts).
- **Behaviour:**
  - receipts allocate to it like any invoice (existing rules);
  - cancel follows the existing rule (refused once receipts are allocated);
  - it isn't editable; cancel it and re-enter.
- **Effects:** receivables, aging and invoice status include it automatically. **Revenue and P&L don't** (they come from trips). Cash flow counts the receipts when they're received.
- **Numbering:** `nextSeq` continues after the highest number with the same prefix, so new invoices in the same FY never reuse an old number.
- **UI:** Customers → customer → Opening invoices → Add, and an "Opening" badge in the Invoices list.

**Database (B-3 + B-7):**
- `billing.invoices.opening boolean not null default false`;
- check: `opening ⇒ cgst = sgst = igst = 0 and subtotal = total and total > 0`;
- a deferred check: an opening invoice has no lines;
- the insert policy requires `opening ⇒ is_owner_or_dev()`;
- no UPDATE except status → CANCELLED.

**Tests:**
- receivables and aging include it;
- revenue / P&L don't change;
- a receipt allocates and settles it;
- over-allocation is refused;
- cancel is refused with receipts;
- a duplicate number is refused;
- Employee is refused;
- the next new invoice number continues the sequence.

**Rollback:** cancel the opening invoice (audited). Receipts against it must be deleted first (existing rule).

### 9.5 OD-3c — Vehicle opening odometer

**Meaning:**
- the odometer **at the vehicle's last diesel fill before B** (`openingOdometerKm`), and that fill's date (`openingOdometerDate` ≤ B);
- **not** today's reading.

KM Run pairs this fill's litres with the km since the previous fill, so the opening must be the previous fill's reading. Otherwise the first KM/L after go-live is biased.

**App:**
- `Vehicle.openingOdometerKm: number | null` and `openingOdometerDate: string | null`. They're set on Add Vehicle and from Vehicle → ⋮ → Opening odometer (Owner-level, month lock on the date, audited as a vehicle UPDATED).
- **Domain:** `buildDieselIndex` starts each vehicle's `last` at the opening reading for fills dated ≥ the opening date. It's not a fill: no litres, no entry count, no spend.
- **Refused** when the vehicle has a fill dated before the opening date (the reading would be ignored, as with the station opening balance).
- The `odometerKm` cache starts at the opening reading.
- **No new validation of later odometers:** today's behaviour stays (a negative KM is shown as an error and counted as 0).

**Database (B-7):** `core.vehicles`:
- `opening_odometer_km numeric(12,1) ≥ 0 null` and `opening_odometer_date date null`, both-or-neither;
- a guard trigger: Owner / DEV only, `month_open` on the old and new date.

**Tests (`check:diesel`):**
- the first fill after go-live gets KM Run = its odometer − the opening;
- no opening → null (as today);
- the opening doesn't change litres, spend or entry counts;
- refused with earlier fills;
- monthly / quarterly / yearly totals still reconcile.

**Rollback:** clear the opening (audited). KM Run reverts to "no previous fill".

**Open (RD-3):** the same for AdBlue (odometer at the last AdBlue top-up before B, seeding `withRuns`). Recommended: yes, same mechanism, two more nullable columns.

### 9.6 OD-4 — "Assigned since"

**App:**
- **`vehicles.create` takes `assignedSince`** (default today, required when a customer is chosen). The first assignment period starts there. The vehicle's status period starts at `min(assignedSince, today)`, so month views before the creation day show it ACTIVE.
- **First assignment of an unassigned vehicle** (no stored assignment yet): `vehicles.transfer` accepts a back-dated `assignedSince`.
- **Rules (both):**
  - not in the future;
  - month lock on the date (locked months: Owner / DEV);
  - the customer isn't archived on that date;
  - **refused if it would move an existing diesel, AdBlue or trip entry to a different customer.** History doesn't change silently; the message names the entry.
- **Later transfers** keep today's rule: effective date after the current period's start.
- **UI:** Add Vehicle and the first Transfer show "Assigned since". Customer → Vehicles already shows "Assigned since …".

**Database:**
- no new column (periods already have `start_date`);
- the GiST no-overlap and the RLS `month_open(start_date)` already apply;
- the status period's start is set by the adapter in the same transaction.

**Tests:**
- entries dated between `assignedSince` and creation resolve to the customer;
- reports don't move for other vehicles;
- a back-dated first assignment that would re-file an existing entry is refused;
- a locked month is refused for Employee and allowed for Owner / DEV;
- an overlap is refused by the database.

**Rollback:** a transfer with an effective date (audited). Periods are never deleted.

### 9.7 OD-5 — 20-second polling

**Design: a change cursor built on the audit trail.** Every write leaves an audit event (guaranteed by the database).
- The client asks `GET /api/erp/changes?since=<cursor>` **every 20 s while the tab is visible**, at once when it becomes visible or focused, and after each of its own writes. **No polling while the tab is hidden.**
- The server runs `select module, max(at) … from audit.events where at > $since − interval '2 minutes' group by module`:
  - **RLS limits it** to the modules the caller may view;
  - the **2-minute overlap** covers transactions committed out of `at` order (re-invalidating is harmless).
- The client invalidates the query keys of the changed modules (a small module → key map next to `queryKeys`).
- **Database mode only.** The local backend keeps the `storage` event.

**Not Supabase Realtime (for now):** it needs the business schemas exposed through the Data API, against D-1 / S-3. *Upgrade path:* a server Broadcast ping after COMMIT.

**Staleness can't corrupt data:** every write re-validates on the server, against the latest committed data, under the write lock, and OD-6 refuses edits based on old data.

**Tests (`check:sync`):**
- a change by user A is reported to user B's cursor within one cycle;
- an Employee's cursor never reports modules it can't view;
- out-of-order commits are still reported (the overlap);
- no request while hidden.

**UI test:** two accounts, two browsers, an entry visible on the other within ~20 s.

**Rollback:** the polling interval is one constant. Turned off, the app falls back to refetch on focus and after own writes.

### 9.8 OD-6 — Optimistic concurrency (no silent last-write-wins)

**Token: the record's `updatedAt`.** Every stored record already has it, and every database table already maintains `updated_at` by trigger. **No new column.**

**Applies to every write on an existing record:**
- update, archive, restore, transfer;
- invoice issue / cancel;
- delete (so a record someone just edited isn't deleted from a stale view);
- station opening balance;
- opening odometer;
- settings (token = the settings row's `updated_at`; the adapter touches it on every settings save);
- month lock (token = the lock row, or "none yet").

Creates, review (idempotent) and restore (once-only) don't need one.

**App:**
- each such method takes `expectedUpdatedAt`;
- the shared update / remove path compares it **before any validation**;
- on mismatch it throws `ConflictError`: "Someone else changed this record. Reload and try again.";
- hooks pass `record.updatedAt` from the loaded row (the hook argument shapes change; components pass the value they already have);
- **on a conflict:** the dialog stays open with the user's input, the record is refetched, and a toast explains.

**Both backends implement it,** so the existing offline suites test it.

**Database backstop:** the unit of work writes `UPDATE … WHERE id = $1 AND updated_at = $2`. 0 rows → `ConflictError`.

**The precision trap:** Postgres keeps microseconds; JavaScript `Date` keeps milliseconds. **The adapter carries `updated_at` as the exact text Postgres returns and never converts it to a `Date`.** A test pins this.

**Not covered (stated plainly):** two users **creating** the same fill twice. Both are valid creates. The existing duplicate warning on restore stays; nothing new is invented.

**Tests (`check:conflict`):**
- edit with a stale token → refused, nothing written, no audit event;
- a fresh token → saved;
- delete with a stale token → refused;
- the microsecond round-trip;
- both backends;
- two concurrent edits on real Postgres: exactly one wins, the other gets the conflict message.

**Rollback:** the check is one comparison in the shared path; removing it restores last-write-wins (not recommended).

---

## 10. Proposed schema additions (new, additive migrations; columns mirror `types.ts`)

**Conventions:** as the Phase-1 design (text ids, NUMERIC money, `clock_timestamp()`, RLS on, `require_audit_event`).

| File | Content |
|---|---|
| **M-1** | `erp_server` login role (`noinherit`, `grant authenticated`), the server's database login. Password set in the SQL editor, never in git |
| **M-5** | OD-1 (§9.1) |
| **B-1** masters | `core.companies` + `legal_name, gstin, pan, address, city, state, state_code, phone, email, bank_name, bank_account, ifsc` · `core.customers` + `legal_name, business_unit, gstin, state, state_code, email, credit_days` · **`core.customer_pricing`** (1:1: `model, rate, included_km, extra_km_rate, driver_bata`; read needs `customers:view` only, so Employees with `diesel:view` never see pricing) · **`core.customer_route_rates`** (`customer_id, route, distance_km, rate`; U customer + route) · `core.vehicles` + `year, seats, insurance_provider, insurance_policy_no, insurance_valid_till, insurance_premium, road_tax_valid_till, road_tax_amount, road_tax_period, fitness_valid_till, permit_valid_till, emi_amount` · `core.drivers` + `license_no, license_valid_till` · `core.vehicle_types` + `default_seats` |
| **B-2** trips | `ops.trips` (every `Trip` field; revenue stored as priced at the time; archived guard on INSERT; **invoiced trip refuses UPDATE / DELETE** except the invoice operation; no future-date rule, as in the app) |
| **B-3** billing | `billing.invoices` (totals check, cancel-only, **`opening`**, §9.4), `billing.invoice_lines` (Σ = subtotal, deferred), `billing.invoice_line_trips`; `ops.trips.invoice_id` FK |
| **B-4** receipts / expenses | drop `payments_phase1_fuel_station_only`; `customer_id`, `vehicle_id`; `finance.payment_allocations`, with a deferred Σ ≤ invoice total + ₹0.50 (invoice row locked); seed the default expense categories (reference rows) |
| **B-5** settings | `core.app_settings` (single row: `default_tax_rate, tds_rate, sac_code`); `require_audit_event` on the settings tables keyed to record id `settings` |
| **B-6** | RLS, grants and audit triggers for B-1 … B-5 (folded into each file) |
| **B-7** openings | `fuel.adblue_purchases.opening` (§9.3); `core.vehicles.opening_odometer_km / _date` (+ the AdBlue pair if RD-3); policies and guards |

**Not added:**
- `tanker_dispenses` (D-15);
- a bank balance (forbidden);
- stored ledgers or KPIs;
- a vendor master beyond fuel stations;
- a `row_version` column (`updated_at` is the token);
- any import function.

## 11. Migration sequence

| Order | Migration | Depends on | Gate |
|---|---|---|---|
| **0** | **G0 closed (§1)**, with the evidence recorded | — | **No step below starts before this** |
| 1 | Whatever G0 shows is missing of `…000000` … `…000600` (unchanged files) | G0 = B / C | dry-run, then the owner's go-ahead |
| 2 | `…000700_accounts` (M-2), if not applied | 1 | dry-run, go-ahead |
| 3 | M-1 `erp_server` | 1 | go-ahead |
| 4 | **M-5** (OD-1), shipped **with** the app change | 2 | go-ahead |
| 5 | B-1 → B-5 → B-2 → B-3 → B-4 (+ B-6 in each) | 1 | go-ahead each |
| 6 | B-7 openings | 5 | go-ahead |

**Every file:**
1. `npm run check` (PGlite);
2. `npx supabase db push --dry-run --linked`;
3. the owner's go-ahead;
4. `db push`;
5. re-run G0 Query 1 and record the output.

## 12. RLS and role strategy

**Two independent guards:**
1. `api.*` on the server, with the role from the **verified profile**;
2. the database, as `authenticated` (`SET LOCAL ROLE authenticated` + the verified claims): RLS + constraints.

**Credentials:**
- the browser never sends a role or user id that's trusted;
- the server uses `erp_server` (no privileges until `SET ROLE`), **never the service-role / secret key**;
- `SUPABASE_DB_URL` is server-only.

**New tables:**

| Table | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| `ops.trips` | `trips:view` | `trips:create` + `month_open(date)` | `trips:edit` + `month_open` old and new | `trips:delete` + `month_open` |
| `billing.*` | `invoices:view` | `invoices:create`; **opening ⇒ `is_owner_or_dev()`** | `invoices:edit` (status only for opening) | — |
| `finance.payments` / `payment_allocations` | `payments:view` (+ `diesel:view` for station payments, D-3) | `payments:create` + `month_open`; vehicle maintenance: `vehicles:edit` with `vehicle_id` set and `direction = 'OUT'` | `payments:edit` + `month_open` | `payments:delete` + `month_open` |
| `core.customer_pricing`, `customer_route_rates` | `customers:view` | `customers:create` / `edit` | `customers:edit` | `customers:edit` (route rows) |
| `core.app_settings` | any ERP role | — | `settings:edit` | — |
| Opening fields (B-7) | as their table | `is_owner_or_dev()` + `month_open` | same | — |

**Pinned:** `core.role_permissions` = `can()` (`check:supabase-diesel`); the app matrix in `check:roles`. **A permission change = `MAP` + migration + check, together.**

## 13. API changes required

1. **Server context (F-2, F-3):**
   - `currentRole()` / `currentActor()` read a per-request context (AsyncLocalStorage) built from `getServerAuth()`: profile id, name, email, role;
   - **they throw on the server when there's no context**;
   - the browser behaviour is unchanged for the local backend.
2. **Storage interface** (five primitives) with `local` (unchanged) and `pg` (unit of work), which:
   1. takes the global write lock;
   2. loads;
   3. runs the unchanged `api.<method>`;
   4. diffs → INSERT / UPDATE (`WHERE updated_at = token`) / DELETE in FK order with `RETURNING`;
   5. inserts the queued audit events;
   6. COMMITs.
3. **One allowlisted Route Handler** (`app/api/erp/route.ts`, `POST { method, args }`, `zod` arguments, `server-only`), plus `GET /api/erp/changes` (OD-5). A client stub with the same `api` shape.
4. **New methods:**
   - `adbluePurchases.createOpening`;
   - `invoices.createOpening`;
   - `vehicles.setOpeningOdometer`;
   - `assignedSince` on `vehicles.create` / `transfer`;
   - `expectedUpdatedAt` on every existing-record write (OD-6);
   - `hasOwnerAuthority` replacing the Owner-by-name checks (OD-1).
5. **Mappers** TS ⇄ rows:
   - `Customer.pricing` ⇄ pricing + route rates;
   - `Invoice.lines[].tripIds` ⇄ `invoice_line_trips`;
   - `Payment.allocations` ⇄ allocations;
   - `Settings` ⇄ companies + vehicle types + categories + `app_settings`;
   - **`updated_at` carried as exact text.**
6. **Disabled in database mode:**
   - `ensureSeeded`, `migrateStorage` and `latency`;
   - admin reset / clear / restore (D-9, OD-2);
   - `exportBackup` → a **DEV-only read-only export in the `vishal-erp-backup` format** (also the rollback path, §18).
7. **Numbering:** the app's `nextSeq` (safe under the global write lock) with the unique keys as a backstop.
8. **Errors:** SQLSTATE → business messages; `ConflictError` → 409; never SQL text in the browser.
9. **Load ceiling:**
   - *Ceiling:* whole collections load per request. Small at a clean go-live; trips and fills grow about 10–20k rows a year each.
   - *Upgrade path:* period-scoped queries per hot path when measured.

## 14. Real-time synchronisation

OD-5: 20-second polling (§9.7). Supabase Realtime is a later upgrade only if 20 s proves too slow.

## 15. Data validation and reconciliation

**Validation order:**
1. the form;
2. `api.*` rules (unchanged messages);
3. the concurrency token;
4. RLS;
5. constraints;
6. triggers;
7. deferred checks at COMMIT (stock, allocations, opening-invoice lines, audit presence).

| Critical rule | App | Database |
|---|---|---|
| Opening + Fuel Purchased − Payments Made = Closing; carry-forward | `stationLedger` (calculated) | no balance column |
| Payments never modify fuel entries | no code path | separate tables, no linking trigger |
| Tanker stock ≥ 0, per tanker | `assertTankerStock` | row lock + deferred check |
| Loads and fills never double-count | `dv_tanker` excluded | composite FK |
| AdBlue stock and weighted average; opening never a purchase | `valueInventory`, `purchasedIn` | advisory lock + deferred check; opening flag |
| Customer from the assignment on the date | `resolveCustomers` | GiST no-overlap |
| No silent overwrite | `expectedUpdatedAt` | `WHERE updated_at = token` |
| Audit for every change | `audit()` in `tx` | `require_audit_event`, append-only |

**Reconciliation:**
- **Before go-live (offline):** every suite through the `pg` adapter on PGlite. The golden figures prove that the same inputs give the same figures to the paisa (D-12 aside): the Sep / Oct / Nov ledger, Raghuveer Oct 2026, the tanker carry-forward, AdBlue, quarter = Σ months, FY = Σ months.
- **At go-live:** the owner checks every opening figure on screen against the baseline worksheet before any transaction is entered (§17 step 6).
- **After go-live:** a weekly DEV-only read-only SQL checklist, **never shown in the UI**:
  - no running stock below zero;
  - every change has its event;
  - Σ allocations ≤ invoice;
  - no trip on a cancelled invoice;
  - `role_permissions` = `can()`.

## 16. Testing plan

1. **Unchanged:** the 14 suites in `npm run check` on the local backend, with expectations updated where OD-1 / OD-3 change rules (`roles`, `month`, `restore`, `audit`, `actions`, `fresh-start`).
2. **Adapter acceptance (offline):** actions, audit, restore, roles, tankers, month and fresh-start through the `pg` unit of work on PGlite with every migration.
3. **New suites, each pinned in `npm run check`:**

| Suite | Covers |
|---|---|
| `check:supabase-erp` | RLS on trips / billing / receipts / settings / pricing; invoiced-trip lock; totals; allocations ≤ total; cancel-only; opening rows Owner / DEV only |
| `check:openings` | §9.3 – §9.5 behaviour on both backends |
| `check:assigned-since` | §9.6 |
| `check:sync` | §9.7 |
| `check:conflict` | §9.8, incl. the microsecond round-trip |
| G0 regression | Query 1 run on PGlite after all migrations; its output is the expected Production result |

4. **Real Postgres 17** (local Supabase stack, Docker, RD-5; PGlite is single-connection):
   - two concurrent draws on one tanker / AdBlue;
   - two receipts on one invoice;
   - two edits of one record (OD-6);
   - two payments competing for a voucher number;
   - `auth.uid()` from the claims via `erp_server`.
5. **Production:** auth end to end with the real accounts, **read-only checks only**:
   - signed out / unknown Google account → nothing;
   - Employee → no money, deletes, locked months or administration;
   - Owner → all business, **no accounts**;
   - DEV → everything, incl. month lock and restore.
6. **UI smoke (browser):** two accounts on two devices see each other's entry within ~20 s; a conflicting edit shows the reload message; opening records show their badges.
7. **Never** test data, test accounts or test writes in Production (the audit trail is permanent).

## 17. Deployment and go-live runbook

**Phases:**

| Phase | What | Exit criterion |
|---|---|---|
| **G0** | Settle the schema state (§1) | Evidence recorded; outcome A – E handled |
| A | Remaining decisions (§20) | Owner sign-off |
| B | Write the migrations (§10); offline tests | `npm run check` green |
| C | Server context, adapter, route handler, client stub, cursor, concurrency, openings, assigned-since. Behind `NEXT_PUBLIC_DATA_BACKEND=local\|supabase` (default `local`) | Every suite green on both backends |
| D | Production: migrations one by one (dry-run, go-ahead); Pro + PITR; Data API exposure = `public` only; Production `SUPABASE_DB_URL` never in Preview / Development; accounts (1 DEV, 2 OWNER, 2 EMPLOYEE ACTIVE) | G0 Query 1 matches PGlite |
| E | Go-live (below) | First live entries saved and audited |
| F | 2 stable weeks, then the local backend becomes a read-only archive for business data | Owner confirms |

**Go-live day (manual; nothing imported):**
1. **Preserve:** every user, every browser: Settings → Data → **Export JSON backup**, stored outside the browser.
2. **Cut-off:** announce it. No more business entries in the local app.
3. **Masters (Owner / DEV):**
   - company profiles, vehicle types, expense categories;
   - customers with pricing; drivers;
   - **vehicles with "Assigned since" and opening odometer**;
   - fuel stations; tankers JIO / Office / Mini, linked.
4. **Openings, all dated B:**
   - station opening balances (Debit / Credit);
   - tanker opening stock (each tanker);
   - **AdBlue opening stock** (litres + value);
   - **opening invoices** (original number, date, due date, outstanding).
5. **Back-entry** of B → go-live transactions, by hand, if any (OD-2).
6. **The owner verifies** the opening figures and balances on screen against the baseline worksheet: station closing at B, tanker stock, AdBlue stock and value, receivables by customer.
7. **Switch:** `NEXT_PUBLIC_DATA_BACKEND=supabase` on Vercel Production; redeploy.
8. **Smoke-check:** two accounts, two devices (sync, conflict, Employee limits).

## 18. Rollback strategy

| Situation | Action | Data effect |
|---|---|---|
| G0 shows a partial / wrong schema | Stop; forward-fix migration or PITR / fresh project (owner) | No business data exists yet |
| A migration fails while applying | Each file runs in one transaction, so nothing half-applied; fix in a **new** file | none |
| A migration is wrong after applying | Revert with a new migration (e.g. M-5 back to `is_owner()`). Never edit an applied one. Destructive → PITR | none, for additive files |
| App problem after the switch | `NEXT_PUBLIC_DATA_BACKEND=local`, redeploy. localStorage was never touched | Entries made in the database since go-live **aren't in any browser**: DEV runs the read-only export (`vishal-erp-backup` format) and the Owner restores it into **one** browser (Settings → Restore from file, existing validation) or re-enters by hand. **Sharing stops while rolled back** |
| Wrong data entered | Delete with a reason / Restore / Push Back per record (audited); openings: delete / cancel and re-enter | Audited |
| Corruption or a mass mistake | Supabase PITR into a **new project**, compare, switch the env | Owner decision |
| Code regression | Revert the deploy; the backend switch defaults to `local` | none |

**Per decision:** OD-1 §9.1 · OD-2 §9.2 · OD-3 §9.3 – §9.5 · OD-4 §9.6 · OD-5 §9.7 · OD-6 §9.8.

**Keep the rollback window short and explicit** (owner's call): the longer the database runs alone, the more there is to re-enter.

## 19. Risks

| # | Risk | Mitigation |
|---|---|---|
| **R-0** | **The Production schema state is unknown (G0); the documents may be wrong** | Gate G0; recorded evidence; no push before it |
| R-1 | Server runs as Owner (F-2) | Context-or-throw; tested |
| R-2 | OD-1 applied in the app but not the database (or the reverse) | M-5 + app + checks + CLAUDE.md in one release |
| R-3 | Production is the only cloud database; the audit trail is permanent | Offline + local Supabase only; read-only checks in Production |
| R-4 | Concurrency untestable in PGlite | Local Supabase stack (RD-5) |
| R-5 | Global write lock limits throughput | Fine for 5 users; finer locks later |
| R-6 | Whole-collection loads grow | Targeted queries when measured |
| R-7 | Opening figures entered wrongly | Owner verification step; openings are audited and correctable |
| R-8 | Browser-only entries since 1 Nov not re-entered | Backups first; manual back-entry checklist |
| R-9 | Microsecond / millisecond token mismatch → false conflicts | Token carried as text; pinned test |
| R-10 | Data API exposure misconfigured | Q-5 settings + G0 / Appendix A queries |
| R-11 | The Production DB URL leaks to Preview / dev machines | Per-environment env; `erp_server` without privileges until `SET ROLE` |
| R-12 | Rollback after go-live loses sharing, needs re-entry or a single-browser restore | Short, explicit window; DEV export in backup format |
| R-13 | AdBlue opening value wrong → every later draw mis-costed | Value required; owner check; delete and re-record before the first draw |

## 20. Remaining decisions (needed before Phase B)

| # | Decision | Recommendation |
|---|---|---|
| RD-1 | **Baseline date B:** 31 Oct 2026 (fresh-start worksheet), or the go-live day | The go-live day if little was entered since 1 Nov (less back-entry); otherwise 31 Oct |
| RD-2 | AdBlue opening **value required** (> 0) or optional like tanker opening stock | Required (draw costs depend on it) |
| RD-3 | Also an **AdBlue opening odometer** (last AdBlue top-up before B) | Yes, same mechanism |
| RD-4 | Approve migrations M-1, M-5, B-1 … B-7 (each dry-run and go-ahead separately), after G0 | Approve |
| RD-5 | Local Supabase stack (Docker) for concurrency and auth tests | Approve |
| RD-6 | Customer logo stays a data URL (D-11) | Keep |
| RD-7 | Don't add rules the app lacks: trips may be future-dated; invoices outside the month lock | Keep the app's behaviour |
| RD-8 | Settings split: company profile, vehicle types, rates = Owner + DEV; accounts / system = DEV only | Approve |
| RD-9 | Retire the local backend for business data after 2 stable weeks (read-only archive) | Approve |
| RD-10 | Integration plan items still open: Q-5 (Data API exposure, JWT keys, Google only, MFA), Q-6 (the `postgres` driver), Q-10 (scheduled audit export) | Approve |

**Not to be implemented until this revision is reviewed and approved, and Gate G0 is closed.**
