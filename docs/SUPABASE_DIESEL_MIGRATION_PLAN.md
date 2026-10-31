# Supabase Diesel Migration Plan — replacing localStorage for the Fuel modules

**Status (1 Nov 2026):** plan only. Nothing here has been executed against Supabase. The schema it targets is `SUPABASE_DIESEL_DATABASE_SCHEMA.md`; decisions D-1 … D-18 were approved on 1 Nov 2026 and the SQL moved unchanged into `supabase/migrations/20261101*` (step 1's file move is done; applying to staging is not).

**Out of scope, by instruction:**
- **No data is migrated:** no localStorage records, demo data, JSON backups, Excel workbooks or historical records.
- No import scripts.

The owner enters the initial master data and opening balances in the new system.

**Supersedes:** `SUPABASE_MIGRATION_PLAN.md` (which planned a data copy) for the Diesel phase.

---

## 1. Goal and principles

**Goal:** move the Fuel modules from browser localStorage to Supabase:
- Diesel, Fuel Stations, Diesel Tankers, AdBlue;
- station payments and TDS;
- the masters they use: companies, customers, vehicles, drivers, vehicle types, assignments;
- month locks, the audit log and its reviews.

Every screen, workflow, rule and figure stays exactly as it is today.

**Principles:**
1. **The boundary doesn't move.** Components keep calling `src/lib/api/hooks.ts` → `api.*`. Only what sits under `api.*` changes. No component, hook signature or query key changes.
2. **Business logic is reused, not rewritten.** `src/domain/*` (ledgers, stock and valuation, KPIs, periods, audit snapshots) runs unchanged on rows from the database. The `api.*` validations (permission, month lock, archive, assignment, stock, reasons) keep running first and keep their messages.
3. **The database is the second guard.** RLS, foreign keys, exact generated amounts, the deferred stock checks and the audit guarantees hold even if the app has a bug.
4. **Reversible at every step** (§7).

## 2. Who sees what in phase 1

The production sidebar already shows the Owner and Employees only the **Fuel** section (and the Owner the Audit Log): `showInNav` in `src/components/layout/nav.ts`. Phase 1 therefore covers everything those users can reach.

The non-fuel modules stay on localStorage until their own phase:
- Customers page (billing fields), Trips, Invoices, Payments (other vouchers and receipts), Reports, Dashboard.
- They are reachable only by Dev and are not used in production.

**Shared masters during phase 1:**
- Customers, vehicles and drivers live in Supabase. The Diesel dialogs (Add Customer, Add Vehicle, Transfer, Archive) write there.
- The Customers / Vehicles pages are Dev-only. In production mode they read the same Supabase masters.
- Fields that only those pages edit (pricing, insurance, road tax…) aren't stored until their module's phase (D-7). The forms show the defaults the Diesel dialogs already use.

## 3. Target request path (decision D-1, option B)

```
Browser (unchanged components + hooks)
  → api.* (client stub)  ── fetch / Server Action ──►  Next.js server
                                                        1. supabase.auth.getClaims()  (verified session, never getSession())
                                                        2. BEGIN on a server-only Postgres connection (SUPABASE_DB_URL)
                                                        3. SET LOCAL ROLE authenticated; set_config('request.jwt.claims', <verified claims>, true)
                                                        4. run the existing api.<method> logic with a Postgres repository
                                                           (reads → SELECT; writes → INSERT/UPDATE/DELETE + audit.events INSERT)
                                                        5. COMMIT  (deferred stock + audit checks run here) — any error → ROLLBACK
```

- **Why server-side:** a business write is several statements (a fill, its stock check, its audit event; a transfer plus status period plus assignment). `supabase-js` from the browser can't wrap them in one transaction. Rewriting every rule as PL/pgSQL (option A) would risk silently changing accounting rules.
- **What it needs** (when approved; not added now):
  - a server-only connection string `SUPABASE_DB_URL` (never `NEXT_PUBLIC_`);
  - a Postgres driver (e.g. `postgres` or `pg`);
  - `@supabase/ssr` middleware (`proxy.ts`) for the session cookie.
- **The Supabase secret key** (`SUPABASE_SECRET_KEY`, placeholder only in `.env.local`) is **not** needed by this path. Keep it empty unless a server feature such as admin invitations needs the Admin API. It must never be imported into browser code.

## 4. The repository adapter (what changes in code)

| Today | Phase 1 |
|---|---|
| `createLocalRepository(key, prefix)` in `src/lib/api/repository.ts` | `createPgRepository(table, mapping)` implementing the same `Repository<T>` (`list / get / create / update / remove`) over the transaction's connection |
| `readCollection(key)` inside `api.*` validations | `await repo.list()` (or targeted queries), inside the same transaction |
| `tx(fn)` + `runInTransaction` (localStorage restore on error) | `tx(fn)` = BEGIN … COMMIT on the server connection |
| `audit(...)` → `appendAuditEvent` | `audit(...)` → `INSERT INTO audit.events` (same fields; `at` / `txid` default in the database) |
| `nextSeq(...)` for payment numbers | omitted: the database assigns `payment_no` (same format and rule) |
| `currentRole()` / `currentActor()` from `vt:ui:role` | from the verified session's profile (`role`, `profile id`, `full_name`) |
| `todayISO()` for writes | unchanged in the app for messages. The database re-checks with its own India clock |

**Field mapping** (TS shape ⇄ table). The adapter is the only place that knows both:

| App type → table | Mapping |
|---|---|
| `DieselEntry` → `fuel.diesel_entries` | `vendorId` ⇄ `station_id`. `tankerId` ⇄ `tanker_id`. `amount` is **read only** (generated): never written. `averageCost` is never stored |
| `TankerLoad` → `fuel.tanker_loads` | `stationId ""` ⇄ `station_id NULL` (opening). `amount` written only for opening stock |
| `AdBlueEntry` → `fuel.adblue_entries` | `vendorId` (legacy, always `""` for new entries) not stored. `amount` read only. STOCK `vendorName` / `rate` / `paymentMode` ⇄ NULL |
| `AdBluePurchase` → `fuel.adblue_purchases` | `totalLitres` / `totalCost` read only. `opening` always false |
| `FuelStation` → `fuel.fuel_stations` | `isTanker` ⇄ `is_tanker_source`. `openingBalance` `undefined` ⇄ NULL |
| `Tanker` → `fuel.tankers` | direct (`regNo` never empty) |
| `Payment` (station) → `finance.payments` | `vendorId` ⇄ `station_id`. `allocations` always `[]`. `paymentNo` read back after insert. `forMonth` `undefined` ⇄ NULL |
| `Customer` / `Vehicle` | `statusHistory[]` ⇄ `*_status_periods` rows. Phase-1 columns only (D-7) |
| `VehicleAssignment`, `MonthLock`, `Driver`, `VehicleType`, `CompanyProfile` | direct, snake_case. `MonthLock.changedBy` ⇄ `changed_by_role` (+ `changed_by` profile) |
| `AuditEvent` / `AuditReview` | `actor` ⇄ `actor_kind / actor_user_id / actor_name / actor_role` |
| `TankerDispense` | no table (D-15): `list()` returns `[]`; `create` / `update` refused |

**Error messages:**
- The app's own validations run first, so users keep today's messages.
- A database refusal (a race the app couldn't see) is mapped by SQLSTATE:
  - `23514` / `23505` → the constraint's business message, e.g. "Insufficient tanker inventory in JIO. Available: 50 L";
  - `42501` (RLS) → "Your role can't …" / "{Month} is locked…".
- `PossibleDuplicateError` and `checkRestore` keep working: `planRestore` reads through the same repository.

**Not offered against the shared database** (D-9):
- `api.admin.resetDemoData`, `clearAllData`, `restoreBackup`: refused, with Settings → Data explaining why.
- `exportBackup`: stays a read-only export of the Fuel tables.

## 5. Step-by-step rollout

| Step | What | Done when |
|---|---|---|
| 0 | **Approvals:** D-1 … D-18 (`SUPABASE_DIESEL_DATABASE_SCHEMA.md` §12). Supabase Pro plan with PITR (D-13) | Owner signs off |
| 1 | **Schema in a non-production project first.** ~~Move `supabase/proposed/diesel/*.sql` into `supabase/migrations/` unchanged~~ (done 1 Nov 2026). `npm run check:supabase` + `check:supabase-diesel` pass. `npx supabase db push --dry-run`, then `db push` **to a staging / branch project** | Staging has the schema; the checks pass there too |
| 2 | **Auth (Phase 2):** Google sign-in, `proxy.ts`, the first Owner inserted by SQL (`SUPABASE_SETUP.md`), invitations for Dev and Employees | Each person signs in and sees their role |
| 3 | **Adapter behind a switch:** `NEXT_PUBLIC_DATA_BACKEND=local\|supabase` (default `local`). Build the Postgres repository and server transaction wrapper. Run every existing `npm run check` suite against both backends (the checks drive `api.*`, so they become the adapter's acceptance tests) | All suites pass on `supabase` (staging) |
| 4 | **Parallel trial on staging:** the owner enters a few real days in staging, compares the station ledger, tanker stock and AdBlue figures with the browser version | Figures identical |
| 5 | **Go-live on production:** apply the migrations to the production project. The owner enters masters, station opening balances (Debit / Credit) and tanker opening stock as of the go-live date (`OCTOBER_31_CARRY_FORWARD_WORKSHEET.md`). Flip the switch to `supabase` | First live entries saved and audited |
| 6 | **Retire localStorage for the Fuel modules** after a stable period. The browser data stays untouched, as a read-only archive | Owner confirms |

**Never during these steps:**
- `supabase db reset` against a real project;
- editing an applied migration;
- `clearAll()` / `loadDemoData()` / a restore as part of a migration;
- the November Fresh Start reset (separate owner decision).

## 6. Verification at each step

- **Schema:** `npm run check:supabase-diesel` (PGlite, offline). Then the same SQL on staging via `db push --dry-run`.
- **Behaviour:** the full `npm run check` against the Supabase backend (step 3).
- **Figures:** for a sample period, the station ledger (opening, purchased, paid, closing), tanker stock per tanker and AdBlue stock must match the browser exactly, to the paisa. The only expected difference is the documented 1-paisa float case (D-12), which the database computes correctly.
- **Security:**
  - signed-out → nothing;
  - Google account without an invitation → nothing;
  - Employee → no money writes and no locked month;
  - Dev → no Owner-only actions;
  - audit rows can't be changed.

## 7. Rollback strategy

| Situation | Rollback |
|---|---|
| A migration fails while applying | Each migration file runs in one transaction (Supabase CLI), so nothing is left half-applied. Fix it in a **new** file |
| The schema is wrong on staging | Drop the staging project / branch and re-create it. Production was never touched |
| Problems after go-live (app side) | Flip `NEXT_PUBLIC_DATA_BACKEND` back to `local`. The browser's localStorage was never modified, so the app works as before. Entries made in Supabase meanwhile are exported (CSV / JSON from the Fuel tables) and re-entered or restored once fixed |
| Bad data written in production | Restore / Push Back from the Audit Log (per record), or Supabase point-in-time recovery (D-13) to just before the incident on a new project, then compare |
| A later migration breaks something | Additive migrations are reverted by a new migration (e.g. drop the new column / constraint). Destructive changes need a backup first and owner approval |

**Backups:** PITR (Pro plan), plus a scheduled export of `core`, `fuel`, `finance` and `audit` to the owner's storage. The browser's Settings → Export stays available for the localStorage modules.

## 8. Open questions for the owner

1. **D-1 implementation detail:** host the server on Vercel (current) with a pooled connection (Supabase pooler, transaction mode). A session-level `SET LOCAL` per transaction is compatible with transaction pooling.
2. **Go-live date and opening balances:** the same "31 October baseline" as the November Fresh Start, or the actual go-live date?
3. **Employee devices:** Employees will sign in with Google accounts. Which emails get invitations?
4. **Phase 1 visibility:** should Dev-only non-fuel pages be hidden entirely in production until their phase?
