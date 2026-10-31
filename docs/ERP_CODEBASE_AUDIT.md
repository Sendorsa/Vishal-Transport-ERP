# ERP Codebase Audit — Vishal Transport

**Date:** 31 Oct 2026 · **Scope:** the whole `prototype/` app (Next.js 16.4.3, TypeScript, Tailwind, shadcn/ui, TanStack Query, localStorage), its scripts, migrations, documentation and tests. Paths are relative to `prototype/` unless they start with `../`.

**How it was audited:**
- I read the data path end to end: UI → `src/lib/api/hooks.ts` → `src/lib/api/index.ts` → `src/lib/api/repository.ts` → `src/lib/storage/local-store.ts`. I also read every domain rule in `src/domain/`, the types, permissions, the Supabase foundation and the existing documents.
- **Unused files:** a script resolved every `import` / `import()` in `src` and `scripts` (aliases and relative paths).
- **Unused exports:** a script checked every exported name for references outside its own file. Each candidate was then checked by hand with `grep`, including references from checks, scripts and dynamic `import()`.
- **Dependencies:** each `package.json` dependency was searched for in TS, TSX and CSS imports.
- **Baseline:** `npm run check`, `npm run typecheck`, `npx eslint` and `npm run build` were all run **before** any change. All passed.

A downloaded dead-code tool (knip) was blocked by the environment, so the analysis used the two scripts above (kept outside the repo).

---

## 1. Overview

| Metric | Value |
|---|---|
| Source files (`src/`) | 160 TS / TSX files, ~26,400 lines |
| Routes | 28 pages: `/`, `/adblue`, `/audit`, `/customers` (+ `/new`, `/[id]`), `/diesel` (+ `[company]`, `[company]/[month]`, `[company]/[month]/[vehicle]`, `ledger`, `monthly-master`, `quarterly-master`, `yearly-master`), `/fuel-stations` (+ `[id]`), `/invoices` (+ `/new`, `/[id]`), `/payments`, `/reports`, `/settings`, `/tanker`, `/trips` (+ `/new`, `/[id]`), `/vehicles` (+ `/new`, `/[id]`) |
| localStorage collections | 17 business collections, plus settings, vehicle types, audit events, audit reviews, meta and session keys |
| Automated checks | 11 suites under `npm run check` (diesel, audit, actions, restore, roles, backup, tankers, month, fresh-start, supabase, **supabase-diesel** — new) |
| Dependencies | 21 runtime and 10 dev. **Every one is used** (§7) |

**Overall:** the codebase is in good shape.
- Business rules sit in pure `src/domain` functions.
- Every write goes through one API file, with permission, month-lock, stock and audit checks.
- There is very little dead code.
- The main structural debt is size and naming (§8, §9), not unused code.

---

## 2. Architecture as built

```
Route file (src/app/**/page.tsx, thin)
  → Feature component (src/features/<module>/*.tsx, client)
    → TanStack Query hook (src/lib/api/hooks.ts)
      → api.<module>.<method> (src/lib/api/index.ts)          ← permissions, month lock, archive, stock, audit, tx()
        → createLocalRepository(key, prefix) (repository.ts)  ← list / get / create / update / remove
          → readCollection / writeCollection (local-store.ts)  ← column-encoded JSON per key, in-memory cache
      → src/domain/* (pure)                                   ← ledgers, stock, valuation, KPIs, periods, audit diff
```

- **Writes:** `tx()` serialises them in the tab. `runInTransaction` restores every touched key on error, so a record change and its audit event are all-or-nothing within one browser.
- **Reads:** the API doesn't check read permissions, except `api.audit.*`. The UI hides what a role can't see.
- **Seam for the backend:** `repository.ts` plus `api.*`. No component touches storage directly. `grep localStorage src/features src/components` finds only the session helpers in `lib/app-state.ts`.

---

## 3. Implemented features (verified in code)

| Area | Features | Main files |
|---|---|---|
| **Diesel** | Month → Customer → Vehicle → Entries; KPI rows; vehicle search; Add / Edit / Delete diesel entries (pump or tanker source); Monthly / Quarterly / Yearly (calendar and FY) Masters; diesel ledger | `features/diesel/*`, `domain/diesel.ts`, `domain/fuel-master.ts`, `domain/consumables.ts` |
| **Fuel Stations** | Station master (create / edit / archive / restore); ledger (opening + purchased − paid = closing, carry-forward); payments with "paid against"; cash at pump (derived); TDS 0.1%; Debit / Credit opening balance | `features/fuel-stations/fuel-stations.tsx`, `domain/station-ledger.ts`, `domain/fuel-stations.ts` |
| **Diesel Tankers** | Tanker master (JIO / Office / Mini, add more); loads (purchase); tanker fills from the vehicle's diesel entry; transfers; adjustments; opening stock (Owner / Dev); per-tanker stock and monthly ledger; external dispense history | `features/tanker/diesel-tanker.tsx`, `domain/tanker.ts` |
| **AdBlue** | Bulk purchases (buckets); draws at moving weighted average; direct vendor purchases; stock ledger; vendors | `features/adblue/adblue-inventory.tsx`, `features/diesel/add-adblue-dialog.tsx`, `domain/adblue-inventory.ts`, `domain/adblue.ts` |
| **Masters** | Customers (status history), vehicles (status history, assignment history, transfer), drivers, vehicle types, companies | `features/customers/*`, `features/vehicles/*`, `domain/status-history.ts`, `domain/assignments.ts` |
| **Operations / finance (hidden from Owner and Employee in the sidebar)** | Trips (pricing), invoices (GST, cancel), payments (receipts with allocations, vouchers), reports, dashboard | `features/trips/*`, `features/invoices/*`, `features/payments/*`, `features/reports/*`, `features/dashboard/*`, `domain/pricing.ts`, `domain/invoicing.ts`, `domain/analytics.ts` |
| **Controls** | Roles (Owner / Dev / Employee); Monthly Sheet Lock (India time, Owner override); audit trail with before / after, deletion review and Restore / Push Back; backups (export, restore, reset, clear) | `lib/permissions.ts`, `domain/month-lock.ts`, `domain/audit.ts`, `features/audit/audit-log.tsx`, `lib/api/bootstrap.ts` |
| **Data import** | FY 2026-27 fuel import (Python extract, TS build, reconciliation report) | `scripts/fuel-import/*` |
| **Supabase Phase 1** | Env guard, browser and server clients, `profiles` accounts migration, offline PGlite check, ping script | `src/lib/supabase/*`, `supabase/migrations/20261028000000_erp_accounts.sql`, `scripts/supabase-ping.ts` |

## 4. Partially implemented features

| Feature | State | Evidence | Recommendation |
|---|---|---|---|
| Supabase clients | Built, **imported by nothing** (deliberately) | `src/lib/supabase/client.ts`, `server.ts`; CLAUDE.md "Supabase (Phase 1)" | Keep. They are the foundation for the migration plan |
| Login / accounts | Built for account management (1 Nov 2026): Google sign-in only; DEV pre-creates accounts, no invitation emails; the business app still uses the mock session `vt:ui:role` | `../SUPABASE_SETUP.md` §6 | Phase 2 |
| November Fresh Start "clear operational data" | **Not built** (waits for owner decisions) | CLAUDE.md "November 2026 Fresh Start"; `../NOVEMBER_FRESH_START_IMPLEMENTATION_REPORT.md` | Unchanged |
| External tanker dispenses | **No UI to create** (removed 31 Oct 2026); API `create` / `update` kept for checks and Restore | `api.tankerDispenses.create` is called only from `*.check.ts` | Keep in the browser app. Not carried into the Supabase schema (D-15) |
| Stock pools (`tnk_default`, combined pool) | Hidden on the Tankers page; history kept | `isStockPool` in `domain/tanker.ts` | Keep. Not carried into the Supabase schema (D-16) |
| `Settings.tanker` (single-tanker config) | Read once by the storage migration | `migrateStorage` in `local-store.ts` | Keep until no browser holds pre-tanker data |

## 5. Unused code (verified) — removed

| Item | Evidence | Action |
|---|---|---|
| `src/components/ui/scroll-area.tsx` | No importer anywhere (import-graph scan + `grep ScrollArea`) | **Deleted** |
| `public/file.svg`, `globe.svg`, `next.svg`, `vercel.svg`, `window.svg` | create-next-app starter assets; no reference in `src`, CSS or README | **Deleted** (and the now-empty `public/`) |
| `.DS_Store` (prototype root, `src/`) | macOS Finder files; already git-ignored | **Deleted** |

**Checked and kept (not unused):**
- **`src/lib/supabase/client.ts` / `server.ts`:** deliberately unused foundation.
- **`src/lib/api/test-browser.ts`:** the localStorage stand-in imported by every API check.
- **`api.tankerDispenses.create` / `update`:** used by `tankers.check.ts`, `actions.check.ts`, `restore.check.ts` and `roles.check.ts`.
- **`DieselVendor` type alias:** used in `domain/fuel-master.ts`, and documented in CLAUDE.md.
- **`isTankerLoadId`:** used by Fuel Stations.
- **`storageUsage` / `subscribeExternal`:** used by Settings and providers.
- **`scripts/fuel-import/scan_others.py`:** referenced by `report.py`.

**Exports used only inside their own file:** 75 names. They are mostly types: `LedgerRow`, `StockRow`, `TankerMove`, `RestorePlan`, `NavItem`…
- They cost nothing at runtime.
- Removing the `export` keyword is churn without benefit, so they were left as they are.

**shadcn/ui exports not used:** 50 sub-components of generated `components/ui/*` files, such as `DialogClose` and `SelectGroup`. They are part of the generated library surface and are kept, so the files stay regenerable with the shadcn CLI.

## 6. Duplicate logic

| Finding | Files | Action |
|---|---|---|
| The same litre formatter `` (n) => `${formatNumber(n, 2)} L` `` was defined three times | `features/adblue/adblue-inventory.tsx`, `features/tanker/diesel-tanker.tsx`, `lib/api/index.ts` | **Consolidated** into `formatLitres` in `lib/format.ts`. Output is identical. (`fuel-stations.tsx` has a different one: no decimals, "—" for 0. Kept.) |
| Month-by-month ledger loops (`addMonths` from the first activity, opening → closing) | `stationLedger`, `tankerLedger`, `inventoryLedger` | **Kept.** Same shape, but opening semantics differ (station opening balance, tanker opening stock, AdBlue legacy opening). Merging them would touch three accounting engines that `check:diesel` pins |
| Period roll-ups (`ledgerFor`, `tankerPeriod`, `stockFor`) | same files | **Kept**, for the same reason |
| Event-order sort (date; inflow before outflow; `createdAt`; `id`) | `domain/tanker.ts`, `domain/adblue-inventory.ts` | **Kept.** Tankers have more ranks (transfers). The proposed SQL views reproduce both orders exactly |
| "Next number after the highest" (`nextSeq`) | `lib/api/index.ts` (payments, trips, invoices) | Kept. One function. The SQL numbering trigger reproduces it for payments |

## 7. Dependencies

Every dependency is imported:

| Package | Used by |
|---|---|
| `react-hook-form`, `@hookform/resolvers`, `zod` | customer, vehicle and trip forms |
| `cmdk` | `components/ui/command.tsx` (searchable selects) |
| `next-themes` | `components/ui/sonner.tsx` |
| `recharts` | dashboard, reports, vehicle charts |
| `shadcn`, `tw-animate-css` | CSS imports in `app/globals.css` |
| `sonner` | toasts (24 files) |
| `class-variance-authority`, `clsx`, `tailwind-merge`, `radix-ui`, `lucide-react` | UI |
| `@tanstack/react-query` | data hooks |
| `date-fns` | dates |
| `@supabase/ssr`, `@supabase/supabase-js` | Supabase foundation, ping script |
| `@electric-sql/pglite` | `check:supabase`, `check:supabase-diesel` |
| `tsx` | checks and scripts |

**Redundant dependencies:** none. **Not done:** `npm audit fix --force` (forbidden by CLAUDE.md).

## 8. Naming inconsistencies (documented, not renamed)

| Concept | Names in use | Why not renamed now |
|---|---|---|
| Fuel station id | `DieselEntry.vendorId`, `TankerLoad.stationId`, `Payment.vendorId`, `AdBlueEntry.vendorId` (legacy), type alias `DieselVendor` | Renaming stored fields breaks every saved browser dataset and backup file. **The Supabase schema uses `station_id` everywhere**, and the repository adapter maps it (migration plan §4) |
| Collection names | API keys `diesel_entries`, storage keys `vt:fuelEntries`, types `DieselEntry` | Storage keys are persistent data. Kept |
| Customer / vehicle routes | `/diesel/[company]` holds a **customer** slug | Changing URLs breaks bookmarks. Kept |
| "Petrol pump" / "diesel vendor" / "fuel station" | comments and UI strings | UI says "Fuel Station" consistently. Older comments remain |

## 9. Poorly organised files (documented)

| File / area | Issue | Recommendation |
|---|---|---|
| `src/lib/api/index.ts` (1,643 lines) | Every service, the restore planner and the audit metadata are in one file | Split per module (`api/fuel.ts`, `api/masters.ts`, `api/audit.ts`…) **when the Supabase adapter is written**: that work touches every method anyway, and splitting now would double the churn |
| `src/features/analytics/charts.tsx` | Shared chart widgets placed under `features/`, which is meant for modules | Move to `components/shared/` in a later UI pass |
| `src/lib/api/test-browser.ts` | Test helper in the production tree | Acceptable (tree-shaken, never imported by pages) |
| Repository root (`../`) | 21 report / plan `.md` files next to CLAUDE.md | Keep for now: CLAUDE.md links them by name. Later: move to `../docs/reports/` and update the links in one pass |

## 10. Performance

| Risk | Where | Impact | Recommendation |
|---|---|---|---|
| Each write re-serialises the **whole** collection to JSON | `writeCollection` | O(n) per write. Fine for demo data. Noticeable with the ~10k-fill FY import | Solved by the database (row writes) |
| The audit log is one localStorage key, re-encoded on every append | `appendAuditEvent` | O(events) per write. Grows without limit | Solved by `audit.events` (append-only table, indexed) |
| `valueTankers` replays every tanker movement on each tanker write and on `diesel.list` when rate-0 fills exist | `assertTankerStock`, `tankerValued` | O(n log n) per call | In the database, the stock check is per affected tanker (window sum over one tanker's rows) |
| `periodsOf` infers assignments from all diesel and AdBlue entries when none are stored | `lib/api/index.ts` | Only for vehicles without assignments (migration case) | No action |
| localStorage quota (~5 MB) | `StorageQuotaError` | A large import can fill it. Writes then fail atomically (old data kept) | The database removes the limit |

## 11. Security and data-integrity risks

| # | Risk | Evidence | Status / mitigation |
|---|---|---|---|
| S-1 | **The role is self-selected** in the header. Anyone at the browser can be Owner | `lib/app-state.ts` (`vt:ui:role`) | Known prototype limit. Real login is Phase 2. The proposed RLS reads the role only from `public.profiles` |
| S-2 | **Reads are not permission-checked** in the API | `api.*.list` | The proposed RLS SELECT policies enforce reads (D-3) |
| S-3 | **Data and audit trail live in one browser**: tamperable with developer tools, per device | `local-store.ts` | The proposed `audit.events` is append-only for every role, including the database owner (trigger), and company-wide |
| S-4 | **Concurrency across tabs:** `tx()` serialises only inside one tab. Two tabs can overdraw stock or reuse a voucher number | CLAUDE.md "Event order" | The proposed schema locks per tanker (`FOR UPDATE`), uses advisory locks (AdBlue, voucher numbers) and deferred stock checks |
| S-5 | `fuelStationPayments.create` doesn't refuse the internal `dv_tanker` source as a payee (`recordTds` does). The UI never offers it | `lib/api/index.ts` (`fuelStationPayments.create`) | **Not changed** (API behaviour is frozen by the brief). The proposed schema refuses it with a composite foreign key |
| S-6 | `api.tankerDispenses.create` still accepts new external dispenses although the UI removed the workflow | `lib/api/index.ts` | Kept for checks and Restore (CLAUDE.md). The proposed schema has no dispense table (D-15) |
| S-7 | Money is rounded in floating point (`round2 = Math.round(n*100)/100`). Exact half-paisa products can round down (e.g. 1.005 → 1.00) | `lib/format.ts` | The proposed schema computes amounts in `NUMERIC` (generated columns). The database value becomes authoritative (D-12) |
| S-8 | Device clock decides "today" and the month lock | CLAUDE.md "Dates" §6 | The proposed schema uses the database clock in Asia/Kolkata (`private.today_ist()`) |
| S-9 | Customer code and vehicle registration are not unique in the API | `api.customers.create`, `api.vehicles.create` | Unique indexes in the proposed schema (D-5) |
| S-10 | `.env.local` held only placeholders. The secret key was never configured | `.env.local` (values not printed) | `SUPABASE_SECRET_KEY` placeholder added (server-only, unused). `.env*` git-ignored, `.env.example` tracked |

## 12. Recommended actions (summary)

1. **Done now:** the removals in §5, the formatter consolidation in §6, stale comments and README fixes, `.env` and `.gitignore` hygiene. Details: `SUPABASE_DIESEL_IMPLEMENTATION_REPORT.md` §2.
2. **With the Supabase adapter:** split `lib/api/index.ts` per module, and map field names to `station_id` in the adapter (§8).
3. **Later UI pass:** move `features/analytics/charts.tsx` into `components/shared/`. Archive the root-level reports under `../docs/reports/`.
4. **Owner decisions:** D-1 … D-17 in `SUPABASE_DIESEL_DATABASE_SCHEMA.md` §12.
