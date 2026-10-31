# Vishal Transport ERP — frontend prototype

High-fidelity, frontend-only prototype for Vishal Group (VT, the primary company, managing VTHPL).
No backend, no auth: all data lives in the browser's **localStorage**, seeded with about 6 months of realistic demo data that ends today.

```bash
npm install
npm run dev        # http://localhost:3000
npm run build      # production build
npm run lint
npm run typecheck
npm run check      # every business-rule check (diesel, audit, actions, restore, roles, backup, tankers, month, fresh start, Supabase)
```

## What's inside

| Module | Routes |
|---|---|
| Dashboard | `/dashboard` (`/` opens Fuel Stations): KPIs, revenue/expense trends, customer and vehicle profitability, overdue, compliance, ready-to-bill |
| Customers | `/customers`, `/customers/new`, `/customers/[id]`: pricing terms, invoices, trips, profitability |
| Vehicles | `/vehicles`, `/vehicles/new`, `/vehicles/[id]`: insurance, road tax, maintenance, diesel, profitability |
| Trips | `/trips`, `/trips/new`, `/trips/[id]`: revenue priced from the customer's pricing model |
| Diesel | Diesel → Month → Customer → Vehicle → Entries (see `../CLAUDE.md`). `/diesel`: month selector, KPI cards, Add Customer, customer cards. `/diesel/[customer]`: customer summary, monthly summary, vehicle list (+ Add vehicle). `/diesel/[customer]/[month]/[vehicle]`: vehicle information, diesel entries + **Add Diesel Entry**, monthly history. `/diesel/[customer]/[month]` redirects to the customer page in that month. `/diesel/ledger`: all fills + vendor payables (from the dashboard Payables card). `/diesel/monthly-master` and `/diesel/yearly-master`: master sheets by customer, vehicle and pump (design in `../CLAUDE.md`) |
| Invoices | `/invoices`, `/invoices/new`, `/invoices/[id]`: bill unbilled trips, GST split, receipts, print |
| Fuel Stations | `/fuel-stations`, `/fuel-stations/[id]`: station master, ledger (opening + purchased − paid = closing), payments, TDS |
| Diesel Tankers | `/tanker`: JIO / Office / Mini stock, loads, transfers, adjustments, opening stock |
| AdBlue | `/adblue`: bulk purchases, stock, direct vendor purchases |
| Payments | `/payments`: incoming (with TDS + allocation) and outgoing, history |
| Reports | `/reports`: customer and vehicle profitability, diesel, P&L, cash flow, receivables aging (CSV export) |
| Settings | `/settings`: company profiles, expense heads, drivers, vehicle types, backup / restore / reset data |
| User accounts | `/settings/users` (and `/login`, `/auth/callback`): Google sign-in only; DEV adds accounts (no email is sent; status "Approved · not signed in yet" until the person's first Google sign-in), changes roles, deactivates / reactivates and recovers accounts (Supabase) |
| Audit Log | `/audit`: every change with before / after (Owner and Dev); deletion review and restore (Owner) |

**Sign-in:** every page requires Google sign-in with an ACTIVE pre-created account (`/login`; gate in `src/proxy.ts` + `src/lib/auth/gate.ts`). The role (Owner / Dev / Employee — see `src/lib/permissions.ts`) comes from that account; the top bar shows it, with Sign out, and switches **company** (Group / VT / VTHPL).

## Architecture (built to swap in the real backend)

```
src/
  app/                 thin route files (server components; await params/searchParams)
  features/<module>/   page-level client components per module
  components/shared/   DataTable, StatsCard, PageHeader, FilterBar/SearchBar, ChartCard,
                       EntityDrawer, FormModal, StatusBadge, …
  components/ui/       shadcn/ui (radix-nova)
  domain/              pure business logic: pricing, invoicing, analytics, periods
  lib/api/             the "backend": Repository interface + services + TanStack Query hooks
  lib/storage/         localStorage access (column-encoded) + deterministic seed generator
  lib/types.ts         domain types (planned Supabase tables: docs/SUPABASE_DIESEL_DATABASE_SCHEMA.md)
  lib/supabase/        Supabase clients and env guard (foundation only — nothing imports them yet)
```

- **Components never touch localStorage.** They use hooks in `lib/api/hooks.ts`, which call `api.*` in `lib/api/index.ts`.
  To connect the real API, replace `createLocalRepository` / the `api` methods with HTTP calls. Query keys and components stay as they are.
- Rules the server will own (document numbering, trip pricing, invoice totals, allocation limits) live in `lib/api` + `domain`, not in UI.
- Outstanding and payment status are **derived** from receipt allocations, never stored.
- Storage keys: one per collection (`STORAGE_NAME` in `src/lib/storage/local-store.ts`: `vt:customers`, `vt:vehicles`, `vt:fuelEntries`, `vt:fuelStations`, `vt:tankers`, `vt:tankerLoads`, `vt:adBluePurchases`, `vt:payments`, …), `vt:settings`, `vt:vehicleTypes`, the audit trail (`vt:auditEvents`, `vt:auditReviews`), plus `vt:ui:role` / `vt:ui:company` / `vt:ui:dieselMonth` for the mock session. Older layouts (`vt:diesel_entries`, lists inside `vt:settings`, `fuelType` on entries) are migrated on first load by `migrateStorage` in `src/lib/storage/local-store.ts`.
- Fuel type (Diesel / Petrol / EV) is a property of the **vehicle**; fuel entries never store it. All diesel formulas: `docs/DIESEL_CALCULATIONS.md`, checked by `npm run check:diesel`.

## Business rules used in the demo

- **Diesel is costed to a customer** — the customer the vehicle was assigned to on the fill date (`vt:vehicleAssignments`). KM Run comes from fill odometers (current − previous fill); Diesel Cost per KM = diesel spend ÷ KM Run; KM per Litre = KM Run ÷ litres (`docs/DIESEL_CALCULATIONS.md`).
  - **One reporting month for the whole module.** It's picked from the dropdown, stored in `vt:ui:dieselMonth`, and carried through every diesel page.
  - **Current month** is compared with the same days of the previous month.
  - **No rankings, efficiency scores, performance insights or analytics charts** in Diesel, per `CLAUDE.md`. Every KPI card states its period and has an ⓘ explaining the calculation.

- Revenue = completed trips, ex-GST (accrual). Expenses = diesel fills + payments in "P&L expense" heads.
  Diesel vendor settlements and GST remittances are settlements, not expenses.
- Fuel station payables come from each station's ledger (`src/domain/station-ledger.ts`): opening + fuel purchased − payments made = closing.
- GST: CGST+SGST when the customer's state matches the billing company's, otherwise IGST. Customer TDS 2% (194C) on basic.
- Customer and vehicle profitability are *contribution*: vehicle costs are allocated to customers by km share, and office overheads are excluded.
