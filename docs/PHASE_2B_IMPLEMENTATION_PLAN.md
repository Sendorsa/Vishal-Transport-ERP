# Phase 2B — Expense and Drivers on the shared database: implementation plan (revision 5)

**Status: plan only — awaiting the owner's review.** Nothing here has been implemented. No SQL was executed, no migration
was created or applied, no application code was changed, no browser data was changed, nothing was imported, deployed,
committed or pushed, and no deleted record was restored.

**Revision 2 (27 Nov 2026)** corrected: (1) SQL dependency order, (2) how the shared engine persists a parent table with a
child table, (3) Expense events leaking through the central Audit Log, (4) duplicate broker payments under concurrency,
(5) reset and deletion safeguards — marked **[R2]**.

**Revision 3 (27 Nov 2026)** corrects: (1) imported timestamps (how `createdAt` / `updatedAt` survive the import, and the
audit time), (2) the duplicate confirmation limited to broker bulk payments, (3) locked months final — no unlock and no
bypass of any kind, (4) idempotency tests, (5) a full consistency review (§12) — marked **[R3]**.

**Revision 4 (27 Nov 2026)** adds: (1) a business-rule enforcement matrix — API, database or both, with every API-only
limitation named (§6.4); (2) Production SQL operational safeguards, expanding R-7 (§8.5), including a section-month lock
**trigger** so the lock also holds for sessions that bypass RLS; (3) import rollback reporting — complete vs partial,
never overstated (§7.6) — marked **[R4]**.

**Revision 5 (27 Nov 2026)** — final clarifications, marked **[R5]**: (1) the fine's Payment Reference follows Phase 1
exactly (optional, also when paid; §2.4, §5.3, §6.4); (2) how the month-lock trigger and the vehicle-count check behave on
`entry_vehicles` for direct child operations and for `ON DELETE CASCADE` (§5.3) with tests T-1.6 – T-1.8; (3) D-15 decided —
the listed rules stay API-only for this release (§11). **Status: still plan only — nothing implemented or tested.**

Inputs: the Phase 1 code (`src/domain/expenses.ts`, `src/domain/drivers.ts`, `src/lib/api/index.ts`,
`src/features/expenses/*`, `src/features/drivers/*`, `src/lib/server/erp/engine.ts` and `tables.ts`, `src/lib/storage/*`,
`src/lib/api/bootstrap.ts`), `docs/PHASE_2A_EXPENSE_DRIVERS_DATABASE_AUDIT.md`, the migrations and Production scripts, and
**the owner's Production inventory of 27 Nov 2026** (§0), which replaces the stale migration notes.

---

## 0. Production as it is (owner's inventory, 27 Nov 2026)

| Item | Production |
|---|---|
| PostgreSQL | **17.11** |
| `expense` schema | does not exist |
| `expenses` permission rows | 0 — Expense is Dev-only (keep) |
| Migrations | applied through `20261122000100`; **`20261127000000_driver_master_company_periods.sql` NOT applied** |
| `module_resource('Expense')` · `('Drivers')` | `audit` · `settings` |
| Companies | VT, VTHPL |
| Customers · vehicles · drivers | 20 · 267 · 13 |
| Vehicles by company | all 267 VTHPL |
| Vehicle assignments | 275 total, 267 open |
| Drivers with DL / DL expiry / phone | none |
| Payment vouchers in ROAD_TAX / INSURANCE | 0 |
| Monthly Sheet Lock rows | 1 |
| Expense audit events | 0 |

Consequences: the dated driver periods, DL-unique index and document alerts are live; only the driver-master migration
is missing. **The repository's application code already reads `core.vehicle_company_periods` and the new driver
columns**, so it must not be deployed before `20261127000000` is applied (§10). No Road Tax / Insurance vouchers exist to
double count. The one Monthly Sheet Lock row cannot affect Expense while it is Dev-only (the Monthly Sheet Lock never
restricts the Owner or Dev).

**PostgreSQL version note [R2]:** the offline checks run on PGlite, which reports **PostgreSQL 18.6**; Production is
**17.11**. Everything in this plan uses features available in 17 (generated stored columns, partial unique indexes,
deferred constraint triggers, `btree_gist`), but the migration must also be run once on a real **PostgreSQL 17** before
Production (§9, test T-1.5; §10 step 3).

## 1. Final table list (six tables)

2A said "eight tables" but listed seven; revision 1 reduced the design to six by mirroring Phase 1's single `expenses`
collection. Approved in principle by the owner.

| # | Table | Purpose | Phase 1 counterpart |
|---|---|---|---|
| 1 | `expense.import_batches` | One row per applied import of a browser backup: label, fingerprint (unique), counts / totals, the file's Expense collections as received. Its per-record outcomes live in table 6. | new — collection `expense_import_batches` [R2] |
| 2 | `expense.import_items` | One row per source record of a batch: outcome and reason. Child of 1. | `ExpenseImportBatch.items[]` [R2] |
| 3 | `expense.brokers` | The broker list (`id`, `name`, unique `name_key`). No status — Phase 1 has no rename / archive / delete. | collection `brokers` |
| 4 | `expense.entries` | One row per Expense entry, all five sections (`section`): Road Tax, Insurance, Fitness, Fines; broker bills (`CHARGE`), bulk payments (`PAYMENT`), opening balances (`BROUGHT_FORWARD`). | collection `expenses` |
| 5 | `expense.entry_vehicles` | The entry's vehicles in order (`entry_id`, `line_no`, `vehicle_id`). Child of 4. | `Expense.vehicleIds[]` |
| 6 | `expense.month_locks` | One row per locked section-month, append-only. | collection `expense_month_locks` |

Plus, already written and unchanged: `core.vehicle_company_periods` and the driver columns (`20261127000000`).

## 2. Phase 1 → Phase 2B compatibility matrix

**Same** = identical behaviour; **Same (enforced twice)** = the API rule stays and the database adds the same rule;
**CHANGE** = different behaviour, listed in §2.10 for approval.

### 2.1 Road Tax

| Phase 1 behaviour | Phase 2B | |
|---|---|---|
| Fields: vehicle (one, from the master, not archived on the date), Transaction Date (≤ today IST), Tax Description (searchable list + Add new description; one spelling per description; the books' six + saved ones), Tax Type (pick or type), validity period optional (both or neither, till ≥ from), Amount Paid (> 0, 2 decimals), **Paying Company (Account Payable) VT/VTHPL required, never taken from the vehicle**, Operating Company (read-only preview), Remarks | `entries` columns + one `entry_vehicles` row; CHECKs: description not blank, `company_code` not null, both-or-neither period, till ≥ from, amount > 0 | Same (enforced twice) |
| `companyConfirmed` set on every save; "Check" flag on older entries | `company_confirmed` | Same |
| `customerId` stamped = the vehicle's customer on the transaction date | `customer_id`, stamped by the same API code | Same |
| Table: Date · Vehicle Number · Customer Company · Type · Tax From · Tax Valid Till · Description · Amount · Paying Company (Check) · Status · Remarks · ✏️/🗑; phone cards | Unchanged UI | Same |
| Filters: Search · Customer Company (customer master; the vehicle's customer on the transaction date, read from the assignment history on display) · All Companies (VT/VTHPL) · Tax Type · All Descriptions · Validity · Date From/To · Reset | Unchanged | Same |
| Validity status calculated on read; cards: Number of Invoices, Total Amount Paid | Unchanged | Same |

### 2.2 Insurance · 2.3 Fitness · 2.4 Fines

| Phase 1 | Phase 2B | |
|---|---|---|
| Insurance: vehicle, Transaction Date, Provider (required), Policy Number, Description, Start / End (required), Premium, Payment Mode, Payment Reference, Paid by (optional, pre-filled from the vehicle), Remarks | Same columns; INSURANCE CHECKs | Same (enforced twice) |
| Fitness: vehicle, Transaction Date, Description, optional period, Amount, Paid by, Remarks | Same | Same |
| Fines: vehicle, Fine Date, **Driver Name** (optional, driver master, no free text, archived only if already on the fine), Fine Type (required), Description (free text as typed), Fine Amount, PAID/UNPAID, Payment Date (required when paid, ≥ fine date, ≤ today), Payment Reference, Remarks; Driver column; search covers the driver | `driver_id` → `core.drivers`; FINE CHECKs | Same (enforced twice) |
| **[R5] Fine Payment Reference — optional, also when PAID.** Verified in the Phase 1 code: the form field has no `required` flag (hint "Challan / receipt / UTR", max 60 characters); `expenseProblems` has no reference rule; `checkExpense` keeps it only when the fine is PAID and saves `""` when UNPAID. | No nonblank requirement anywhere (API or database). The database mirrors only Phase 1's normalisation: `entries_fine` requires `payment_reference = ''` when UNPAID. | Same |
| Each section's table, filters and two cards | Unchanged | Same |

### 2.5 Broker Charges

| Phase 1 | Phase 2B | |
|---|---|---|
| **Add Bill**: Broker Name (list + Add New Broker), Bill Number (optional, unique per broker ignoring case / spaces), Bill Date, Vehicle Number (0/1; older entries several), Description (required), Bill Amount, Remarks | `entry_type='CHARGE'`, `broker_name` (exact), `broker_id`, `bill_no` (+ key, partial unique per broker), `amount > 0` | Same (enforced twice) |
| **Add Payment** (bulk): broker, total outstanding, Payment Date, Amount, Remarks; one record; **no allocation** | `entry_type='PAYMENT'`, `amount = 0`, `paid_amount > 0`; no allocation table | Same |
| Same broker + date + amount as an existing **payment** → **refused** | **[R3]** A retried submission (same request id) returns the saved payment; a *different* payment with the same broker, date and amount asks for explicit confirmation and is then saved (§5.4); overpayment still refused | **CHANGE C-6** (owner's instruction) |
| Bill number unique per broker (case / spaces ignored); no other duplicate rule for bills | Unchanged — partial unique index + API; a retried bill submission (same request id) returns the saved bill; **no confirmation popup** | Same |
| Opening balance: existing ones kept and editable; never created anew; one per broker; dated first | partial unique + deferred "opening first" trigger | Same (enforced twice) |
| An entry keeps its type | API + `BEFORE UPDATE` trigger | Same (enforced twice) |
| Never paid more than billed at any date (same ledger order and broker-name grouping) | API + deferred `private.broker_ledger_guard()` | Same (enforced twice) |
| Older entries keep their broker spelling (even unlisted, or none); older fields (`paymentMode`, `paymentDate`, `purpose`, `operatingCompany`, `vehicleCount`) | `broker_name` exact, `broker_id` nullable; columns kept | Same |
| Table (no ledger section), filters, cards; outstanding calculated, never stored | Unchanged | Same |

### 2.6 Monthly navigation and section-month locks

| Phase 1 | Phase 2B | |
|---|---|---|
| Each section's own month (per browser); months offered = months with records + current IST month; month = the record's `date` | Unchanged | Same |
| Lock Month (confirmation), OPEN/LOCKED, Months list; per section; explicit; no unlock; locked = read-only for every role (create, edit old and new date, delete); future month refused; audited `MONTH_LOCKED` | `expense.month_locks` (PK section + month, append-only); `private.expense_month_open(section, date)` in every write policy **and** the `private.expense_month_lock_guard()` trigger [R4] | Same (enforced twice) |
| **[R3]** No unlock exists | **No unlock mechanism, no Dev-only unlock, no API, import, reset or SQL script that writes, deletes or bypasses a section-month lock** (§6.3) | Same |

### 2.7 Monthly Sheet Lock

| Phase 1 | Phase 2B | |
|---|---|---|
| `assertMonthEditable` also applies to Expense; the Owner and Dev bypass it | API unchanged; write policies also require `private.month_open(date)` | Same (no effect while Dev-only) |

### 2.8 Drivers

| Phase 1 | Phase 2B | |
|---|---|---|
| Driver fields, DL unique, no company typed; dated driver periods; dated vehicle company; deployment derived; Drivers page; pickers | `20261127000000` (prepared) + live driver periods | Same |

### 2.9 Audit, deletion, backup, reset and import

| Phase 1 | Phase 2B | |
|---|---|---|
| Every write audited; DELETED needs a reason; not restorable from the Audit Log | Same; Expense stays out of `RESTORABLE` | Same |
| **Owner and Employee see Expense events (labels, amounts, snapshots) in the central Audit Log** (they hold `audit`) | **Hidden from every role without `expenses`** — database policy, polling function and API (§6.2) | **CHANGE C-8** (owner's instruction) |
| Optimistic concurrency: Expense saves pass `version` | Database backstop; **also when only an entry's vehicles change** (§4) | Same (strengthened) |
| Settings → Data → Download backup includes Expense | Same locally; Dev's shared export includes Expense | Same |
| **[R3]** Records keep their id, `createdAt`, `updatedAt` and business date | Imported rows keep all four exactly (§7.4); the CREATED audit event's `at` is the moment the record entered the shared database | Same |
| **Settings → Clear all data / Restore from file / Load demo data in a browser delete the browser's Expense data** (this caused the 27 Nov loss) | Locally: Expense collections always kept (§8.3); shared database: restore / clear / reset stay refused for the application; SQL reset scripts never touch Expense (§8) | **CHANGE C-7** (owner's instruction) |

### 2.10 Every Phase 2B change that alters Phase 1 behaviour (for approval)

| # | Change | Proposal |
|---|---|---|
| C-1 | "Phase 1 · this browser only" badge, form notice and "Not on the shared database yet" become false on the shared backend. | Hide them on the shared backend; keep them locally. Text only. |
| C-2 | Imported records' history starts with one `CREATED` event whose `at` is the import time (note: "Imported from browser backup '<label>' (batch …) — originally entered <createdAt>, last changed <updatedAt>"); the browser's earlier events are not copied. | The row keeps its original `createdAt` / `updatedAt` (§7.4); the file is kept in the batch. |
| C-3 | The same data on every device (20-second polling); a stale edit is refused. | The purpose of Phase 2. |
| C-4 | "Today" (future dates, locks) is the server's India date, not the device clock. | Removes a Phase 1 limitation. |
| C-5 | The database refuses states Phase 1 storage tolerated on older records (e.g. a Road Tax entry with no company). | Phase 1's save rule already required them; checked by the dry run. |
| **C-6 [R2, R3]** | Broker **payments** only: Phase 1 refused a second payment with the same broker, date and amount; 2B asks for confirmation and then saves it. Every Expense create also gets a request id so a retried submission returns the saved record instead of a second one (no visible change for Road Tax, Insurance, Fitness, Fines or bills). | §5.4. |
| **C-7 [R2, R3]** | Browser Clear all data / Restore / Load demo always keep the browser's Expense collections (no option to clear them). | §8.3. |
| **C-8 [R2]** | Expense audit events hidden from roles without `expenses` (Owner, Employee) in the Audit Log list, detail, history, search, deletion badge, reviews and polling. | §6.2. |

No other behaviour changes: no form field, filter, column, card, calculation, broker rule, lock or permission changes.

## 3. Exact migration sequence and prerequisites

| Step | What | Prerequisite |
|---|---|---|
| 1 | Read-only `24-driver-master-preflight.sql` — every CHECK row OK | `20261121000000` live ✓ |
| 2 | Apply `20261127000000_driver_master_company_periods.sql` (owner's go-ahead) | step 1 |
| 3 | Read-only `25-driver-master-post-apply.sql` — every CHECK OK | step 2 |
| 4 | Read-only `27-expense-preflight.sql` (new) | step 3 |
| 5 | Apply `20261128000000_expense_schema.sql` (new, §5) (owner's go-ahead) | step 4 OK; tested on PostgreSQL 17 |
| 6 | Read-only `28-expense-post-apply.sql` (new) + `10-adblue-vendors-post-apply.sql` rows 10–11 OK + `26-phase2a-inventory.sql` | step 5 |
| 7 | Deploy the matching application | steps 2 and 5 |
| 8 | Import: dry run → review → apply; read-only `29-expense-import-reconciliation.sql` | step 7 |

Never `supabase db push`; each file runs once in the SQL Editor and stops with nothing changed if already applied or out
of order. The reset-script changes (§8) ship with step 7 (scripts are files, not migrations).

**Driver migration checks (steps 1, 3)** — files exist and are tested offline:
`24` CHECK: driver periods, audit, helpers and `btree_gist` present; `20261127000000` not applied; VT and VTHPL present.
INFO (driver audit): drivers by status; with DL / expiry / phone (expected 0/0/0); shared names; shared DLs; recorded
company; vehicles by company (VTHPL 267); default drivers without dated period; dated periods; drivers on both
companies; recorded company ≠ vehicles; trips with unknown driver.
`25` CHECK: `father_name` text NOT NULL, `date_of_birth` date NULL, `address` text NOT NULL; `company_code` nullable; no
driver lost its company; `vehicle_company_periods` empty with its 4 policies, 4 grants, 3 triggers, constraints, open
index, RLS on. INFO: drivers / vehicles / periods unchanged. Additive only; rollback in the file header.

## 4. Persistence of `entries` + `entry_vehicles` through the shared engine **[R2]**

### 4.1 What the engine actually does (inspected)

`src/lib/server/erp/engine.ts` (`runInDatabase`, `persist`) and `tables.ts` (`SPECS`, `WRITE_ORDER`, `applyUpserts`,
`applyDeletes`, `insertRow`, `updateRow`, `deleteRow`):

1. **One request = one PostgreSQL transaction** (`transact`), run as `authenticated` with the user's claims (RLS on every
   statement), with `pg_advisory_xact_lock(hashtext('vishal-erp:write'))` taken **before** loading — writes are serialised.
2. The `api.*` method runs on an in-memory copy; collections load on demand (`NeedData`), loaded under RLS.
3. `persist`: for the collections the method wrote **that are listed in `WRITE_ORDER`** — deletes in reverse order
   (`applyDeletes` → `deleteRow … where id = $1 and updated_at = $version`), then upserts in order (`applyUpserts`:
   updates first — `updateRow … where id and updated_at = $version` — then inserts), each followed by the spec's
   `afterUpdate` / `afterInsert` **on the same transaction**; then `insertEvents` (the audit events); then COMMIT, where
   every deferred constraint trigger (audit presence, stock, ledger guards) runs. Any error → the whole transaction rolls
   back.
4. **Parent + child rows are already supported per spec**: `vehicles` writes `vehicle_driver_periods`,
   `vehicle_company_periods`, status periods and alert history in `afterInsert` / `afterUpdate`; `tyre_invoices` writes
   its lines; child rows are deleted with the parent through `on delete cascade`.

Two facts that matter for Expense:

- **`WRITE_ORDER` does not contain `expenses`, `brokers` or `expense_month_locks`.** `persist` would silently skip their
  writes (today `assertLocalExpenses` stops them first). Adding the specs alone would **not** work.
- `applyUpserts` updates a parent row (and so checks its version and bumps `updated_at`) **only when one of its own
  columns changed**. A change to an entry's vehicles only would skip the version check and leave `updated_at` unchanged —
  a lost-update risk if two screens edit the same entry.

### 4.2 Options evaluated

| | (a) Dedicated Expense persistence adapter (own write path, bypassing `applyUpserts`) | (b) Generic declarative child-table extension of `Spec` (engine writes any declared children) | (c) **Chosen**: the existing spec hooks + two small, explicit additions in `tables.ts` |
|---|---|---|---|
| Atomicity | must re-implement transaction placement, ordering, refusal mapping | same transaction | same transaction (unchanged engine) |
| Audit | must re-implement event ordering | unchanged | unchanged |
| Optimistic concurrency | own implementation | needs a new rule for child-only changes for every module | per spec (§4.3) |
| Impact on other modules | none directly, but a second write path to maintain and test | **every existing spec** would be migrated or two child mechanisms would coexist | **none** — existing entries of `WRITE_ORDER` keep their order; no existing spec changes |
| Verdict | rejected (duplication, divergence risk) | rejected (refactor of shared code, no business need) | **chosen** |

### 4.3 The chosen design

Shared-file changes (and only these):

- **`tables.ts` — `WRITE_ORDER`**: append, after every existing key, in FK order:
  `"expense_import_batches", "brokers", "expenses", "expense_month_locks"`. Deletes run in reverse (locks, entries,
  brokers, batches); existing keys keep their positions, so no other module's order changes.
- **`tables.ts` — `SPECS`**: replace the three `{ table: null }` placeholders with real specs; add
  `expense_import_batches`.
- **`engine.ts` — `KEY`**: add `expense_import_batches: "vt:expenseImportBatches"` (one line; the other Expense keys
  already exist). `persist` and `runInDatabase` are **not** changed.
- `src/lib/types.ts`, `local-store.ts`, `seed.ts`: the new collection type `ExpenseImportBatch` (with `items[]`), empty on
  the browser backend (shared files; affected modules: Expense only).

`expenses` spec (table `expense.entries`):

- `load`: `select … from expense.entries` + `select entry_id, line_no, vehicle_id from expense.entry_vehicles order by
  entry_id, line_no` → `vehicleIds` in `line_no` order. Under RLS a non-Dev loads nothing.
- `cols(x)`: every column, **including `updated_at: x.updatedAt`, `request_id: x.requestId ?? null` and
  `import_batch_id: x.importBatchId ?? null`**. Because the API sets a new `updatedAt` on every edit, `updated_at` is
  always in the diff, so **every edit — even one that changes only the vehicles — runs `updateRow … where updated_at =
  $loaded`**: the version check always happens; the `touch_updated_at` trigger (BEFORE UPDATE only) then sets the real
  timestamp.
- **Inserts and timestamps [R3]** — `applyUpserts` calls `insertRow(sql, spec.table, { ...spec.cols(r), created_at:
  r.createdAt })` (inspected: it never uses the database default for `created_at`; it writes the record's own value).
  With `updated_at` in `cols`, an insert writes **both** timestamps exactly as the in-memory record holds them, and no
  trigger touches them on insert. So the only question is what the in-memory record holds:
  - a normal create goes through `repository.create`, which assigns a new id and `createdAt = updatedAt = now` (correct
    for a new entry);
  - **the import never calls `repository.create`**: it appends each source record **as it is** (`writeCollection`), the
    same exact-record path the Audit Log's Restore already uses (`restoreDeleted` → `writeCollection(plan.key, [...,
    plan.record])`), so id, `createdAt`, `updatedAt` and `date` reach `insertRow` unchanged (§7.4).
- Type additions (shared `src/lib/types.ts`, Expense only): `Expense.requestId?: string | null` and
  `Expense.importBatchId?: string | null` — never shown in the UI; `ExpenseImportBatch` (with `items[]`).
- `afterInsert(x)`: insert `entry_vehicles` rows `(x.id, i, vehicleIds[i])` in order.
- `afterUpdate(before, after)`: if `vehicleIds` differ (as an ordered list), `delete from expense.entry_vehicles where
  entry_id = $1` then insert the new list in order; **0 rows affected where rows were expected → refused** (RLS), as
  `syncDrivers` does.
- Delete: `applyDeletes` → `deleteRow` on `entries`; `entry_vehicles` go with it by `on delete cascade` in the same
  statement.
- Audit: the parent's CREATED / UPDATED / DELETED event is inserted after the rows in the same transaction;
  `require_parent_audit_event('id')` on `entries` and `('entry_id')` on `entry_vehicles` are checked at COMMIT.

`brokers` spec: `expense.brokers`, `cols` = `id`, `name`, `updated_at`; no deletes (Phase 1 has none; `applyDeletes`
refuses). `expense_month_locks` spec: `expense.month_locks`, insert only; `locked_by` from the verified session (as
`month_locks.changed_by`). `expense_import_batches` spec: `expense.import_batches`; `afterInsert` writes its
`import_items`; never updated or deleted by the application.

Guarantees: atomic (one transaction; a failing child insert, RLS refusal, CHECK or deferred trigger rolls back the
parent and its audit event); ordered vehicles (`line_no`); optimistic concurrency on every edit; rollback = the
transaction's own. **The shared engine's code paths are unchanged; `tables.ts` and the `KEY` map in `engine.ts` do
change** (additions only), and `check:erp-db` / `check:erp-fields` re-run every module to prove nothing else moved.

## 5. Expense migration — SQL design, dependency order and rollback **[R2]**

File `supabase/migrations/20261128000000_expense_schema.sql` — one transaction; guards first.

### 5.1 Guards (stop, nothing changed)

Prerequisites present: `core.vehicles`, `core.customers`, `core.drivers`, `core.companies`, `core.vehicle_company_periods`
(driver migration first), `audit.events`, `audit.reviews`, `public.profiles`, functions `private.require_parent_audit_event()`,
`private.touch_updated_at()`, `private.can(text,text)`, `private.month_open(date)`, `private.today_ist()`,
`private.new_id(text)`, `private.erp_role()`, `private.is_dev()`, `private.current_profile_id()`,
`private.changed_modules(timestamptz)`, `private.module_resource(text)`. `expense` schema absent. No `role_permissions`
row like `expenses%`. Fingerprints (md5 of `prosrc`) of `private.changed_modules` and `private.module_resource` equal the
repository's current text (so the replacements below start from what is really there).

### 5.2 Exact creation order (every object exists before anything references it)

1. `create schema expense;` (+ comment).
2. Types: `expense.section` ('ROAD_TAX','INSURANCE','FITNESS','FINE','BROKER');
   `expense.broker_entry_type` ('CHARGE','PAYMENT','BROUGHT_FORWARD') — the Phase 1 names.
3. **`expense.import_batches`** — references only `public.profiles`.
4. **`expense.import_items`** — `batch_id` → `import_batches` (on delete cascade).
5. **`expense.brokers`** — no references.
6. **`expense.entries`** — references `core.customers`, `core.companies`, `core.drivers`, `expense.brokers`,
   `expense.import_batches` (all created above).
7. **`expense.entry_vehicles`** — `entry_id` → `entries` (on delete cascade), `vehicle_id` → `core.vehicles`.
8. **`expense.month_locks`** — references `public.profiles`.
9. Indexes and partial unique indexes (after their tables).
10. Functions: `private.expense_month_open`, `private.expense_month_lock_guard` [R4], `private.broker_ledger_guard`, `private.broker_opening_first`, `private.entry_vehicle_count`,
    `private.expense_entry_fixed`, `private.expense_not_future`.
11. Triggers (after functions): touch, audit presence, the guards.
12. `alter table … enable row level security`, grants, policies (after the functions they call).
13. Replace `private.module_resource` (adds `Expense` → `expenses`), `private.changed_modules` and the
    `audit.events` / `audit.reviews` read policies (§6.2) — last, once `expenses` exists as a concept in the schema.

### 5.3 Table definitions (PostgreSQL 17)

```sql
create table expense.import_batches (
  id text primary key default private.new_id('imp'),
  source_label text not null check (btrim(source_label) <> ''),
  source_fingerprint text not null unique check (source_fingerprint ~ '^[0-9a-f]{64}$'),
  exported_at timestamptz,
  summary jsonb not null check (jsonb_typeof(summary) = 'object'),
  source_snapshot jsonb not null check (jsonb_typeof(source_snapshot) = 'object'),
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp());

create table expense.import_items (
  batch_id text not null references expense.import_batches (id) on delete cascade,
  source_collection text not null check (source_collection in ('expenses', 'brokers', 'expense_month_locks')),
  source_id text not null check (btrim(source_id) <> ''),
  outcome text not null check (outcome in ('IMPORTED', 'ALREADY_PRESENT', 'CONFLICT', 'REJECTED', 'SKIPPED')),
  target_id text,
  reason text not null default '',
  primary key (batch_id, source_collection, source_id));

create table expense.brokers (
  id text primary key default private.new_id('brk'),
  name text not null check (btrim(name) <> ''),
  name_key text generated always as (upper(btrim(regexp_replace(name, '\s+', ' ', 'g')))) stored,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint brokers_name_key unique (name_key));

create table expense.entries (
  id text primary key default private.new_id('exp'),
  section expense.section not null,
  date date not null,
  customer_id text references core.customers (id),
  company_code text references core.companies (code),
  company_confirmed boolean not null default false,
  description text not null default '',
  description_key text generated always as (upper(btrim(regexp_replace(description, '\s+', ' ', 'g')))) stored,
  amount numeric(14, 2) not null default 0 check (amount >= 0),
  remarks text not null default '',
  valid_from date,
  valid_till date,
  tax_type text not null default '',
  provider text not null default '',
  policy_no text not null default '',
  payment_mode text not null default '',
  payment_reference text not null default '',
  payment_status text check (payment_status in ('PAID', 'UNPAID')),
  payment_date date,
  driver_id text references core.drivers (id),
  entry_type expense.broker_entry_type,
  broker_name text not null default '',
  broker_key text generated always as (upper(btrim(regexp_replace(broker_name, '\s+', ' ', 'g')))) stored,
  broker_id text references expense.brokers (id),
  bill_no text not null default '',
  bill_no_key text generated always as (upper(btrim(regexp_replace(bill_no, '\s+', ' ', 'g')))) stored,
  purpose text not null default '',
  operating_company text not null default '',
  vehicle_count integer not null default 0 check (vehicle_count >= 0),
  paid_amount numeric(14, 2) not null default 0 check (paid_amount >= 0),
  request_id uuid,                                        -- idempotency key (§5.4); null on imported / older rows
  import_batch_id text references expense.import_batches (id),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint entries_request_id_key unique (request_id),
  constraint entries_period check ((valid_from is null) = (valid_till is null) and (valid_till is null or valid_till >= valid_from)),
  constraint entries_road_tax check (section <> 'ROAD_TAX' or (company_code is not null and btrim(description) <> '' and amount > 0)),
  constraint entries_insurance check (section <> 'INSURANCE' or (valid_from is not null and btrim(provider) <> '' and amount > 0)),
  constraint entries_fitness check (section <> 'FITNESS' or amount > 0),
  constraint entries_fine check (section <> 'FINE' or (btrim(tax_type) <> '' and payment_status is not null and amount > 0
    and (payment_status = 'PAID') = (payment_date is not null) and (payment_date is null or payment_date >= date)
    and (payment_status = 'PAID' or payment_reference = ''))),   -- [R5] reference optional when PAID; cleared when UNPAID (Phase 1)
  constraint entries_driver_only_fines check (section = 'FINE' or driver_id is null),
  constraint entries_broker_type check ((section = 'BROKER') = (entry_type is not null)),
  constraint entries_broker check (section <> 'BROKER' or
       (entry_type = 'CHARGE' and amount > 0 and paid_amount <= amount and btrim(description) <> '')
    or (entry_type = 'PAYMENT' and amount = 0 and paid_amount > 0)
    or (entry_type = 'BROUGHT_FORWARD' and amount > 0 and paid_amount = 0)),
  constraint entries_not_broker check (section = 'BROKER' or (broker_name = '' and broker_id is null and bill_no = '' and paid_amount = 0)),
  constraint entries_broker_named check (broker_id is null or broker_name <> ''));
create index entries_section_date_idx on expense.entries (section, date);
create index entries_description_idx on expense.entries (section, description_key);
create index entries_customer_idx on expense.entries (customer_id, date) where customer_id is not null;
create index entries_driver_idx on expense.entries (driver_id) where driver_id is not null;
create index entries_broker_idx on expense.entries (broker_key, date) where section = 'BROKER';
create unique index entries_bill_no_key on expense.entries (broker_key, bill_no_key) where entry_type = 'CHARGE' and bill_no_key <> '';
create unique index entries_one_opening on expense.entries (broker_key) where entry_type = 'BROUGHT_FORWARD';

create table expense.entry_vehicles (
  entry_id text not null references expense.entries (id) on delete cascade,
  line_no integer not null check (line_no >= 0),
  vehicle_id text not null references core.vehicles (id),
  primary key (entry_id, line_no),
  constraint entry_vehicles_once unique (entry_id, vehicle_id));
create index entry_vehicles_vehicle_idx on expense.entry_vehicles (vehicle_id);

create table expense.month_locks (
  id text not null default private.new_id('eml'),
  section expense.section not null,
  month text not null check (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  locked_by uuid references public.profiles (id),
  locked_by_role public.erp_role,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (section, month),
  constraint month_locks_id_key unique (id));
```

All functions and triggers (step 10–11):

- `private.expense_month_open(p_section expense.section, p_date date) returns boolean` — stable, security definer,
  `search_path = ''`: `not exists (select 1 from expense.month_locks where section = p_section and month = to_char(p_date, 'YYYY-MM'))`.
- `private.broker_ledger_guard()` — deferred constraint trigger, `after insert or update or delete on expense.entries for
  each row` (BROKER rows): for the old and new `broker_key`, walk the broker's rows ordered by
  `date, case entry_type when 'BROUGHT_FORWARD' then 0 when 'CHARGE' then 1 else 2 end, created_at, id collate "C"` with
  running Σ(`amount − paid_amount`) and raise `'This would leave % paid ₹% more than billed on %. Nothing was saved.'`
  if it ever falls below −0.005. (Security definer, so a role that can't see every row is still checked against all.)
- `private.broker_opening_first()` — deferred: a broker's `BROUGHT_FORWARD` is dated on or before all its other rows.
- `private.entry_vehicle_count()` — deferred, on `entries` (insert/update) and `entry_vehicles` (insert/update/delete):
  ROAD_TAX / INSURANCE / FITNESS / FINE entries have exactly one `entry_vehicles` row. **[R5]** It checks the entry
  **as it exists at COMMIT**: if the entry no longer exists (it was deleted — its child rows went with it by cascade),
  there is nothing to check and it passes; it never treats a deleted entry as "an entry with zero vehicles".
- `private.expense_entry_fixed()` — `before update on entries`: `section` and `entry_type` never change.
- `private.expense_not_future()` — `before insert or update on entries`: `date` and `payment_date` ≤ `private.today_ist()`.
- **`private.expense_month_lock_guard()` [R4, R5]** — security definer, `search_path = ''`, **no exemption for any role
  or for a session without an ERP role** (unlike the existing child-row delete guards), so it also refuses writes from
  sessions that bypass RLS (the SQL Editor's owner role, `service_role`). Together with the RLS policies, the lock is
  enforced twice in the database. Two triggers use it:
  - **On `entries`** (`before insert or update or delete`, for each row): INSERT checks the new `section` / `date`;
    UPDATE checks the old **and** the new `section` / `date`; DELETE checks the old. Locked → raise "<Month> is locked in
    <Section> — its records are read-only". A refused parent DELETE stops the statement **before** the row is removed, so
    no cascade to `entry_vehicles` happens.
  - **On `entry_vehicles`** (`before insert or update or delete`, for each row): looks up the parent entry
    (`select section, date from expense.entries where id = coalesce(new.entry_id, old.entry_id)`) and applies the same
    check to it; on UPDATE also to the old parent if `entry_id` changed.
    - **Direct child operation** (insert a vehicle line, change it, delete it — e.g. an edit that replaces the vehicles):
      the parent exists (the foreign key guarantees a child row always has one), so the parent's section-month lock is
      checked — **locked → refused**, with the same message. No weakening for direct child operations.
    - **Cascaded deletion** (`ON DELETE CASCADE` from a parent DELETE): PostgreSQL removes the parent row first and then
      deletes the children through the foreign key's action, so when the child trigger runs, the parent row is **no longer
      visible**. The trigger treats "parent not found **during a DELETE**" as a cascade and allows it — the parent's own
      trigger already checked (and, if locked, refused) that same deletion before anything was removed. "Parent not found"
      during an INSERT or UPDATE of a child is impossible with the foreign key in place, and the trigger raises in that
      case rather than allowing it.
    - Why this is safe: a child row whose parent is missing can only arise inside the cascade of that parent's deletion
      (the foreign key is enforced and not deferrable); so "parent missing on child DELETE" ⇔ "the parent's DELETE was
      already allowed by the lock check". Disabling triggers or the foreign key is outside the database's protection
      (§8.5).
- `touch_updated_at` on all six tables; `require_parent_audit_event('id')` on `import_batches`, `brokers`, `entries`,
  `month_locks`; `require_parent_audit_event('batch_id')` on `import_items`; `('entry_id')` on `entry_vehicles`.

### 5.4 Idempotency (every create) and duplicate confirmation (broker payments only) **[R2, R3]**

**The key.** Every Expense create carries a `requestId` (UUID v4) generated when its form opens (each section's Add dialog,
Add Bill, Add Payment); the same key is re-sent on every retry of that submission; a new key is made only after a
successful save or when the form is reopened. Stored in `entries.request_id` (unique; null on imported and older rows).
Local backend: `Expense.requestId`, same rules. Edits don't use it (they use the record version).

**Order of checks in `api.expenses.create`** (one transaction, under the write lock):

1. **Request id already used** (a row with this `requestId` exists):
   - same content → return that row; **no new row, no audit event, no confirmation** — whatever the section, and even if
     the call carries `confirmSameDay` (a consumed key can never create a second record);
   - different content → refused: "This request was already saved with different values — reopen the form." Nothing
     written.
2. **Phase 1 validation** (unchanged): fields, month locks, Monthly Sheet Lock, vehicles, broker list, bill number unique
   per broker, opening balance rules, **no overpayment at any date**.
3. **Broker bulk payments only** — a payment with the same broker (name key), date and amount already exists and the call
   doesn't carry `confirmSameDay: true` → `PossibleDuplicateError` (the class the Audit Log's restore already uses): "A
   payment of ₹X to <broker> on <date> is already recorded. Record another payment?". Nothing written, key **not**
   consumed. On **Record another**, the form re-sends the **same** key with `confirmSameDay: true` → saved (step 2's
   overpayment check still applies — a confirmed payment that would overpay is refused).
4. Insert entry + `entry_vehicles` + CREATED audit event; COMMIT runs the deferred guards.

Road Tax, Insurance, Fitness, Fines and **broker bills never get a confirmation popup**: a different key follows the Phase 1
rules exactly (for bills: the bill-number uniqueness rule).

**Guarantees.** Writes are serialised (`pg_advisory_xact_lock`), so a retry or a simultaneous request with the same key
sees the first one's committed row; if anything ever bypassed the lock, `entries_request_id_key` (unique) makes the
second transaction fail with 23505, which the API maps (after reloading) to step 1's answer. A failure anywhere leaves
nothing. The database ledger guard refuses any overpayment regardless of confirmation.

### 5.5 Rollback

- **Before any import:** one transaction — restore the previous `private.module_resource` and `private.changed_modules`
  bodies and the previous `audit.events` / `audit.reviews` read policies (their exact text is copied into the file header),
  then `drop schema expense cascade` and drop the `private.expense_*` / `private.broker_*` / `private.entry_*` functions.
  The guards' fingerprint check (§5.1) is what makes the "previous text" reliable.
- **After an import:** only with the owner's approval and after `02-backup-business-data.sql` (now including Expense) —
  the Mac's browser still holds the source data, untouched. Dropping the schema after data exists is **not** part of any
  plan (it would bypass section-month locks); see §7.6.
- **Application:** redeploy the previous build; the previous build never reads the `expense` schema.

## 6. RLS and permissions **[R2]**

### 6.1 Expense tables

`private.can('expenses', …)` is true for **DEV only** (`*`); no `role_permissions` row is added. The API keeps every check
(`assertCan`, `UNRELEASED`, route gate, `NoAccess`).

| Object · action | DEV | OWNER | EMPLOYEE | TATA_ADBLUE / ADBLUE |
|---|---|---|---|---|
| `entries` SELECT | ✓ | ✗ | ✗ | ✗ |
| `entries` INSERT: `can('expenses','create')` ∧ `expense_month_open(section,date)` ∧ `month_open(date)` | ✓ | ✗ | ✗ | ✗ |
| `entries` UPDATE: USING `can('expenses','edit')` ∧ open(old) — WITH CHECK open(new) | ✓ | ✗ | ✗ | ✗ |
| `entries` DELETE: `can('expenses','delete')` ∧ open(section,date) | ✓ | ✗ | ✗ | ✗ |
| Broker bulk payment = `entries` INSERT (PAYMENT) + ledger guard + request id | ✓ | ✗ | ✗ | ✗ |
| `entry_vehicles` SELECT / INSERT / DELETE — `exists` parent visible and writable (same open checks via the parent) | ✓ | ✗ | ✗ | ✗ |
| `brokers` SELECT / INSERT (`expenses:view/create`); **no UPDATE or DELETE policy or grant** (Phase 1 has no broker rename / delete) **[R3]** | ✓ | ✗ | ✗ | ✗ |
| `month_locks` SELECT; INSERT (`expenses:edit`, `month ≤ current IST month`, `locked_by_role = erp_role()`); no UPDATE / DELETE | ✓ | ✗ | ✗ | ✗ |
| `import_batches`, `import_items` SELECT / INSERT — `private.is_dev()`; no UPDATE / DELETE | ✓ | ✗ | ✗ | ✗ |
| `core.drivers` read (existing) | ✓ | ✓ | ✓ | ✓ (diesel view) |
| `core.drivers` add / edit (existing: settings:edit or vehicles:edit) | ✓ | ✓ | ✓ | ✗ |
| driver / company periods add · close · same-day undo | ✓ | ✓ | ✓ | ✗ |
| driver / company periods older history change / delete | ✓ | ✓ | ✗ | ✗ |

Grants: `select, insert, update, delete` to `authenticated` only where a policy needs it (`brokers`, `month_locks`,
`import_*`: select + insert only; `entry_vehicles`: select + insert + delete); `service_role` all; nothing to `anon`.

### 6.2 Audit Log restriction for Expense (module-specific) **[R2]**

Goal: Owner, Employee and every other role without `expenses` see **no** Expense event, snapshot, amount or label anywhere,
while their access to every other module's events is unchanged. Four layers:

1. **Database — `audit.events` read policy** (replaces "Read audit events"):
   `using ((select private.can('audit', 'view')) and (module <> 'Expense' or (select private.can('expenses', 'view'))))`.
   Insert policies unchanged (a session can't write Expense events without `expenses` anyway — the API refuses first).
2. **Database — `audit.reviews` read policy** (replaces "Owner and Dev read reviews"):
   `using ((select private.can('audit', 'view')) and exists (select 1 from audit.events e where e.id = event_id))` — the
   inner select runs under the events policy, so a review of an Expense deletion is invisible too. The reviews insert
   policy also requires the event to be visible (`exists …`), so no role can mark an Expense deletion it can't see.
3. **Database — `private.changed_modules(since)`** (security definer — it bypasses RLS, so it must filter itself): add
   `and (e.module <> 'Expense' or private.can('expenses', 'view'))`. Polling then never tells an Owner or Employee that
   Expense changed.
4. **API (both backends)** — one helper `visibleEvents()` = `readAuditEvents()` without `module = 'Expense'` events unless
   `can(role, 'expenses')`, used by **every** audit read: `audit.list` (Audit Log list, its search, module and role
   filters, CSV / detail drawer), `audit.history(recordId)` (already filters by `MODULE_RESOURCE`, now also through the
   helper), `audit.unreviewedDeletions` (the badge), `audit.markReviewed`, `audit.checkRestore` / `restore`, `editedIds`
   (Edited badges). On the shared backend the database has already removed them; the helper makes the browser backend
   behave the same and is a second barrier. The Audit Log's module filter options are derived from visible events, so
   "Expense" is not offered.

`module_resource('Expense')` becomes `expenses` (record history and polling use it); `module_resource('Drivers')` stays
`settings` (changing it would have no visible effect for any current role).

### 6.3 Locked section-months — final **[R3]**

- **No unlock mechanism** of any kind: no Dev-only unlock, no API method, no UI, no SQL script.
- `expense.month_locks`: INSERT only; no UPDATE / DELETE policy and no UPDATE / DELETE grant to `authenticated`; no
  security-definer function writes, deletes or ignores a lock row; `private.expense_month_open` has no role exemption
  (unlike the Monthly Sheet Lock, Dev is not exempt).
- No exception path: the import rejects records for a section-month locked centrally (§7.2); the reset scripts never
  touch Expense (§8); there is no Expense reset script (§8.4); an import is never undone in a locked month (§7.6).
- Locked months stay readable for every role that can read Expense (Dev).
- **[R4]** Sessions that bypass RLS (the SQL Editor's owner role, `service_role`) are still refused by
  `private.expense_month_lock_guard()` (a trigger, not a policy). What **no** database rule can stop is the database
  owner deliberately disabling triggers (`alter table … disable trigger`, `set session_replication_role = replica`) or
  dropping objects — that is governed by the operational safeguards in §8.5, not by RLS.

### 6.4 Business-rule enforcement matrix **[R4]**

"Database" means a constraint, trigger or policy **defined in this plan's migrations** (or already live) — listed by name.
RLS policies don't apply to the database owner; constraints and triggers do unless the owner disables them (§8.5).
Where a rule is **API only**, the limitation is stated.

| Rule | API (both backends) | Database (shared backend) | Enforced by | Limitation |
|---|---|---|---|---|
| Vehicle exists | `assertOpen` (vehicle from the master) | FK `entry_vehicles.vehicle_id → core.vehicles` | **Both** | — |
| Vehicle **not archived on the transaction date** | `assertOpen(vehicle, null, date)` (status history on the date) | — | **API only** | A direct SQL write could reference a vehicle archived on that date; no trigger reads `core.vehicle_status_periods`. |
| Exactly one vehicle for Road Tax / Insurance / Fitness / Fines | `expenseProblems` | deferred `private.entry_vehicle_count()` | **Both** | — |
| **Customer = the vehicle's assignment on the transaction date** | `checkExpense` stamps `customerId` from `assignmentOn`; the Road Tax filter re-reads the assignment history on display | FK `customer_id → core.customers` (existence only) | **API only** (correspondence) | The database doesn't check that `customer_id` matches `core.vehicle_assignments` on `date`; a direct SQL write could store another customer. The Road Tax Customer Company filter and column don't rely on the stored value (they re-read the history). |
| Driver exists, only on fines | `checkExpense` (driver from the master) | FK `driver_id → core.drivers`; CHECK `entries_driver_only_fines` | **Both** | — |
| **[R5]** Fine Payment Reference: **optional** (also when PAID); blank when UNPAID | `checkExpense` (kept only when PAID) — no nonblank rule, as Phase 1 | CHECK `entries_fine` (`payment_status = 'PAID' or payment_reference = ''`) | **Both** (blank when unpaid) · **neither** requires it when paid | By design (Phase 1 behaviour). |
| **Archived driver**: not for a new fine; kept on a fine that already has it | `checkExpense` (`prior.driverId`) | — | **API only** | A direct SQL write could put an archived driver on a fine. |
| **Vehicle company from dated history** | `withCompanyChange` (effective date, not future, never before the last change; current company = the last period); deployment derived on read (`companyOn`, `driverDeployments`) | `core.vehicle_company_periods`: no-overlap exclusion, one open period per vehicle, end ≥ start, audit trigger, RLS (close / same-day only) | **Both** (period integrity) · **API only** (rules below) | The database doesn't check that `core.vehicles.company_code` equals the open period's company, nor "never before the last change"; deployment is calculated, not stored. Expense records don't use vehicle company. |
| **Paying Company for Road Tax** — present and valid | `expenseProblems` (required) | CHECK `entries_road_tax` (`company_code is not null`), FK `→ core.companies` | **Both** | — |
| Paying Company **explicitly chosen** (never inferred from the vehicle) | the form never pre-fills it for Road Tax; `companyConfirmed = true` set on save | — | **API / UI only** | The database can't tell a chosen value from an inferred one; `company_confirmed` is set by the API. |
| Broker bill-number unique per broker (case / spaces ignored) | `checkExpense` | unique index `entries_bill_no_key` (`broker_key`, `bill_no_key`) where CHARGE and non-blank | **Both** | — |
| Broker named from the list (new entries) | `checkExpense` (list spelling; older spelling kept) | FK `broker_id → expense.brokers` when set; CHECK `entries_broker_named` | **Both** (when `broker_id` is set) · **API only** (that a *new* entry has one) | `broker_id` stays nullable for older unlisted / blank names (Phase 1), so the database can't require it on new entries. |
| One opening balance per broker, dated first | `checkExpense` | unique index `entries_one_opening`; deferred `private.broker_opening_first()` | **Both** | — |
| **Broker never overpaid at any date** (ledger) | `assertBrokerLedger` / `firstOverpayment` | deferred `private.broker_ledger_guard()` | **Both** | — |
| Second identical broker payment needs confirmation | `PossibleDuplicateError` + `confirmSameDay` | — | **API only** | Intentional: a genuine identical payment is valid data. |
| Request id used once | `api.expenses.create` look-up | unique `entries_request_id_key` | **Both** | — |
| **Section-month locks** (create, edit old / new date, delete; locks append-only) | `assertExpenseMonthOpen` | RLS policies (`expense_month_open`) **and** trigger `private.expense_month_lock_guard()` on `entries` and on `entry_vehicles` (direct child operations checked against the parent; cascaded child deletion follows the parent's own check) [R4, R5]; `month_locks`: insert-only policy, no update / delete grant | **Both** | Only a deliberate trigger disable / object drop by the database owner defeats it (§8.5). |
| **Monthly Sheet Lock** | `assertMonthEditable` (Owner / Dev bypass) | RLS policies call `private.month_open(date)` (Owner / Dev bypass) | **Both** (sessions under RLS) | Not a trigger: the SQL Editor's owner role bypasses it, as for every other module today. No effect while Expense is Dev-only. |
| **Record type immutability** (`section`, `entry_type`) | `api.expenses.update` | trigger `private.expense_entry_fixed()` | **Both** | — |
| No future business date | `expenseProblems` | trigger `private.expense_not_future()` (server IST date) | **Both** | — |
| Section field rules (required fields, periods, amounts, payment status ↔ date) | `expenseProblems` | CHECKs `entries_period`, `entries_road_tax`, `entries_insurance`, `entries_fitness`, `entries_fine`, `entries_broker*`, `entries_not_broker` | **Both** | Amounts: `numeric(14,2)` **rounds** a third decimal instead of refusing it — the API refuses it. |
| **Optimistic concurrency** | `assertVersion` against the version loaded under the write lock | the engine's guarded statements `update … where id and updated_at = $loaded` / `delete … where …` (`updateRow`, `deleteRow`); `updated_at` maintained by `touch_updated_at` | **Both** (engine SQL guard) | The database itself has **no constraint** for versions: the guard is the WHERE clause the engine sends. A direct SQL update bypasses it. |
| Audit event for every change | `audit(...)` | deferred `require_parent_audit_event` on all six tables (no role exemption) | **Both** | Defeated only by the owner disabling triggers. |
| Delete needs a reason | `assertReason` | CHECK on `audit.events` (DELETED reason ≥ 3) + the audit-presence trigger | **Both** | — |
| Expense Dev-only | `can` / `assertCan` / `UNRELEASED` / route gate | RLS (`private.can('expenses', …)`, no `role_permissions` row) | **Both** | RLS doesn't apply to the database owner. |
| Expense audit events hidden from roles without `expenses` | `visibleEvents()` | `audit.events` / `audit.reviews` read policies; `private.changed_modules` filter | **Both** | RLS doesn't apply to the database owner. |
| One description spelling (Road Tax) | `checkExpense` | generated `description_key` (index only) | **API only** | Two spellings could be inserted by direct SQL; filters still group by the key. |

## 7. Import: dry run, conflicts, reconciliation, rollback **[R2]**

**Source: only the Mac's current browser** (owner's decision). Only its backup file is read; only `expenses`, `brokers`
and `expense_month_locks` are imported. Drivers, vehicles, customers and assignments in the file are read for checks only
— **never written**. The browser audit log is not part of the backup and is never read, so **the eight records deleted on
27 Nov can't be imported**; additionally any id that appears in a central DELETED event is rejected.

### 7.1 Export
On the Mac (local backend, `127.0.0.1:3000`): Settings → Data → Download backup (existing). Nothing in the browser
changes. With C-7, a later accidental Clear in that browser no longer deletes its Expense data.

### 7.2 Dry run (Dev only, shared backend: Settings → Data → *Import Expense data*; writes nothing)
- **Fingerprint** — sha256 of the three collections (canonical JSON, sorted keys and ids). Already applied → "this file
  was imported on … (batch …)".
- **Per record** — *new* (imported with its own id, `createdAt`, `updatedAt`, `date`) · *already present* (same id,
  identical content after the same normalisation the import applies — broker id mapping and the recomputed Customer
  Company — → skipped; safe retry) · *conflict* (same id, different content → never overwritten; both versions shown) ·
  *rejected* (vehicle / customer / driver id not in the central master; a value the database would refuse; > 2 decimals;
  future date; broker name in neither the file's nor the central list; id in a central DELETED event).
- **Brokers** — matched to a central broker by `name_key`; a match keeps the central id and the entries' `broker_id`
  follows it; else imported with its own id.
- **Customer Company** — recomputed from the central assignment history for each record's date; differences listed (the
  central value is saved — same rule as a new save).
- **Locks** — imported as they are (none in the browser today); a lock is written after its section-month's records in
  the same transaction, so the month-open policies pass for the batch's own records.
- **Broker ledgers** — each broker's ledger after import checked with the same rule; an overpayment names broker and date.
- **Driver / vehicle drift** — central vs file differences, for information only.
- **Report** — per section × month: records, Σ amount, Σ paid in the file / to import / skipped / rejected; broker
  outstanding per broker. Downloadable.

### 7.3 Conflict resolution
Nothing is resolved automatically. Rejected or conflicting records stay out; the cause is fixed (e.g. the missing driver
created on the Drivers page, or the record corrected in the browser and exported again) and the dry run re-run. A newer
file from the same browser imports only what is new.

### 7.4 Apply **[R3]**
`api.expenses.importBackup(file, label)` — one API call → **one database transaction through the engine** (§4):

1. The batch record (with its items) is appended with `writeCollection` (`createdAt` = now; it is a new record).
2. Brokers: a central match keeps the central record; a new broker is appended **as it is** (its own id, `createdAt`,
   `updatedAt`).
3. Entries: each source record is appended **as it is** with `writeCollection` — **never through `repository.create`** —
   keeping `id`, `createdAt`, `updatedAt` and `date` byte-for-byte; the import only sets `importBatchId`, `requestId:
   null`, the mapped `broker_id` (via `broker_name`) and the recomputed `customerId`. The engine's `insertRow` then writes
   `created_at = createdAt` and `updated_at = updatedAt` (§4.3); no trigger changes them on insert.
4. Locks (none in the browser today) are appended as they are (`id`, `createdAt`), after their month's records, with
   `locked_by` = the importing Dev's profile and `locked_by_role = 'DEV'` (in Phase 1 only Dev could lock); the audit note
   says they were imported.
5. Audit: one `CREATED` event per imported record and one for the batch, module `Expense`, **`at` = the import time**
   (when the record entered the shared database), `record_date` = the record's business date, note "Imported from browser
   backup '<label>' (batch <id>) — originally entered <createdAt>, last changed <updatedAt>". The record's own
   `createdAt` / `updatedAt` are never replaced by the import time.

RLS applies (Dev). Records for a section-month locked centrally are rejected in the dry run — no bypass (§6.3). Any
failure → nothing written.

### 7.5 Reconciliation
The report is stored in `import_batches.summary`; read-only `29-expense-import-reconciliation.sql` recomputes from the
tables per section × month counts and Σ amounts, per-broker outstanding and items by outcome — must equal the dry run.

### 7.6 Rollback of an import **[R4]**

Undoing an applied batch is a Dev-only application action, `api.expenses.rollbackImport(batchId, reason)`, run only with
the owner's approval and after `02-backup-business-data.sql`. It has a **dry run** (writes nothing) and an **apply**, both
producing the same report. It never deletes anything a normal Dev deletion couldn't.

**Classification of every record the batch imported** (from `import_items` with outcome IMPORTED):

| Category | Rule | Deleted? |
|---|---|---|
| Eligible | entry still present, unchanged since the import (`updated_at` = the imported value), section-month **open**, deletion leaves every affected broker's ledger non-negative | yes |
| Retained — locked | section-month locked (§6.3) | **never** |
| Retained — changed after import | edited since the import (its later edits would be lost) | no (listed; can be deleted individually by the Dev in the normal way) |
| Retained — broker ledger | deleting it would leave a broker overpaid at some date (e.g. a bill whose broker's later payments are in a locked month) | no |
| Retained — brokers | brokers created by the batch | never (Phase 1 has no broker deletion) |
| Retained — locks | section-month locks imported by the batch | never |
| Already gone | deleted earlier by the Dev | — (counted) |

**Report (dry run and apply)**, per collection and per section × month:

1. **Total records in the batch** (imported: entries, brokers, locks).
2. **Records eligible for deletion.**
3. **Records retained because their section-months are locked** (and the other retained categories, each counted).
4. **Records actually deleted** (apply only).
5. **Remaining batch and import history**: the batch row, its `import_items` (never deleted), the records still present.

**Status wording**: `COMPLETE` only when, after the apply, **no entry imported by the batch remains** (brokers and locks
excepted, stated as such); otherwise **`PARTIAL — N of M imported entries remain (L in locked section-months, C changed
after import, B kept for the broker ledger)`**. A partial rollback is never described as complete, in the UI, the toast,
the audit note or the reconciliation script.

**Apply**: one transaction; each eligible entry deleted through the engine with a DELETED event (reason: "Import rollback
of batch <id>: <reason>"); one summary audit event on the batch record (`UPDATED`, record type "Import batch", `after` =
the report, note = the status wording) — the batch row itself is not changed (it has no update policy). Any failure → nothing
deleted. Running it again later only acts on what is then eligible (idempotent); every run is reported.

`29-expense-import-reconciliation.sql` (read-only) also reports, per batch: imported, still present, deleted since, and
the latest rollback status from the audit trail.

The Mac's browser data is untouched throughout.

## 8. Reset and deletion safeguards **[R2]**

### 8.1 Rule
Expense data is never deleted by an ordinary business-data reset, a go-live reset, a restore or any maintenance operation.
The only way an Expense record leaves the database: the Dev deletes it in the application (reason, section-month open,
audited). There is no Expense reset (§8.4).

### 8.2 The two SQL reset scripts — exact behaviour after 2B

| | `03-reset-business-data.sql` (go-live reset) | `05-clean-reset-preserve-profiles.sql` |
|---|---|---|
| Deletes | exactly the tables it deletes today (customers, vehicles, drivers, periods, assignments, fuel, tanker, AdBlue, tyre, trips, invoices, payments, allocations …) with a SYSTEM DELETED snapshot event each, then DATA_RESET | as today |
| Expense tables | **listed as KEPT**: `expense.import_batches`, `import_items`, `brokers`, `entries`, `entry_vehicles`, `month_locks` | **listed as KEPT** (same six) |
| New guard | if any Expense row references a table the script deletes (`core.vehicles`, `core.customers`, `core.drivers`) the script **stops before deleting anything**: "Expense records reference N vehicles / customers / drivers — this reset would break them. Nothing was changed." | same guard |
| New check at the end | the six tables' row counts and Σ `amount`, Σ `paid_amount` equal their values at the start, else `raise` (rolls back everything) | same |
| Confirmation, accounts, audit trail | unchanged (typed confirmation; aborts if account counts change; never touches the audit trail, profiles or reference configuration) | unchanged |

`check:erp-db`'s rule "the reset script knows every table" is extended: every table must be listed as deleted **or** kept,
and the Expense tables must be in the kept list.

### 8.3 Application resets
- **Shared backend**: Settings → Data → Restore from file, Clear all data and Reset to demo data stay refused for every
  role (D-9) — unchanged.
- **Browser backend (C-7) [R3]**: Clear all data, Restore from file and Load demo data **always keep** `expenses`,
  `brokers` and `expense_month_locks` — there is no option to clear them (an option would delete records in locked
  section-months, which §6.3 forbids). A restore file that contains Expense data leaves the browser's Expense data as it
  is and says so ("This file's Expense records were not restored — Expense is kept"). The dialogs state that Expense is
  kept.
- `ensureSeeded` / `migrateStorage` / `SCHEMA_VERSION` never clear Expense (unchanged rule: no migration clears data).

### 8.4 No explicit Expense reset **[R3]**
Revision 2 offered an optional `30-expense-reset.sql`. It would delete rows in locked section-months, which §6.3 forbids,
so **there is no Expense reset script** in Phase 2B (decision D-6 closed). Expense records leave only through the Dev's
audited deletions in open section-months.

### 8.5 Production SQL operational safeguards (expands R-7) **[R4]**

**What the database cannot do.** RLS does **not** protect against the Supabase database owner (the `postgres` role used by
the SQL Editor) or `service_role`: they bypass RLS. Constraints and triggers — including the section-month lock trigger,
the ledger guard and the audit-presence trigger — still apply to them **unless deliberately disabled**, which the owner
role can do (`alter table … disable trigger`, `set session_replication_role = replica`, `drop …`). No database rule can
prevent that; these safeguards are procedural.

1. **No ordinary reset or maintenance script modifies Expense tables.** `03-reset-business-data.sql` and
   `05-clean-reset-preserve-profiles.sql` list the six Expense tables as KEPT, stop if Expense references rows they would
   delete, and abort if Expense counts / sums change (§8.2). No other script in `supabase/scripts/` contains an INSERT,
   UPDATE, DELETE, TRUNCATE, ALTER or DROP on `expense.*` — checked by a repository scan in `check:erp-db`.
2. **No application function or security-definer function bypasses section-month locks.** Planned security-definer
   functions touching `expense.*` — `expense_month_open`, `expense_month_lock_guard`, `broker_ledger_guard`,
   `broker_opening_first`, `entry_vehicle_count` — only **read** Expense tables; none writes `expense.month_locks` or
   skips a lock. `28-expense-post-apply.sql` lists every function whose body mentions `expense.` and checks the list and
   their md5 fingerprints; it also checks that no function body contains `insert into expense`, `update expense`, `delete
   from expense`. The application's only Expense write path is the engine under RLS (no `service_role`).
3. **No unlock operation exists** — no API, UI, function or script (§6.3); `month_locks` has no UPDATE / DELETE grant or
   policy; the post-apply check confirms it.
4. **Every Expense SQL script states its effect on its first line**, using the repository's existing convention:
   `-- READ-ONLY.` (changes nothing) or `-- DESTRUCTIVE —` (changes data; names what and needs the owner's approval);
   migrations state `Run ONCE … It opens its own transaction`. `check:erp-db` refuses any file in `supabase/scripts/`
   without one of these headers.
5. **Read-only verification scripts change nothing** (`24`, `25`, `26`, `27`, `28`, `29`, `02`, `04`): each is a single
   SELECT; `check:erp-db` (a) scans them for any data or schema statement outside comments and (b) runs each one inside
   `begin transaction read only; … ; rollback;` on PGlite — a write attempt would fail the check.
6. **Production write operations require the owner's explicit approval**, each time: applying a migration
   (`20261127000000`, `20261128000000`), running a DESTRUCTIVE script, and applying an import or an import rollback. The
   preflight output is reviewed before, the post-apply output after. Nobody runs ad-hoc SQL that writes `expense.*` or
   disables a trigger; if a correction is ever needed, it is written as a reviewed script with a DESTRUCTIVE header and
   approved first.
7. **Traceability**: every legitimate Expense change carries an audit event (the audit-presence trigger refuses one
   without, for every role); a change made with triggers disabled would leave no event — the reconciliation script (§7.5)
   and `26-phase2a-inventory.sql` counts make such drift visible.

## 9. Test plan **[R2]**

All offline first (PGlite, every migration, real engine); then once on a real PostgreSQL 17; then the local app;
Production only after approval. Gates: `npx tsc --noEmit`, `npx eslint .`, `npm run check` (every suite), `npm run build`.

**T-1 Migration and dependency order (correction 1)**
1. The migration runs in one transaction on a database with every earlier migration; a second run stops with nothing
   changed; with `20261127000000` missing it stops with nothing changed.
2. Every FK target exists when referenced (the file applies top-to-bottom without `deferrable` tricks); dropping in
   reverse order (rollback text) removes everything and restores `module_resource`, `changed_modules` and both audit read
   policies byte-for-byte (md5 equal to before).
3. `27` preflight all OK before; `28` post-apply all OK after; `26` inventory shows `expense` present.
4. **No unlock path [R3, R4]**: the lock trigger refuses an insert / update / delete in a locked section-month **as the
   PGlite superuser (no ERP role, RLS bypassed)** — not only under RLS; `expense.month_locks` has no UPDATE / DELETE policy or grant for `authenticated`; as Dev,
   `update` / `delete` on it change nothing (0 rows / refused); no function in `private` other than the read-only
   `expense_month_open` references `expense.month_locks`; locked section-month writes refused for every role incl. Dev.
5. **The same migration and scripts on PostgreSQL 17** (Docker `postgres:17` with `btree_gist`, or the Supabase CLI's
   local stack) — not only PGlite 18.6.
6. **[R5] Direct child-row operations against a locked parent** — with the parent entry's section-month locked: INSERT a
   new `entry_vehicles` row, UPDATE its `vehicle_id`, DELETE it — each refused by `expense_month_lock_guard` (as Dev under
   RLS **and** as the PGlite superuser with RLS bypassed); the child rows and the parent are unchanged. Same three
   operations with the section-month **open** → allowed (through an audited edit of the parent).
7. **[R5] Deleting an unlocked parent cascades** — delete an entry with one vehicle (Road Tax) and one with three
   (broker bill) in an open section-month: the parent and **all** its `entry_vehicles` rows are gone in one statement;
   the child trigger's "parent not found during DELETE" path allows the cascade; `entry_vehicle_count` passes at COMMIT
   (the entry no longer exists); `require_parent_audit_event` passes (the parent's DELETED event); no orphan rows.
8. **[R5] Deleting a locked parent is refused** — delete an entry whose section-month is locked (through the API, under
   RLS, and as superuser): refused by the parent's trigger before removal; the entry and all its `entry_vehicles` rows are
   still there; no DELETED event written.

**T-2 Engine persistence (correction 2)**
1. Create Road Tax / Insurance / Fitness / Fine: one `entries` row + one `entry_vehicles` row + one CREATED event, one
   transaction.
2. Broker bill with three vehicles: `line_no` 0, 1, 2 in the chosen order; reload returns the same order.
3. Edit that changes **only** the vehicles: `entries.updated_at` changes; a second edit sent with the old version is
   refused (`ConflictError`); `entry_vehicles` replaced in order.
4. Failure injection: a child insert refused (RLS) / a deferred guard failing at COMMIT → no parent row, no child rows,
   no audit event.
5. Delete: parent and its vehicles gone in one statement; DELETED event with reason; no orphan rows.
6. `WRITE_ORDER`: a request that writes a batch, brokers, entries and locks succeeds (FK order); every existing module's
   `check:erp-db` and `check:erp-fields` results unchanged; `check:erp-fields` round-trips every Expense field (generated
   keys, null dates, `vehicleIds` order, broker spelling, `companyConfirmed`, `driverId`, `requestId`, `updatedAt` on insert).

**T-3 Audit Log restriction (correction 3)** — on the database (RLS), through the API (both backends) and in the UI:
1. As Owner and Employee: `audit.events` select returns no `module = 'Expense'` row; `audit.reviews` returns no review of
   an Expense event; the same queries as Dev return them.
2. `api.audit.list` (Owner, Employee): no Expense row; search for an Expense label / amount / vehicle finds nothing; the
   module filter offers no "Expense"; the detail drawer for an Expense event id is not reachable (not in the list; direct
   fetch refused).
3. `api.audit.history(expenseId)` (Owner, Employee): empty; `editedIds` excludes Expense ids.
4. `api.audit.unreviewedDeletions`: an Expense deletion does not raise the Owner's badge; `markReviewed` on an Expense
   deletion id is refused.
5. Polling: `private.changed_modules` as Owner / Employee never returns `Expense` after an Expense write; as Dev it does.
6. Every other module's events are still listed for Owner and Employee exactly as before (count per module unchanged).
7. AdBlue profiles: unchanged (no audit access).

**T-4 Idempotency and the broker-payment confirmation (rev. 2 correction 4, rev. 3 corrections 2 and 4)**
1. **Same request id submitted repeatedly** (3× sequentially) — one row, one CREATED event; every call returns the same
   row (id, `createdAt`, `updatedAt` equal). For each section and for bills and payments.
2. **Same request id, changed contents** (amount / date / vehicle / broker) — refused; nothing written; the original row
   unchanged.
3. **Two simultaneous requests with the same request id** (two engine calls started together, and two raw transactions
   bypassing the lock in the database test) — exactly one row; the other gets the "already saved" answer (23505 mapped).
4. **Broker payment confirmation followed by a retry** — first call → `PossibleDuplicateError`, nothing written; confirm →
   saved; the same confirmed call re-sent (network retry, same key) → returns the saved payment, no second row.
5. **Confirmed separate identical payment** — two payments, same broker / date / amount, different keys, the second
   confirmed → two rows, two CREATED events; outstanding reduced twice.
6. **Confirmation with a previously consumed request id** — `confirmSameDay: true` with a key already used for a saved
   payment → returns that payment (same content) or is refused (changed content); never a second row.
7. **Genuine separate payments with identical amounts** on different dates or to different brokers → no confirmation;
   both saved.
8. **Overpayment after confirmation** — a confirmed identical payment that would overpay the broker at any date → refused
   by the API and, with the API check bypassed in the database test, by `broker_ledger_guard` at COMMIT.
9. **No popup elsewhere** — Road Tax, Insurance, Fitness, Fines and bills with identical details and different keys →
   Phase 1 rules only (bills: a repeated bill number refused; otherwise saved), never `PossibleDuplicateError`.

**T-5 Reset and deletion safeguards (correction 5)**
1. `03` and `05` on a database holding Expense rows: they stop before deleting when Expense references vehicles /
   customers / drivers; with no references they delete what they delete today and leave every Expense row (counts and
   sums equal).
2. `check:erp-db`: both scripts list every table as deleted or kept; Expense tables kept.
3. Browser backend: Clear all data / Restore (incl. a file with Expense data) / Load demo leave `expenses`, `brokers` and
   `expense_month_locks` byte-for-byte unchanged; no UI or API path clears them.
4. Shared backend: restore / clear / reset refused (unchanged).
5. No script in `supabase/scripts/` deletes from or updates `expense.*` (a repository scan in `check:erp-db`); no Expense
   reset exists.
6. **[R4] Script headers and read-only scripts**: every file in `supabase/scripts/` starts with `-- READ-ONLY.` or
   `-- DESTRUCTIVE —`; every READ-ONLY script has no data / schema statement outside comments and runs successfully inside
   `begin transaction read only … rollback` on PGlite.
7. **[R4] Security-definer inventory**: the functions mentioning `expense.` are exactly the five planned; none writes
   `expense.*`; md5 fingerprints as in `28`.

**T-6 Phase 1 behaviour on the database** — `check:expenses` re-run through the database engine (incl. **[R5]** a PAID fine
saved with a blank Payment Reference — accepted, as Phase 1; an UNPAID fine saved with a reference — stored blank by the
API, and refused by `entries_fine` if written directly): every Road Tax,
Insurance, Fitness, Fines and Broker rule (incl. three bills, bulk payment once, partial payments, overpayment and back-dated
refusals, opening balance, bill numbers, type fixed), section-month locks (independent sections, old / new date, future
month), Monthly Sheet Lock interaction, Customer Company by transaction date (incl. back-dated transfer), descriptions,
filters, delete with reason, concurrency; plus RLS per role for every table (Dev, Owner, Employee, Tata Adblue, Adblue);
drivers (master, DL unique, dated company changes, deployments).

**T-7 Import** — on a copy of the Mac's backup: dry-run counts / totals; re-run "already present"; conflict on an edited
copy; rejected unknown vehicle / driver; broker matched by name; deleted-id refusal; centrally locked month refusal; apply
in one transaction; reconciliation equals the dry run; the same file refused a second time; the browser file unchanged.
**T-7.2 Import rollback reporting [R4]** — (a) all imported entries in open months, unchanged → report: total = eligible =
deleted, retained 0, status `COMPLETE` (brokers / locks listed as kept); (b) some entries in a section-month locked after
the import → those retained and counted as "retained — locked", the rest deleted, status `PARTIAL — N of M …`, never
`COMPLETE`; (c) an entry edited after the import → "retained — changed after import"; (d) a bill whose deletion would
overpay its broker → "retained — broker ledger", the rest deleted, ledger guard never fails; (e) the dry run equals the
apply's classification and writes nothing; (f) a second rollback acts only on what is eligible then, and reports
"already gone" for earlier deletions; (g) the batch row and `import_items` remain; one DELETED event per deleted entry and
one summary event with the report; (h) the UI toast, the audit note and `29` all show the same status word; (i) a failure
mid-apply deletes nothing.
**T-7.1 Imported timestamps [R3]** — for every imported entry, broker and lock: `id` equal to the source; in SQL,
`to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')` and the same for `updated_at` **equal the source
strings exactly**; `date` equal; through the API, `Date.parse(createdAt)` / `Date.parse(updatedAt)` equal the source's (the
database returns `+00:00` text where the browser stored `Z`); the CREATED event's `at` is the import time (≥ the batch's
start) and its note contains the original `createdAt`; no row has `created_at` or `updated_at` equal to the import time
unless the source did.

**T-9 Enforcement matrix [R4]** — for each "Both" row in §6.4, the database rule is exercised **directly** (raw SQL in
PGlite, bypassing the API) and refuses; for each "API only" row, a test documents that raw SQL is accepted (so the
limitation stays known and visible) and that the API refuses.

**T-8 UI** — each Expense page as Dev on the shared backend; Owner and Employee: no Expense in the sidebar, routes
redirect, API refused, RLS refused, **no Expense event in the Audit Log list, search, detail, history, badge or polling**.

## 10. Deployment and activation sequence

1. Owner approves this plan and the decisions in §11.
2. Implement 2B locally: migration, scripts 27–29, the reset-script changes, the
   `tables.ts` / `engine.ts` additions (§4.3), the Expense API changes (request id, import, audit helper), C-1 and C-7 UI
   changes, tests. Nothing deployed.
3. Run the full test plan, including **T-1.5 on PostgreSQL 17**. Owner reviews.
4. Production, SQL Editor: §3 steps 1–3 (driver migration), then 4–6 (Expense migration).
5. Deploy the application (only after both migrations).
6. Verify as Dev; verify as Owner / Employee that Expense is invisible everywhere, including the Audit Log.
7. On the Mac: Download backup.
8. Import: dry run → owner reviews → apply → reconciliation.
9. Owner checks the five sections against the browser.
10. The Mac keeps its browser data; moving daily use to the shared backend is the owner's call.

Rollback points: before step 5 — §5.5 (no data yet); after step 5 — redeploy the previous build (it never reads
`expense`); after step 8 — §7.6.

## 11. Remaining risks and owner decisions **[R3]**

| # | Decision / risk | Status / recommendation |
|---|---|---|
| D-1 | Six-table design | Accepted in principle. |
| D-2 | C-1: hide "this browser only" wording on the shared backend | Approve. |
| D-3 | C-2: the CREATED event's time is the import; the row keeps its original `createdAt` / `updatedAt` | Approve. |
| D-5 | Locked section-months | **Closed: no unlock, no bypass, read-only for every role** (§6.3). |
| D-6 | Explicit Expense reset | **Closed: none** (§8.4). |
| D-8 | C-6: request ids on every create; confirmation only for a second identical **broker payment** | Approve (owner's instruction). |
| D-9 | C-7: browser Clear / Restore / Load demo always keep Expense (no clearing option) | Approve. |
| D-10 | C-8: Expense audit events hidden from Owner / Employee (DB policy, polling function, API) | Approve (owner's instruction). |
| D-11 | §8.2: the go-live reset scripts stop if Expense references vehicles / customers / drivers they would delete | Approve. |
| D-12 | §7.2: the import saves the Customer Company recomputed from the central assignment history (the browser's copy should match; differences are listed) | Approve. |
| D-13 | **[R4]** Add `private.expense_month_lock_guard()` (lock enforced by a trigger as well as RLS) | Approve. |
| D-14 | **[R4]** Import rollback as a Dev-only action with dry run, report and COMPLETE / PARTIAL status (§7.6) | Approve. |
| D-15 | **[R4, R5]** R-8: keep the listed rules API-only, or add cross-module database triggers | **Decided (owner, 27 Nov 2026): API-only for this release**, limitations acknowledged (§6.4); **no cross-module database triggers in this revision**. Revisit when Expense is released to other roles. |
| R-1 | Deploying the current repository before `20261127000000` breaks vehicle / driver reads on Production. | Driver migration first (§10). |
| R-2 | The Mac's browser is the only copy of Phase 1 Expense data until the import. | Download a backup now; avoid Clear / Restore there until C-7 ships. |
| R-3 | Records added in the browser after the export aren't imported. | Export immediately before the import; a newer file imports only what's new. |
| R-4 | Offline tests run on PostgreSQL 18.6 (PGlite); Production is 17.11. | T-1.5 on PostgreSQL 17 before Production. |
| R-5 | The audit read policy change applies to `audit.events` for every module (the clause only filters `Expense`). | T-3.6 proves other modules unchanged; policy fingerprint in `28`. |
| R-6 | `tables.ts` / `engine.ts` change (additions only). | `check:erp-db`, `check:erp-fields` for every module. |
| R-7 | The SQL Editor's owner role and `service_role` bypass RLS; the owner can also disable triggers or drop objects. | **[R4]** Section-month locks, ledger, type and audit rules are triggers (hold unless deliberately disabled); §8.5 operational safeguards for everything else. |
| R-8 | **[R4, R5]** API-only rules (§6.4): vehicle not archived on the date, customer = assignment on the date, archived-driver restriction, paying company *explicitly chosen*, broker required on new entries, one description spelling, the identical-payment confirmation. | **Accepted for this release (D-15)**: limitations acknowledged — a direct SQL write that bypasses the API could store data breaking these rules; Expense is Dev-only with the engine as its single write path, and §8.5 forbids manual writes. T-9 keeps each limitation visible. |

## 12. Consistency review (revisions 3, 4 and 5) **[R3, R4, R5]**

The whole plan was re-read against each pair below; contradictions found and fixed:

| Pair | Found | Resolution |
|---|---|---|
| Phase 1 ↔ 2B | Rev. 2 applied the duplicate confirmation to every create. | Confirmation for broker payments only; other creates follow Phase 1 (§2.5, §5.4, C-6). |
| Phase 1 ↔ 2B | Rev. 2's optional Expense reset could delete locked-month rows. | Removed (§8.4). |
| Phase 1 ↔ 2B | Rev. 2 still offered a Dev-only unlock (§11). | Removed; §6.3 states the final rule. |
| Tables ↔ engine | `request_id` and `import_batch_id` columns had no field in the app type, so `cols()` couldn't write them. | `Expense.requestId`, `Expense.importBatchId` added to the type (§4.3); `cols` maps both. |
| Tables ↔ RLS ↔ API | `brokers` had an UPDATE policy although Phase 1 (and the API) has no broker edit. | No UPDATE / DELETE policy or grant (§6.1). |
| Import ↔ columns | "Already present" compared raw file content although the import rewrites `broker_id` and `customerId`. | Compared after the same normalisation (§7.2). |
| Import ↔ columns | Imported locks had no rule for `locked_by` / `locked_by_role` (insert policy requires the role). | Importing Dev's profile, role `DEV`, original `id` / `createdAt`, audit note (§7.4). |
| Timestamps ↔ audit | §4.3 vs §7.4 (rev. 2) — whether `insertRow` keeps original timestamps. | `insertRow` writes the record's own `created_at`; `updated_at` in `cols`; the import bypasses `repository.create` (§4.3, §7.4); the audit `at` is the import time (C-2); test T-7.1. |
| Reset ↔ backup | Rollback after an import could delete locked-month records. | Deletions only in open section-months (§7.6); no schema drop after data (§5.5). |
| Reset ↔ locks | Rev. 2's browser "also delete Expense" option (typed `DELETE EXPENSE`) would delete locked-month records locally. | Removed: browser resets always keep Expense (§8.3, C-7). |
| Migration ↔ inventory | Rev. 2 referred to T-1.4 for the PostgreSQL 17 run after renumbering. | T-1.5 everywhere; steps re-checked against the inventory (`20261127000000` not applied → steps 1–3 first; everything through `20261122000100` live). |
| RLS ↔ API **[R4]** | Rev. 3 implied the lock was enforced "by the database" while it was only RLS — bypassed by the SQL Editor's owner role. | Lock trigger added (§5.3); §6.4 states per rule which mechanism exists and what it doesn't cover; T-1.4 runs as superuser. |
| API ↔ database **[R4]** | Rev. 3 called concurrency "database backstop"; it is the engine's guarded SQL, not a constraint. | §6.4 says so; limitation named. |
| Rollback ↔ reporting **[R4]** | Rev. 3's rollback deleted "the batch's entries" without saying what happens to retained ones or how the result is described. | §7.6: categories, report, COMPLETE only when nothing imported remains; T-7.2. |
| Phase 1 ↔ 2B **[R5]** | Rev. 4's `entries_fine` didn't state the Payment Reference rule. | Verified in the code: optional (also when PAID), cleared when UNPAID; CHECK mirrors only the clearing (§2.4, §5.3, §6.4); T-6. |
| Lock trigger ↔ cascade **[R5]** | Rev. 4 didn't say how the child trigger (and `entry_vehicle_count`) behave when the parent row is already gone during `ON DELETE CASCADE`. | Parent missing on child DELETE = cascade of an already-checked parent delete → allowed; missing on INSERT / UPDATE → raise; count check skips deleted entries (§5.3); T-1.6 – T-1.8. |
| Decisions **[R5]** | D-15 was open. | Decided: API-only this release; no cross-module triggers (§11). |
| RLS ↔ API | The Owner / Employee could still mark an Expense deletion reviewed via an id. | `audit.reviews` insert requires the event to be visible (§6.2); `markReviewed` uses `visibleEvents()`; T-3.4. |

Re-checked with no contradiction: section CHECKs ↔ `expenseProblems`; ledger order ↔ `ledgerOrder`; months by business
date ↔ indexes and locks; Dev-only ↔ no `role_permissions` row; the six tables ↔ the dependency order ↔ `WRITE_ORDER`;
the reset scripts ↔ `02` backup (Expense backed up, never reset); Mac-only import ↔ the eight deleted records (never read).

*Phase 2B is planned, not implemented. Waiting for the owner's review.*
