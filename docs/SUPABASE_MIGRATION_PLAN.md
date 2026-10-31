# Supabase Migration Plan: localStorage → Supabase PostgreSQL

> **Superseded for the Diesel phase (31 Oct 2026)** by `SUPABASE_DIESEL_DATABASE_SCHEMA.md` (authoritative schema, SQL in `supabase/migrations/20261101*` — design approved 1 Nov 2026, not applied to any Supabase project) and `SUPABASE_DIESEL_MIGRATION_PLAN.md` (no data import). Kept for the full-ERP context and the D-numbered decisions it introduced; where the two differ, the Diesel documents win.

**Status:** plan only. Nothing in it has been run. Every step needs the owner's approval first, and the decisions D-1 … D-14 in `SUPABASE_DATABASE_ARCHITECTURE.md` §9 come before it.

**Rules (CLAUDE.md):**
- **Copy and verify, never move-and-delete.** The browser data stays untouched until the owner approves switching over.
- **Migrations are additive.** Never `supabase db reset` against the real project.
- **No accounting rule changes.**

## 0. Preconditions

1. **Decisions approved:** D-1 (write path), D-2 (roles enum), D-4 (ids), D-5 (uniqueness), D-8 (audit log), D-10 (timing vs the November fresh start).
2. **Phase 2 sign-in is built and tested:** Google OAuth, Owner invitations, `profiles` ACTIVE. The first Owner account exists. Without it, RLS gives nobody access.
3. **The business schema is a reviewed migration file.** It's applied first to a **Supabase branch or local stack**, never straight to the live project. `check:supabase` is extended to load it into PGlite and test the RLS policies per role (Owner / Dev / Employee / no account), the month lock and the append-only audit.
4. **The server data layer exists behind `src/lib/api`** (D-1), and `npm run check` passes against PostgreSQL as well as against localStorage.

## 1. Choose the source dataset

- **The data lives in one browser per device.** Each browser holds its own copy and its own audit log. **One browser is chosen as the source of truth**, normally the Owner's. Others are compared, not merged: two browsers can hold the same ids with different values.
- **`vt:meta.source` must be `RESTORED` (real data).** `DEMO` or `EMPTY` data is never migrated, and the migration tool refuses it.
- **Decide the fresh start first (D-10).** Migrating before the fresh start copies data that's about to be cleared. Migrating after it copies only the October baseline and November onwards. Recommended: after it.

## 2. Freeze, backup and checksums

1. **Announce a cut-over window.** Nobody enters data in any browser during it.
2. **On the source browser,** Settings → Data → **Export JSON backup** (`vishal-erp-backup` format: every collection plus settings).
3. **Export the audit log and reviews** (`vt:auditEvents`, `vt:auditReviews`). The JSON backup doesn't include them, so this needs a small **new, read-only** export (D-8).
4. **Record the SHA-256 of each file.** Keep 3 copies: the computer, an external drive and a private cloud folder. **Never in git** (`.gitignore` covers `vishal-erp-*.json` and database dumps).
5. **Leave the browser data as it is.** It is the rollback until switch-over is approved.

## 3. Dry run (no live database)

A script (e.g. `scripts/supabase-migrate/` with `tsx`, run locally). It never runs inside the app. It does the following:

1. **Validates the backup** with the app's own `parseBackup` (unique ids, every reference resolves, no newer format). Then it applies the same normalisation as `migrateStorage` (fuel stations collection, `tnk_default` stamping, confirmed tankers) **in memory only**.
2. **Transforms each collection into rows:**
   - `""` → `NULL` (I-2);
   - embedded arrays → child tables: `statusHistory`, `pricing.routes`, `invoice.lines[].tripIds`, `allocations`;
   - settings → `companies`, `app_settings`, `expense_categories`;
   - `vt:vehicleTypes` → `vehicle_types`.
3. **Checks every value fits its column.** Nothing is rounded silently: a money value with more than 2 decimals, litres with more than 3, rates with more than 4, or a non-finite number is **reported and stops the run**.
4. **Checks the proposed constraints:**
   - duplicate customer codes and normalised vehicle registrations (D-5);
   - duplicate voucher, trip and invoice numbers;
   - a second TDS per station-month;
   - more than one opening per tanker or AdBlue;
   - overlapping assignments or status periods;
   - allocations above invoice totals.

   **Each finding is listed with the record id.** None is "fixed" without the owner's answer.
5. **Loads the rows into a throw-away PostgreSQL** (PGlite or a local Supabase stack) with the migration schema.
6. **Reconciles.** Reads every row back and compares with the source:
   - **Counts** per collection and table.
   - **Totals** per collection: litres, ₹, km, `tdsAmount`, allocations.
   - **Recalculated figures,** with the same `src/domain` functions on both sides:
     - every station's monthly ledger (opening, purchased, paid, closing);
     - every tanker's monthly stock and value;
     - AdBlue stock and value;
     - diesel totals per customer and vehicle per month;
     - invoice outstanding.

   **Any difference fails the run.**
7. **Writes a report** (`migration-dry-run-<date>.md`, git-ignored, since it contains business figures) with the counts, totals and findings.

**The dry run is repeated until it is clean and the owner approves.**

## 4. Load order (dependencies)

Each step only references rows loaded before it. One database transaction for the whole load:

1. `companies` (parent first), `app_settings`, `expense_categories` (must include `DIESEL_SETTLEMENT`), `vehicle_types`, `role_permissions`.
2. `profiles`: already created by Phase 2 sign-in. Not part of the data copy.
3. `customers` → `customer_route_rates` → `customer_status_periods`.
4. `drivers`.
5. `vehicles` (`assigned_customer_id`, `default_driver_id`) → `vehicle_status_periods` → `vehicle_assignments`.
6. `fuel_stations` (incl. `dv_tanker`, opening balances), then `tankers` (incl. stock pools `tnk_default` / `tnk_combined_fy2627`, linked vehicles).
7. `month_locks` (role kept, `changed_by` NULL).
8. `trips`, inserted with `invoice_id` NULL.
9. `invoices` → `invoice_lines` → `invoice_line_trips`, then `update trips set invoice_id = …` from the source.
10. `diesel_entries`, `tanker_loads`, `tanker_dispenses`, `tanker_transfers`, `tanker_adjustments`, `adblue_purchases`, `adblue_entries`.
11. `payments` → `payment_allocations`.
12. `audit_events`, ordered by `at`. `restores_event_id` is set in a second pass after all events exist. Events older than the last DATA_RESET get `before_last_reset = true`. Then `audit_reviews`.
13. `document_sequences`: set to the highest existing number per prefix (`PAY` / `RCT` per company and FY, trips, invoices), so new numbers continue without a gap or a clash.
14. `migration_runs` row: the backup's SHA-256, counts, totals and status `COMMITTED`.

**Triggers during the load:** `updated_at` touch triggers are disabled for the load only, so `created_at` / `updated_at` keep their original values (they drive "newest first" ordering). The audit append-only trigger stays on: the load only inserts.

**No audit events are generated for the copy itself,** because it would double the history. The `migration_runs` row records it instead. *(Option, if the owner prefers: one SYSTEM `DATA_RESET`-style event "Imported from browser backup <sha>".)*

## 5. Avoiding duplicate transactions

- **Original ids are the primary keys** (D-4). Re-running the load can't create a second copy of any record: `insert … on conflict (id) do nothing`, then a check that every existing row **equals** the source row. A difference stops the run; nothing is overwritten.
- **Natural keys are unique too:** `payment_no`, `trip_no`, `invoice_no`, one TDS per station-month, one opening per tanker, one restore per deletion. A record re-keyed by mistake still collides.
- **The whole load is one transaction.** It's all or nothing: a failure leaves the database empty of business rows, and it's safe to fix and retry.
- **`migration_runs` refuses a second COMMITTED run** with the same checksum. A run with a **different** backup into a non-empty database is refused unless the owner explicitly approves a delta plan. There is no "merge two browsers".
- **After cut-over, the browsers stop writing.** The app switches to the server layer, and localStorage writes are disabled, so nobody keeps adding fills in the old store that would later need a second import.
- **The fuel import** (`scripts/fuel-import`, deterministic ids) keeps producing the same ids, so a later import of the same Excel rows collides instead of duplicating.

## 6. Cut-over

1. **Load** into the **live** project: same script, same checksum as the approved dry run.
2. **Run the reconciliation again** against the live database (step 3.6), and get the owner's sign-off on the report.
3. **Deploy the app version** whose `src/lib/api` uses the server data layer (D-1).
4. **Spot-check in the app** as Owner, Dev and Employee:
   - a station ledger;
   - each tanker's stock;
   - AdBlue stock;
   - a locked month refusing Dev and Employee;
   - the Audit Log.
5. **Keep the browser data read-only** for an agreed period (e.g. one month) before anyone clears it. Clearing needs separate approval.

## 7. Rollback strategy

| When | Rollback |
|---|---|
| **Before cut-over** (dry runs, live load not yet used) | Nothing to roll back in the browser: it was never changed. Live database: the load is one transaction, and a failed load leaves no rows. A committed-but-rejected load is removed only with the owner's approval (delete business rows in reverse load order, or restore the pre-load database backup), never with `db reset` |
| **After cut-over, problem found early** | Switch the app back to the localStorage build (the browser data is still there and unchanged). Any entries made in Supabase since cut-over are exported and re-entered, listed from `audit_events` |
| **After cut-over, data damaged later** | Supabase point-in-time recovery (D-13: Pro plan + PITR) to just before the damage, or the latest daily backup, plus `audit_events` to replay what happened since |
| **Always** | The checksummed JSON backup and audit export from step 2 can rebuild the starting point |

**Before go-live:** take a manual database backup (dashboard → Database → Backups) immediately before the load, and a logical export (`pg_dump`, stored outside git) right after the sign-off.

## 8. Data compatibility issues (and how each is handled)

| Issue | Handling |
|---|---|
| JS numbers are floats (e.g. `0.30000000000000004`) | Rounded to the column scale **only** where the difference is below half a unit of that scale and the source app itself rounds there (`round2`). Otherwise it's reported (step 3.3) |
| PostgreSQL `numeric` comes back as a **string** in JS drivers | The server data layer converts to `number` in one place, so `src/domain` keeps receiving numbers |
| `""` meaning "none" (station on opening loads, AdBlue `vendorId`, pool `regNo`) | → `NULL` (I-2). The server layer maps back where the domain expects `""` |
| Missing `tankerId` | → `tnk_default`, exactly as `tankerOf` reads it (I-3) |
| `dv_tanker` pseudo-station | Kept as a `fuel_stations` row (D-6) |
| Legacy tanker fills with rate 0 / AdBlue STOCK draws with amount 0 | Stored as they are. Cost is derived on read, as today (I-9) |
| `odometerKm` null on imported fills | Nullable column. KM Run skips the gap as today |
| Payments without `forMonth` (before 31 Oct 2026) | NULL ("—") |
| Legacy AdBlue opening record (`opening: true`) | Kept. One-only partial unique index |
| `statusHistory` absent on old records | The app's migration already derived it. The script derives it the same way (`historyOf`) if missing |
| Removed roles in audit actors and month locks | Kept as text in `audit_events.actor_role` / `month_locks.changed_by_role`. Never in `erp_role` (D-2) |
| Audit events before the last DATA_RESET (reused demo ids) | Imported with `before_last_reset = true`. Restore stays refused for them |
| Audit `before` / `after` snapshots | jsonb as they are (images already `[image]`) |
| Customer logos as data URLs | Text column (D-11). Size checked by the dry run |
| `createdAt` / `updatedAt` ISO UTC strings, business dates `yyyy-MM-dd` | `timestamptz` / `date`. Month strings `yyyy-MM` → `char(7)` with a check |
| `customerId` stamps on fills vs resolution from assignments | Both kept (I-5). Reports keep resolving from `vehicle_assignments` |
| Demo-seeded ids (`pay_0001` …) in a dataset that is really demo | Refused (`meta.source`) |
| Same id with different data in two browsers | Only the chosen source is loaded. Others are only compared |
| `vt:meta`, `vt:ui:*`, legacy `settings.tanker` | Not migrated (system / session / one-off) |

## 9. What the migration never does

- It doesn't change, re-date, re-price or re-assign any record.
- It doesn't invent opening balances.
- It doesn't split the tanker pools.
- It doesn't merge duplicates.
- It doesn't clear the browser data.
- It doesn't run `supabase db reset`.
- It doesn't run the November fresh start.

Every one of these is a separate, explicit owner decision.
