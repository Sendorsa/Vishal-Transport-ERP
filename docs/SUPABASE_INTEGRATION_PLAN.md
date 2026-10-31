# Supabase Integration Plan — Fuel modules (readiness audit)

**Date:** 1 Nov 2026 (revised twice the same day; **final permission decisions:** DEV has ultimate ERP authority, every Owner power plus exclusive administration; see §3)
**Status:** audit and plan only. No application code, migration, SQL or Supabase setting was changed to write it.

**Starting point** (as reported by the owner):
- The 8 migrations are applied to the Supabase project and recorded in its migration history.
- The 22 custom-schema tables exist, with RLS enabled on all of them.
- The ERP still runs on localStorage.

**Builds on:**
- `SUPABASE_DIESEL_DATABASE_SCHEMA.md` (design, decisions D-1 … D-18);
- `SUPABASE_DIESEL_MIGRATION_PLAN.md` (rollout and rollback);
- `SUPABASE_DIESEL_IMPLEMENTATION_REPORT.md`.

> **Decisions since this plan was written (1 Nov 2026):**
> - **No staging project.** The existing Production project, `Vishal Transport erp`, is used directly (owner's decision). The 8 migrations up to `20261101000600` are applied there. Every later migration is checked offline (PGlite), then with `npx supabase db push --dry-run`, and applied only with the owner's go-ahead. No test data or test accounts are created in Production. Staging instructions below are marked superseded.
> - **Accounts are pre-created by DEV; Google is the only sign-in.** There is no invitation email, no email / password login and no self-registration.
>   - A pre-created account is status `INVITED`, shown as "Approved · not signed in yet".
>   - At the person's first Google sign-in, `public.link_google_account()` links it and sets it `ACTIVE`. It requires a Google identity whose email Google verified, equal to the account's email.
>   - DEV adds accounts with `public.add_account`.

---

## 1. The deployed database

### 1.1 What was and wasn't checked

| Check | Done? | How |
|---|---|---|
| The 8 migration files in the repo vs. the reviewed design | Yes | Same files as commit `70405e3`. All local checks pass on them |
| Project link metadata (non-secret) | Yes | `supabase/.temp/` (git-ignored): **PostgreSQL 17.11**, Auth (GoTrue) v2.197.0, PostgREST v14.18, CLI v2.122.0. The saved pooler URL holds no password |
| The live catalog: tables, columns, constraints, indexes, views, functions, triggers, grants, policies | **No** | Inspecting it means running SQL against the project, which this task forbids. Appendix A has a **read-only** catalog query for the owner to run in the SQL editor. With its output, the live database can be compared object by object with what the migrations create |

### 1.2 Discrepancies found without querying the live database

| # | Finding | Effect |
|---|---|---|
| X-1 | **Postgres version:** validated locally on PGlite (PostgreSQL 18.6); the project runs **17.11** | The migrations applied, so the syntax is compatible. Runtime behaviour (deferred triggers, locks, exclusion constraints) still has to be re-tested on a real 17.x server (§12) |
| X-2 | **Status text is now out of date.** These still say "not applied to any Supabase project": CLAUDE.md ("Diesel database schema", "Supabase"), `SUPABASE_DIESEL_IMPLEMENTATION_REPORT.md` §1 / §11 / §12, `SUPABASE_DIESEL_MIGRATION_PLAN.md` status, `SUPABASE_DIESEL_DATABASE_SCHEMA.md` status | Documentation only. Update once the owner confirms which project was used (staging or production, see S-2) |
| X-3 | **No `supabase/config.toml` in the repo:** which schemas the Data API exposes, and the Auth settings, live only in the dashboard | The rule "custom schemas never exposed" is not version-controlled. Verify by hand (S-3) |
| X-4 | **The design has no database login for the server.** D-1 says the server runs each transaction as `authenticated`, but no migration creates a login role allowed to do that. Without one, the server would have to use the `postgres` owner credentials | Missing capability M-1 (§11) |
| X-5 | **No way to provision accounts.** `profiles_guard` refuses every change to `role`, `status`, `user_id` and `email` by `anon` / `authenticated`, by design. So, with D-1's "run as authenticated", nothing can link a Google user to a pre-created account, add an account someone or change a role. Today only the SQL editor can | Missing capability M-2 (§11) |
| X-6 | **Account changes aren't audited.** `public.profiles` has no `require_audit` trigger and no audit event is written for added accounts or role changes | Part of M-2 |
| X-7 | **`database.types.ts` is hand-written** (public schema only) | Correct for D-1: supabase-js only touches `public.profiles`. Regenerate with `supabase gen types --linked --schema public` once allowed (this reads the live database) |

## 2. Blockers and security concerns, most serious first

| # | Concern | Where | Must be fixed before |
|---|---|---|---|
| **S-1** | **`currentRole()` returns `"OWNER"` whenever there is no `window`** (`src/lib/app-state.ts:58`). Running today's `src/lib/api` on the server unchanged would make **every request the Owner**. `app-state.ts` is also a `"use client"` module, so server code can't import it correctly | `app-state.ts`, `api/index.ts` (15 calls) | Any server execution of `api.*` |
| **S-2** | **The audit trail is permanent, for every role** (`audit_append_only`, no truncate, even for `postgres`). Every test write to the deployed project leaves audit rows that can never be removed. Integration testing must not use it if that project is production | Process | Any integration test against Supabase |
| **S-3** | **Data API exposure isn't pinned (X-3).** `authenticated` has `USAGE` on `core`, `fuel`, `finance`, `audit`, `private` and `EXECUTE` on `private.*`. D-1 needs this. If someone added these schemas to the exposed list, signed-in users could reach the tables and RPCs directly. RLS still applies, but the rules kept only in the API would be skipped | Dashboard → Data API settings; also check GraphQL | Go-live |
| **S-4** | **The server would need owner credentials (X-4).** A leaked `postgres` connection string means full control of the database, RLS bypassed | M-1 | First server write |
| **S-5** | **The server endpoint must accept only listed methods.** Exactly the allowed `api.*` methods; never the `admin.*` reset / clear / restore methods (D-9); never a role or user id sent by the browser | §5.3 | First server write |
| S-6 | **Separate database per environment.** Vercel Preview and Development must never point at the production database | Vercel env | First deploy |
| S-7 | **Open Google sign-up.** Any Google account can create an `auth.users` row. It gets **no** ERP access (no ACTIVE profile → every `private.can` is false, and the server refuses before any business query). Optional hardening: M-4 | Auth settings | Optional |
| S-8 | **The secret key is unused.** `SUPABASE_SECRET_KEY` is empty and nothing reads it. D-1 doesn't need it. Keep it out of every `NEXT_PUBLIC_` variable and out of Vercel unless a later feature needs the Admin API | `.env.local` | — |
| **S-10** | **ERP authority and infrastructure access are different things.** Inside the ERP, the append-only triggers bind every role the app uses, DEV included, so no ERP user can change or delete audit history. DEV will also administer the Supabase project (owner's decision), and infrastructure administrators (dashboard, `postgres`) can technically change schema objects, triggers included. That is a trust boundary the database can't enforce against its own administrator; it is managed by the controls in §3.6 | Supabase organisation and project | Go-live |
| S-9 | **Money computed twice.** `amount` is generated in NUMERIC by the database (D-12); the app also calculates it in floating point | Adapter | Diesel step |

**What S-9 means for the adapter:** it must never write `amount`, and must read rows back after writing (`RETURNING`), so screens and audit snapshots show the database's value.

## 3. Authentication and user management

**Principle: signing in proves who someone is; it grants nothing.** Access needs an **ACTIVE** `public.profiles` row. Every database check (`private.can`, `is_owner`, `month_open`) already returns false without one, and the server refuses before running any business code.

### 3.1 Final role model (owner's decision, 1 Nov 2026)

**DEV has ultimate ERP authority:** every permission the OWNER has, plus exclusive system administration. **There is no Owner-only operation that DEV can't perform.** OWNER keeps full business ownership but administers neither accounts nor the system. EMPLOYEE is unchanged; nothing is added to it.

| Capability | DEV | OWNER | EMPLOYEE | Server check | Database check |
|---|:-:|:-:|:-:|---|---|
| View every business module and record, all reports and financial data | ✓ | ✓ | Fuel modules, vehicles (view), trips, dashboard (as `MAP`) | `can()` | RLS `private.can` |
| Create / edit business records | ✓ | ✓ | Diesel, AdBlue, tanker entries, trips only | `can()` + month lock | RLS `private.can` + `month_open` |
| Delete business records (mandatory reason, audited) | ✓ | ✓ | ✗ | `can(…, "delete")` + reason | RLS `private.can(…, 'delete')`; DELETED event needs a reason |
| Money: payments, TDS, invoices, receipts, customer master data | ✓ | ✓ | ✗ | `can()` | RLS `private.can` |
| **Owner-level business controls:** lock / unlock a month; change data in a locked month; deletion badge and review; Restore / Push Back | ✓ | ✓ | ✗ | `hasOwnerAuthority(role)` = OWNER or DEV, by name | `private.is_owner_or_dev()` (after M-5) |
| Operational settings: company profile and bank details, vehicle types, drivers, rates, station opening balances, tanker opening stock | ✓ | ✓ | ✗ | `can("settings", "edit")` / existing rules | RLS `private.can('settings', 'edit')`, `is_owner_or_dev()` |
| Full Audit Log: view, filter, history | ✓ | ✓ | ✗ | `can("audit")` | RLS `private.can('audit', 'view')` |
| **Accounts:** add (pre-create) and provision; assign, change and revoke roles; deactivate and reactivate; access recovery | ✓ | ✗ | ✗ | `role === "DEV"`, by name | `private.is_dev()` inside the M-2 functions |
| **System configuration:** permission definitions, application-wide settings, data backend and environment, read-only data export | ✓ | ✗ | ✗ | `role === "DEV"`, by name | Permission map: migration only, no write grant to anyone; account functions: `is_dev()` |
| Change or delete historical audit records | ✗ | ✗ | ✗ | No API path exists | Append-only triggers, every role |
| **Reset All, Clear All, Restore from file** against the shared database (D-9) | — | — | — | Not offered; the endpoint refuses `admin.resetDemoData`, `clearAllData`, `restoreBackup` | No such function exists; sessions can't write DATA_RESET events, and have no TRUNCATE, nor DELETE on masters |

**Wildcard safety:**
- **`MAP` is inverted:** DEV holds `"*"`; OWNER holds `FULL_ACCESS`, which is every resource except the DEV-only ones (`DEV_ONLY`, e.g. `accounts`, `system`).
  - A new business module therefore reaches both automatically.
  - A DEV-only resource can never reach OWNER through a wildcard.
  - `core.role_permissions` changes to match (M-5), and `check:supabase-diesel` keeps pinning table = `can()`.
- **`can()` refuses DEV-only resources to every role except DEV,** whatever the map says.
- **DEV-only operations still check `role === "DEV"` / `private.is_dev()` by name;** they never rely on `can()` or `private.can` alone.
- **Rule for future work:** only DEV holds `"*"`. DEV-only power is never granted through a shared check, and `DEV_ONLY` resources are never added to `FULL_ACCESS`.

**Conflict with CLAUDE.md, to resolve on approval.** CLAUDE.md says today:
- Dev is "full access minus Owner-only";
- Owner-only controls are refused to Dev;
- Dev sees the Audit Log read-only;
- "never add `*` to another role";
- the Owner has `*`;
- in a locked month, Dev follows the lock like Employees.

The final decisions reverse each of these. To update once approved:
- CLAUDE.md: "Roles and Permission Boundaries", "Monthly Sheet Lock", "Fuel Station Payment Rules" 3, "TDS", "Audit Trail" 5, 12 and 12a, "Backups";
- `src/lib/permissions.ts`;
- the Owner-by-name checks in `src/lib/api/index.ts` (restore, month lock, review, `changedBy: "OWNER"`), `src/domain/month-lock.ts` (`canEditMonth`), `src/features/audit/audit-log.tsx` and the badge in `src/components/layout/app-sidebar.tsx`;
- the expectations in `roles.check.ts`, `month.check.ts`, `restore.check.ts`, `audit.check.ts` and `actions.check.ts`;
- `SUPABASE_SETUP.md` §2 and §6.

### 3.2 Sign-in flow (Google)
1. **Sign-in page:** `/login` → `supabase.auth.signInWithOAuth({ provider: "google" })`, using the browser client (`src/lib/supabase/client.ts`) with the publishable key.
2. **Callback:** a route handler (`app/auth/callback/route.ts`) exchanges the code for a session, with cookies through `@supabase/ssr`.
3. **Session refresh:** `proxy.ts` (Next.js 16's name for middleware) only keeps the session cookie fresh and redirects signed-out visitors to `/login`. **It is never the authorisation check** (Next.js 16 docs: Proxy is not a session or authorisation solution).
4. **Every server request:**
   - `supabase.auth.getClaims()` verifies the JWT. Never `getSession()`, which reads unverified cookie data.
   - Recommended: enable the project's **asymmetric JWT signing keys**, so `getClaims()` verifies locally without calling the auth server (a dashboard setting; not changed here).
   - The server then loads the profile `(id, role, status, full_name)` for `claims.sub`.
   - No ACTIVE profile → HTTP 403 "Your Google account has no ERP access. Ask the system administrator." No business query runs.
5. **First Google sign-in of a pre-created account:** the server calls `public.link_google_account()` (M-2).
   - It requires a **Google** identity (`auth.identities`, provider `google`) belonging to the signed-in user, whose email Google marked **verified**, equal to the user's confirmed email.
   - It links that user to the account with the same email if it is `INVITED` (approved, not signed in yet), and sets it ACTIVE.
   - Email / password, phone or anonymous users are refused, whatever the Auth settings.
   - It is atomic, works only once, and is audited.
   - A Google account matching no pre-created account stays without access.
6. **Deactivation takes effect on the next request:** every request requires an ACTIVE profile. So no session has to be revoked through the Auth Admin API, and the **secret key stays unused**.

### 3.3 The five initial accounts

| # | Role | Email | How it is created |
|---|---|---|---|
| 1 | DEV | To be supplied separately | **Bootstrap:** the project administrator runs `select private.bootstrap_first_dev('<email>')` once in the SQL editor. It works only while no DEV account exists; only `postgres` can execute it (not `authenticated`); it writes a SYSTEM audit event |
| 2–3 | OWNER | Two of the original four emails | Added by DEV in Settings → User accounts (no email is sent) |
| 4–5 | EMPLOYEE | The other two of the original four | Added by DEV in Settings → User accounts (no email is sent) |

- **Emails are never written into git, documentation, seeds or migrations.** They are typed only into the Add account form, or into the one bootstrap statement. I don't have the four emails; they are supplied at provisioning time.
- **Activation:** each account becomes ACTIVE at its first Google sign-in with that Google-verified email.
- **Where:** the existing Production project only. There is no staging project, and no test accounts are created.
- **Afterwards,** a read-only count confirms exactly 1 DEV, 2 OWNER and 2 EMPLOYEE are ACTIVE.

### 3.4 Account operations (DEV only)

| Operation | Database function (M-2) | Rules |
|---|---|---|
| Add account (pre-create) | `public.add_account(email, role, full_name)` | Email lower-case and unique; role OWNER / DEV / EMPLOYEE; status INVITED ("Approved · not signed in yet"); no email is sent |
| Assign / change role | `public.set_account_role(profile_id, role, reason)` | Never removes the last ACTIVE DEV |
| Deactivate | `public.set_account_status(profile_id, 'DISABLED', reason)` | Immediate (next request); never the last ACTIVE DEV; also works for an account that never signed in |
| Reactivate | `public.set_account_status(profile_id, 'ACTIVE', reason)` | A linked account → ACTIVE; an unlinked one → INVITED |
| Access recovery (lost Google account, new email) | `public.relink_account(profile_id, new_email, reason)` | Clears the link, sets the new email, status INVITED. The old Google account loses access at once; the next sign-in with the new email claims the same profile, keeping its role and history |
| List accounts | RLS: DEV reads every profile; everyone else reads only their own row | — |

- **Every function is `security definer` with `search_path = ''`.** It checks `private.is_dev()` by name, refuses anything else with SQLSTATE `42501`, and writes its audit event in the same statement (§8).
- **Changes by role, deactivation, reactivation and recovery need a reason** of at least 3 characters (the same rule as deletions).
- **The browser still can't write `profiles` directly:** the existing `profiles_guard` and the revoked grants stay as they are.

### 3.5 Settings: operational vs system configuration

| Kind | Who | What |
|---|---|---|
| **Operational settings** (business) | DEV, OWNER | Company profile and bank details printed on invoices; vehicle types; drivers; rates; month locks; station opening balances; tanker opening stock |
| **System configuration / application-wide settings** | **DEV only** | User accounts and roles; the role → permission definitions (`core.role_permissions`, changed only by reviewed migration); data backend and environment; Settings → Data → read-only export of the Fuel tables; authentication and integration settings |


### 3.5a D-9 kept: no database-wide reset, clear or restore

**The shared Supabase database is never cleared or reset from the application.** This is the original D-9 decision, unchanged:
- **No Reset All** (`admin.resetDemoData`), **no Clear All** (`admin.clearAllData`), **no Restore from file** (`admin.restoreBackup`) against the shared database, **for any role**.
- **In database mode they aren't offered:** Settings → Data explains why. The server endpoint refuses them (S-5), and the database has no function that could do them.
- **Database recovery** uses Supabase's backups and **point-in-time recovery** (D-13): restored into a new project, compared, then switched, by DEV as infrastructure administrator under the controls in §3.6.
- **Single records** are still undone with Restore / Push Back from the Audit Log (an Owner-level control, so OWNER and DEV). It re-inserts one deleted record and is audited, so it is not a database-wide restore.
- **This doesn't reduce DEV's permissions.** The operations don't exist against the shared database for anyone. DEV keeps unrestricted ERP permissions: every Owner-level business control plus exclusive system administration.
- **The localStorage fallback is unchanged:** its browser-only Reset / Clear / Restore tools stay as they are today (Owner and Dev, each downloading a backup first). They act only on that browser's data, never on the shared database.

- **If an operational setting should be treated as system configuration** (or the other way round), say so. Moving company profile or vehicle types to DEV-only would also change their RLS in M-5.

### 3.6 ERP authority vs Supabase infrastructure access

| Level | Who | Can | Can't |
|---|---|---|---|
| **ERP** (the application, as `authenticated` through RLS) | DEV | Everything in §3.1, including account and system administration | Change or delete audit history (no API path; append-only triggers) |
| | OWNER, EMPLOYEE | Their rows in §3.1 | Accounts, system configuration, audit history |
| **Infrastructure** (Supabase organisation, dashboard, CLI, `postgres`) | **DEV**, as project administrator (owner's decision) | Apply migrations, manage Auth providers, keys, backups, connection roles, monitoring | Nothing technically blocks an infrastructure administrator; this level is governed by the controls below |

**Controls on infrastructure access:**
1. **Schema changes go only through version-controlled migrations** reviewed in git, checked offline (PGlite) and with `supabase db push --dry-run`, then applied to Production unchanged. There is no staging project. Git history is the record.
2. **No direct data edits in the SQL editor** on Production business or audit tables. Business corrections go through the ERP, so they are audited. Read-only queries are fine.
3. **A scheduled export of `audit.events`** to storage the Owners control, for tamper evidence: a later change would no longer match the export.
4. **Supabase point-in-time recovery (D-13)**, plus the platform's own organisation audit log where the plan provides it.
5. **MFA** on the Supabase, GitHub, Google and Vercel accounts that can reach Production.
6. **Optional:** an Owner holds a **read-only** seat in the Supabase organisation for business continuity. It must not be an admin seat, which would re-grant system configuration at the infrastructure level. Optionally, a later migration adds a hash chain over audit events, which makes tampering visible.

## 4. Roles and permissions

| Layer | Source | Purpose |
|---|---|---|
| App | `src/lib/permissions.ts`: `MAP` (DEV `"*"`, OWNER `FULL_ACCESS`, EMPLOYEE list), `can()` (refuses `DEV_ONLY` to everyone but DEV); `hasOwnerAuthority(role)` (OWNER or DEV) for Owner-level business controls; `role === "DEV"` for administration | First check: clear messages ("Only the Owner or Dev can lock a month", "Only Dev can manage user accounts") |
| Database | `core.role_permissions` (= `MAP`, pinned by `check:supabase-diesel`), `private.can`, `month_open` in RLS; `private.is_owner_or_dev()` for Owner-level controls (M-5); `private.is_dev()` in the account functions (M-2) | Second guard: holds even if server code has a bug |

- **On the server,** `currentRole()` / `currentActor()` read a per-request context: role, profile id, name and email from the verified profile (`AsyncLocalStorage`).
- **On the server, with no context, they throw** instead of falling back to Owner. This fixes S-1.
- **In the browser,** they keep today's mock-session behaviour, for the localStorage backend only.
- **A permission change touches three things together:** `MAP` + a migration updating `core.role_permissions` + the pinning check. One check keeps them equal.
- **By-name checks:**
  - **Owner-level business controls:** OWNER **or** DEV (`hasOwnerAuthority`, `is_owner_or_dev()`). There is no longer any Owner-only check that excludes DEV; `OWNER_ONLY` is retired.
  - **DEV-only administration:** DEV alone (`DEV_ONLY`, `role === "DEV"`, `is_dev()`). It is never reachable through a shared permission check or a wildcard.
- **Audit attribution stays truthful:** a month lock or restore by DEV is recorded as DEV (`changed_by_role`, `actor_role`), never as OWNER.

## 5. Backend (decision D-1)

### 5.1 What exists today
- **`src/domain/*`:** pure functions. They run unchanged on the server.
- **`src/lib/api/index.ts`** (1,643 lines) holds every validation and audit call. It reaches storage through five functions from `local-store.ts`:
  - `readCollection` (100 calls, **synchronous**) and `writeCollection` (4);
  - `readSettings` / `writeSettings`;
  - `appendAuditEvent`;
  - `runInTransaction` (wrapped by `tx`, 61 calls).
- **`repository.ts`** (`createLocalRepository`, 17 uses) handles `list / get / create / update / remove` on top of the same functions.
- **The UI reaches data only through `hooks.ts` → `api`.** The only other storage use is UI conveniences: the selected month, cross-tab refresh (`subscribeExternal`), and Settings' storage-usage line.

### 5.2 Integration approach: keep `api/index.ts`, swap the storage underneath
The 100 synchronous `readCollection` calls are the main constraint. Rewriting them as async SQL would touch every rule, which is the risk D-1 option B exists to avoid. So:

1. **A storage interface with today's five functions**, and two implementations:
   - **local:** today's `local-store.ts`, unchanged.
   - **pg (unit of work):** for one request, inside one Postgres transaction (§7):
     1. load the request's collections into memory, mapped to the app's types;
     2. run the existing `api` method with synchronous reads from that in-memory copy;
     3. compare the collections it wrote with what was loaded, row by row → `INSERT` / `UPDATE` / `DELETE` in foreign-key order, with `RETURNING`;
     4. insert the queued audit events;
     5. `COMMIT`.
2. **`api/index.ts` changes only its imports and `currentRole` / `currentActor`.** Every validation, message, audit label and calculation stays exactly as it is.
3. **What doesn't run in pg mode:**
   - `ensureSeeded`, `latency`, demo seeding, `migrateStorage`;
   - `admin.resetDemoData`, `clearAllData` and `restoreBackup`: not offered and refused for every role, DEV included (D-9, §3.5a). `exportBackup` becomes a read-only export of the Fuel tables (DEV);
   - `nextSeq` for payments: the database assigns `payment_no`, read back with `RETURNING`.
4. **Loading cost.** Each request loads the phase-1 tables (about 17). With a fresh start at go-live that is small for a long time.
   - *Ceiling:* the cost grows with diesel entries, roughly 10–20 thousand a year.
   - *Upgrade path:* when a request gets slow, replace its biggest read (stock checks, ledgers) with a targeted query or the `fuel.tanker_movements` / `adblue_stock_movements` views.

### 5.3 Browser to server
- **One endpoint:** a Route Handler `app/api/erp/route.ts` receiving `POST { method: "diesel.create", args: [...] }`.
  - It checks `method` against an **allowlist** of `api` methods, and validates arguments with the existing `zod`.
  - It runs the method in the pg unit of work and returns JSON or a mapped error (§9).
- **In the browser, with the database backend on,** `api` is a small stub with the same shape that posts to that endpoint. **`hooks.ts`, query keys and components don't change.**
- **Imports:** server modules import `server-only` (built into Next.js 16, no new package), so the database code can never reach the browser bundle.
- **Cross-tab refresh:** with the database backend there is no `storage` event. TanStack Query refetches after each write (`invalidateQueries`, as today) and on window focus. Live updates from other users (Realtime) aren't needed in phase 1.

## 6. Server-side database connection

| Variable | Where | Value |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | public | Project URL (auth only). Empty in `.env.local` today |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | public | `sb_publishable_…` (auth only). Empty today |
| `SUPABASE_DB_URL` | **server only** (never `NEXT_PUBLIC_`) | Supavisor pooler, **transaction mode, port 6543**, user `erp_server.<project-ref>` (M-1), `sslmode=require`. Set in Vercel per environment (S-6) |
| `NEXT_PUBLIC_DATA_BACKEND` | public, not secret | `local` (default) or `supabase` |
| `SUPABASE_SECRET_KEY` | server only | **Not used** by this plan. Keep empty (S-8) |

**Driver:**
- One new runtime dependency: **`postgres`** (porsager), `ssl: "require"`.
- `prepare: false`: transaction-mode pooling doesn't support prepared statements.
- A small pool per server instance (`max: 1`–`3`).

**Why transaction pooling is safe:** everything request-specific is set **inside** the transaction with `SET LOCAL` / `set_config(…, true)`, so it ends at `COMMIT` or `ROLLBACK` and never leaks to the next client on the same pooled connection.

**Before go-live:** run a test on the live 17.x project to confirm that `auth.uid()` reads `request.jwt.claims` there. The local check used a stand-in.

## 7. Transactions (one per business operation)

```
BEGIN
  SET LOCAL ROLE authenticated;                                  -- RLS applies to everything below
  SELECT set_config('request.jwt.claims', <verified claims JSON>, true);
  SET LOCAL statement_timeout = '15s';
  SELECT pg_advisory_xact_lock(<one ERP write key>);             -- writes only
  …load collections → run api.<method> → apply the row changes → insert audit events…
COMMIT        -- the deferred stock checks and the audit-presence check run here; any failure rolls back everything
```

- **One global write lock** keeps today's behaviour, where `tx()` lets only one write run at a time.
  - Loading happens **after** the lock, so each write validates against the latest committed data.
  - *Ceiling:* one write at a time company-wide, a few tens of milliseconds each, fine for a handful of users. *Upgrade path:* per-tanker / per-station locks.
- **Reads** (`list`, `get`) use the same opening statements without the lock, in a read-only transaction.
- **Retry:** on a serialization failure or deadlock (`40001` / `40P01`), retry once. Never retry anything else.

## 8. Audit

- **`audit()` keeps building the event** with `buildEvent`: label, module, before / after snapshots, changes and reason, unchanged. It queues the event instead of writing it to localStorage.
- **The unit of work inserts the queued events** in the same transaction, after the row changes. The deferred `require_audit` check then confirms every changed row has its event; otherwise the transaction rolls back.
- **The database sets `at` and `txid`.** The actor comes from the verified profile: `actor_user_id`, `actor_name`, `actor_role`. "Owner (unverified session)" disappears.
- **Restore / Push Back** re-inserts the record with its original id and `created_at`. The RESTORED event's `restores_event_id` is unique in the database, so a deletion can be restored only once.
- **History doesn't move.** Audit events from the browser stay in the browser; the database log starts at go-live (D-10).

**Account events (M-2):**
- **Written by the account functions themselves**, in the same statement as the change. A change without its event is impossible.
- **Fields:**
  - module `Accounts`, record type `User account`, record id = the profile id;
  - action CREATED (account added, bootstrap), UPDATED (role change, recovery, first sign-in activation), ARCHIVED (deactivation) or RESTORED (reactivation);
  - before / after snapshot of email, role, status and "linked: yes / no" (never tokens), plus the reason.
- **Sessions can't forge account events:** the session insert policy refuses module `Accounts`, so only the functions write them.
- **Who can read them:** DEV and OWNER (the `audit` view permission). The Owners can see every account change DEV makes.
- **Sign-ins themselves** are recorded by Supabase Auth's own log.

**Immutability:**
- `audit.events` / `audit.reviews` already refuse UPDATE, DELETE and TRUNCATE **for every role**, DEV included, in the app and as `authenticated`.
- **That covers every ERP user, DEV included.** Infrastructure administration is governed separately (§3.6, S-10).

## 9. Error handling

| Source | Shown to the user |
|---|---|
| The app's own checks (permission, month lock, stock, reason, duplicate) | **Today's message, unchanged.** They run first |
| Postgres `23505` unique | The constraint's business message, e.g. "A vehicle with this registration already exists" |
| Postgres `23514` check, `P0001` raised by a trigger (stock, "no audit event", month end) | The trigger's message (written in business language), or the mapped constraint message |
| `23503` foreign key | "This record is linked to … and can't be changed" |
| `42501` RLS / privilege | "Your role can't …" or "{Month} is locked…" |
| `40001` / `40P01` | One silent retry, then "Someone else saved at the same moment; please try again" |
| No ACTIVE profile / no session | 401 → `/login`; 403 "no ERP access" |
| Anything else | "Something went wrong; nothing was saved." Details go to the server log with a request id, **never** to the browser (no SQL text, no constraint names) |

## 10. Module order (starting with Diesel)

Every Diesel write touches vehicles, customers, assignments, stations, tankers and month locks in the same transaction, so modules can't be split across backends in production. **Build and verify step by step on a development database; switch production once, for all Fuel modules together.**

| Step | Module | Proves |
|---|---|---|
| 0 | M-1 / M-2 migrations (approval), server context, storage interface, pg unit of work, `/api/erp`, client stub, error mapping | Infrastructure. Every existing suite still passes on `local` |
| 1 | Auth: login, callback, `proxy.ts`, DEV bootstrap, Settings → User accounts (DEV only): add account, role, deactivate / reactivate, recovery | Signed-out / uninvited / Employee / Owner / DEV behave correctly; Owner and Employee are refused every account operation in the server and the database |
| 2 | Masters: companies, vehicle types, customers, vehicles, drivers, assignments, status periods; month locks | Archive / restore, transfer, uniqueness, lock rules |
| 3 | Fuel stations + opening balance; **Diesel pump fills** | Ledger purchases; exact amounts; KM run |
| 4 | Tankers, loads, opening stock, transfers, adjustments, **tanker fills** | Per-tanker stock never below zero, also with two concurrent sessions |
| 5 | Station payments + TDS | Voucher numbers, paid-against month, one TDS per station per month |
| 6 | AdBlue purchases, stock draws, direct purchases | Stock and weighted-average cost |
| 7 | Audit Log in the database: list, history, review, restore | Restore once, review once; OWNER and DEV can, EMPLOYEE can't |
| 8 | Figure parity with the browser (offline acceptance suite; no staging project). Then on Production: apply the approved new migrations, DEV bootstrap, DEV adds the four accounts, each signs in once with Google, switch (`NEXT_PUBLIC_DATA_BACKEND=supabase`) | Owner sign-off; exactly 1 DEV, 2 OWNER, 2 EMPLOYEE ACTIVE |

**Rules for the whole integration:**
- **localStorage stays** as the fallback backend, unchanged.
- **No historical localStorage or Excel data is imported** (D-10).
- **The non-fuel modules** (Trips, Invoices, other Payments, Reports, Dashboard) stay on localStorage. They are Dev-only and unused in production. With the database backend on, they would point at customers and vehicles that live in the database, so **hide them in database mode until their own phase** (decision Q-4).
- **Settings:** companies and vehicle types move to the database. The other settings (rates, bank details for invoices) stay local with their modules.

## 11. Missing database capabilities (new migrations; each needs the owner's approval)

| # | Migration | Why |
|---|---|---|
| M-1 | `create role erp_server login noinherit` + `grant authenticated to erp_server`, nothing else. **The password is set by the administrator in the SQL editor, never in git.** Check that Supavisor accepts the custom user with a read-only connection test after applying it (no staging project) | The server's database login (X-4, S-4). `NOINHERIT` means it holds no privileges until `SET LOCAL ROLE authenticated`, so RLS always applies |
| M-2 | **Accounts, DEV only:**<br>• `private.is_dev()`<br>• `private.bootstrap_first_dev(email)` (execute: `postgres` only; works once)<br>• `public.link_google_account()` (any signed-in user: links their own Google identity, verified by Google, to the pre-created account with that email)<br>• `public.add_account`, `set_account_role`, `set_account_status`, `relink_account` (DEV only, checked by name; reason required; the last ACTIVE DEV protected)<br>Also: an RLS policy letting DEV read all profiles; the audit insert policy amended to refuse module `Accounts` from sessions. Each function is `security definer`, `search_path = ''`, and writes its audit event in the same statement | Provisioning (X-5), DEV-only account management, account auditing (X-6) |
| M-3 | *(optional)* `revoke execute` on `private` functions that RLS doesn't need, from `authenticated` | Smaller attack surface if S-3 is ever misconfigured |
| M-5 | **DEV inherits the Owner-level controls; wildcard inverted.** A new migration, leaving the applied files unchanged:<br>• `create or replace private.month_open` using `is_owner_or_dev()`<br>• recreate the policies "Owner locks months" / "Owner unlocks months" with `is_owner_or_dev()` and `changed_by_role = private.erp_role()`<br>• recreate "Write own audit events" so restores and month-lock events need `is_owner_or_dev()`<br>• recreate "Owner reviews deletions" as OWNER or DEV with `actor_role = private.erp_role()`<br>• `core.role_permissions`: DEV `*`, OWNER per-resource (every resource except `DEV_ONLY`) | Today the deployed database refuses DEV every Owner-level control (`is_owner()` in 6 places; `'OWNER'` pinned in 2 policies), and OWNER's `*` would match a future DEV-only resource |
| M-4 | *(optional)* Auth "before user created" hook refusing emails with no pre-created account | Keeps `auth.users` free of unapproved Google accounts (S-7) |

No change to the 8 applied migrations is needed or proposed.

**Status of M-2 (1 Nov 2026):** written as `supabase/migrations/20261101000700_accounts.sql` and tested offline (`check:supabase`); **not yet applied to Production**. Implementation choices approved with it:
- The callable account functions live in **`public`**, so the Next.js server calls them with the signed-in user's own session through the Data API. The server checks DEV by name first, and the database checks again.
- M-1 (server login role and `SUPABASE_DB_URL`) is therefore not needed for account management; it comes with the Diesel integration.
- A deferred `profiles_require_audit` trigger refuses any account change without its audit event.
- The bootstrap and the audit writer stay in `private`, executable by no API role.
- M-5 waits for the business integration, because it must land together with the app's permission changes.

## 12. Testing

1. **Unchanged:** the 11 existing suites keep running on the localStorage backend in `npm run check`.
2. **New offline acceptance suite:**
   - Run the same API suites (actions, audit, restore, roles, tankers, month, fresh-start) through the **pg unit of work on PGlite**, with the real migrations.
   - The suites drive `api.*`, so passing them proves the adapter keeps every business rule.
   - The database driver sits behind a two-function interface (`query`, `transaction`), implemented by `postgres` in production and PGlite in tests.
3. **~~Staging Supabase project~~ — superseded: there is no staging project (owner's decision).** The scenarios below run offline in PGlite wherever possible. What can't (two concurrent sessions, a real Google sign-in, Data API exposure) is checked on Production only with the real accounts and read-only queries, never with test data:
   - the same suites against the real 17.x server;
   - **concurrency:** two connections drawing from one tanker at once (stock locks), and two payments at once (voucher numbers);
   - **auth end to end:** signed out → nothing; Google account without a pre-created account → nothing; Employee → no money, no deletes, no locked month, no administration; Owner → all business data and Owner-level controls, **no account or system operation**; DEV → everything Owner can (month lock, locked-month edits, review, restore) **plus** every account and system operation; audit rows can't be updated or deleted by anyone, DEV included;
   - **wildcard safety:** `can("OWNER", <DEV_ONLY resource>)` is false, and `private.can` agrees, even though OWNER holds `FULL_ACCESS`;
   - **account operations:** each one refused to OWNER and EMPLOYEE by the server **and** by the database function called directly; the last ACTIVE DEV can't be demoted or disabled; deactivation blocks the very next request; recovery moves access to the new email; every operation leaves exactly one `Accounts` audit event, and a session can't insert one by hand;
   - **Data API exposure:** the REST and GraphQL endpoints can't reach `core`, `fuel`, `finance`, `audit` or `private` (S-3).
4. **Figure parity:** for a sample period, station ledger, per-tanker stock and AdBlue stock match the browser to the paisa (D-12 aside).

## 13. Rollback

| Situation | Rollback |
|---|---|
| Problems after switching to the database | Set `NEXT_PUBLIC_DATA_BACKEND=local` and redeploy. localStorage was never touched. Entries made in the database meanwhile can be exported from the Fuel tables |
| A new migration (M-1 … M-4) is wrong | Revert with a new migration (drop the role / functions). Never edit an applied one |
| Bad data written | Restore / Push Back per record (audited), or point-in-time recovery into a new project (D-13) |
| Code regression | Revert the commit. The backend switch makes the database path inactive by default |

## 14. Decisions for approval (final, 1 Nov 2026)

**Settled by the owner:**
- DEV has every Owner power plus exclusive administration (§3.1).
- OWNER administers neither accounts nor the system.
- EMPLOYEE is unchanged.
- Audit history is immutable for everyone, DEV included.
- DEV administers the Supabase infrastructure, governed by §3.6.
- **No staging project:** the existing Production project is used directly (decided after this list was first written); no test data or test accounts are created there.
- **D-9 kept:** no Reset All, Clear All or Restore from file against the shared database; recovery by Supabase backups and point-in-time recovery. DEV's permissions are not reduced (§3.5a).
- The Owners can see account audit events.

| # | For approval | Recommendation |
|---|---|---|
| Q-1 | ~~Staging project~~ | **Superseded:** the owner decided to use the existing Production project directly (see the risks and their handling below) |
| Q-2 | New migrations, each checked offline and with a dry run before Production: **M-1** `erp_server` login role; **M-2** DEV-only account functions (bootstrap, Google sign-in linking, add account, role, deactivate / reactivate, recovery, account audit events); **M-5** DEV inherits the Owner-level controls in the database, and the inverted wildcard. Optional M-3, M-4 | Approve M-1, M-2, M-5 |
| Q-3 | Backend: one allowlisted Route Handler + client stub, the unit-of-work adapter (§5); permission enforcement as in §3.1 / §4 | Approve |
| Q-4 | Hide the non-fuel modules when the database backend is on | Hide until their phase |
| Q-5 | Dashboard settings on the Production project: Data API exposed schemas = `public` (+ `graphql_public`) only; asymmetric JWT signing keys; Google the only provider (Email, Phone and Anonymous off); MFA on every admin account | Yes |
| Q-6 | Add the `postgres` driver (one new dependency) | Approve |
| Q-7 | Run the read-only catalog query (Appendix A) on Production | Done for the baseline (step 0, 1 Nov 2026); re-run after each migration |
| Q-8 | Confirm the settings classification in §3.5: operational settings = DEV and OWNER; system configuration = DEV only (accounts, permission definitions, application-wide settings, backend / environment, read-only export). **Reset All / Clear All / Restore from file stay unavailable against the shared database for every role (D-9, §3.5a).** The localStorage fallback keeps its browser-only tools unchanged | Approve as listed |
| Q-9 | Supply the DEV email and say which two of the original four are Owners and which two are Employees | At provisioning time, never in git |
| Q-10 | Optional infrastructure controls (§3.6): scheduled audit export to Owner storage; an Owner read-only seat in the Supabase organisation | Approve the audit export; the seat is optional |

**Contradiction review:**
- Every statement of the plan was checked against §3.1. The superseded items are now replaced: "Owner-only" controls refused to DEV, the Owner as organisation owner, and Owner-managed accounts.
- **What still contradicts the decisions** is only in existing files that this planning task may not change: CLAUDE.md, `permissions.ts`, the API's Owner-by-name checks, the check suites, `SUPABASE_SETUP.md` (all listed in §3.1), and the deployed database's `is_owner()` checks (fixed by M-5).

### Q-1 in detail: working directly on Production (decided)

The owner decided to use the existing Production project; there is no staging project. The risks below still hold and are handled by: offline tests (PGlite) before every change, `supabase db push --dry-run` before every push, no test data or test accounts in Production, read-only verification queries, and the owner's go-ahead for each Production step.

**Risks of working directly on the Production project:**
1. **Test data can never be removed from the audit trail.** `audit.events` refuses UPDATE / DELETE / TRUNCATE for every role. Every test entry, deletion and restore would sit in Production's audit log permanently, next to real history. Removing it would mean disabling the append-only trigger, which is itself tampering.
2. **Test data mixes with go-live data.** Test fills, loads and payments would change station ledgers, tanker stock and carry-forward unless every row is cleaned up, and each clean-up is itself audited.
3. **Voucher numbers are used up:** test payments consume `{prefix}-PAY-{FY}-0001…`, so real vouchers wouldn't start at 0001.
4. **Unreviewed migrations reach Production.** M-1, M-2 and later fixes would be applied there before they were proven. A faulty migration can't simply be undone (fixes are new migrations), and a destructive mistake needs point-in-time recovery.
5. **Production credentials spread:** `SUPABASE_DB_URL` for Production would sit on development machines and in Vercel Preview deployments.
6. **Test accounts end up in Production auth:** test Google accounts and test account rows would pollute `auth.users` and `public.profiles` before the five real accounts exist.
7. **This machine's CLI is linked to Production** (`supabase/.temp/linked-project.json`), so any `supabase db push` or `migration repair` run during development would hit Production.

**~~Recommended staging approach~~ — superseded and removed.** The owner decided against a staging project (1 Nov 2026).

---

## Appendix A — read-only catalog query (for the owner to run in the SQL editor)

It only reads system catalogs and changes nothing. Paste its JSON result back, and it can be compared with the same query run locally on the migrations in PGlite.

```sql
with s(n) as (values ('core'), ('fuel'), ('finance'), ('audit'), ('private'), ('public'))
select json_build_object(
  'server_version', current_setting('server_version'),
  'migrations', (select json_agg(version order by version) from supabase_migrations.schema_migrations),
  'erp_role', (select json_agg(e.enumlabel order by e.enumsortorder) from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'erp_role'),
  'tables', (select json_agg(format('%s.%s rls=%s', schemaname, tablename, rowsecurity) order by schemaname, tablename) from pg_tables where schemaname in (select n from s)),
  'columns', (select json_agg(format('%s.%s.%s %s %s%s', table_schema, table_name, column_name, data_type, case when is_nullable = 'NO' then 'not null' else 'null' end, case when is_generated = 'ALWAYS' then ' generated' else '' end) order by table_schema, table_name, ordinal_position) from information_schema.columns where table_schema in (select n from s)),
  'constraints', (select json_agg(format('%s %s %s', conrelid::regclass, conname, contype) order by conrelid::regclass::text, conname) from pg_constraint where connamespace in (select oid from pg_namespace where nspname in (select n from s))),
  'indexes', (select json_agg(schemaname || '.' || indexname order by schemaname, indexname) from pg_indexes where schemaname in (select n from s)),
  'views', (select json_agg(schemaname || '.' || viewname order by schemaname, viewname) from pg_views where schemaname in (select n from s)),
  'functions', (select json_agg(p.oid::regprocedure::text || case when p.prosecdef then ' [definer]' else '' end order by p.oid::regprocedure::text) from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace where ns.nspname in (select n from s)),
  'triggers', (select json_agg(format('%s %s%s', tgrelid::regclass, tgname, case when tgdeferrable then ' [deferred]' else '' end) order by tgrelid::regclass::text, tgname) from pg_trigger where not tgisinternal and tgrelid in (select c.oid from pg_class c join pg_namespace ns on ns.oid = c.relnamespace where ns.nspname in (select n from s))),
  'policies', (select json_agg(format('%s.%s "%s" %s %s', schemaname, tablename, policyname, cmd, roles) order by schemaname, tablename, policyname) from pg_policies where schemaname in (select n from s)),
  'table_grants', (select json_agg(format('%s.%s %s %s', table_schema, table_name, grantee, privilege_type) order by table_schema, table_name, grantee, privilege_type) from information_schema.role_table_grants where table_schema in (select n from s) and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')),
  'schema_usage', (select json_agg(format('%s anon=%s authenticated=%s', nspname, has_schema_privilege('anon', oid, 'USAGE'), has_schema_privilege('authenticated', oid, 'USAGE')) order by nspname) from pg_namespace where nspname in (select n from s)),
  'postgres_can_set_role_authenticated', pg_has_role('postgres', 'authenticated', 'MEMBER')
) as catalog;
```
