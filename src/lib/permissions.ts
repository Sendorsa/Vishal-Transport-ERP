import type { LegacyRole, Role } from "./types"

/**
 * `resource:action` permission map. The backend will enforce the same strings
 * (RLS + API guards); the UI only hides what a role cannot do.
 */
export const RESOURCES = [
  "dashboard",
  "finance", // money KPIs: receivables, payables, profit
  "customers",
  "vehicles",
  "trips",
  "diesel",
  "adblue", // AdBlue inventory and vehicle AdBlue entries (owner, 11 Nov 2026: its own resource, out of "diesel")
  "tyres", // Tyre Data → Tyre: tyre / repair invoices and their masters (owner, 17 Nov 2026)
  "expenses", // Expense: Road Tax, Insurance, Fitness, Fines, Broker Charges (owner, 25 Nov 2026) — unreleased: Dev only
  "invoices",
  "payments",
  "reports",
  "settings",
  "audit", // central Audit Log — view only; Owner, Dev and Employee
  "accounts", // ERP user accounts (add, role, deactivate, recovery) — Dev only
  "system", // system configuration: permission definitions, data backend, read-only data export — Dev only
] as const
export type Resource = (typeof RESOURCES)[number]

/**
 * Resources only Dev may use (owner's decision, 3 Nov 2026): account and system administration. `can()` refuses them
 * to every other role whatever the map says, so no wildcard or shared list can ever grant them to the Owner.
 */
export const DEV_ONLY: readonly Resource[] = ["accounts", "system"]

/**
 * Business modules still in development, Dev only until the owner releases them (temporary — not administration, so
 * not DEV_ONLY). `can()` refuses them to every other role; the Owner's map already lists them (BUSINESS_ACCESS), so
 * releasing one = removing it here (and, on the shared database, its role_permissions rows). Expense: owner, 25 Nov 2026.
 */
export const UNRELEASED: readonly Resource[] = ["expenses"]

/** Every business module, every action — the Owner's list. Excludes the Dev-only resources. */
const BUSINESS_ACCESS: Permission[] = RESOURCES.filter((r) => !DEV_ONLY.includes(r)).map((r) => `${r}:*` as const)

export type Action = "view" | "create" | "edit" | "delete" | "finance"
export type Permission = `${Resource}:${Action}` | `${Resource}:*` | "*"

export const ROLES: { value: Role; label: string; description: string }[] = [
  { value: "OWNER", label: "Owner", description: "Every business module and Owner-level control (month locks, restore, deletion review); no account or system administration" },
  { value: "DEV", label: "Dev", description: "Everything the Owner can do, plus exclusive account and system administration" },
  { value: "EMPLOYEE", label: "Employee", description: "Everything the Owner can do except Settings, locking months and deleting records" },
  { value: "TATA_ADBLUE", label: "Tata Adblue", description: "AdBlue entries (add / edit) for the customers Dev assigns, bulk purchases into the shared stock; Diesel read-only for those customers" },
  { value: "ADBLUE", label: "Adblue", description: "AdBlue entries (add / edit) for every customer, bulk purchases into the shared stock; Diesel read-only for every customer" },
]

/**
 * Dev holds "*" and is the only role that may (owner, 3 Nov 2026: Dev inherits every Owner business permission and
 * alone administers accounts and the system). A new business module reaches the Owner through BUSINESS_ACCESS.
 */
const MAP: Record<Role, Permission[]> = {
  DEV: ["*"],
  OWNER: BUSINESS_ACCESS,
  // Owner's instruction, 5 Nov 2026: the Owner's access and Owner-level controls, except Settings.
  EMPLOYEE: BUSINESS_ACCESS.filter((p) => p !== "settings:*"),
  // Owner's instruction, 11 Nov 2026: AdBlue (entries create / edit / delete, bulk purchases) and Diesel read-only.
  // Tata Adblue is further limited to the customers Dev assigns (customerScope in src/lib/identity.ts, RLS).
  TATA_ADBLUE: ["diesel:view", "adblue:*"],
  ADBLUE: ["diesel:view", "adblue:*"],
}

/**
 * Deleting any record: the Owner and Dev only (owner, 16 Nov 2026) — every role's `delete` goes through here (API
 * assertCan, the UI's useCan) and the database's private.can refuses it the same way. Archive / restore, edits and
 * Restore / Push Back of a deletion are not deletes.
 */
export const canDelete = (role: Role) => role === "OWNER" || role === "DEV"

export function can(role: Role, resource: Resource, action: Action = "view") {
  if ((DEV_ONLY.includes(resource) || UNRELEASED.includes(resource)) && role !== "DEV") return false
  if (action === "delete" && !canDelete(role)) return false
  const perms = MAP[role]
  return perms.includes("*") || perms.includes(`${resource}:*`) || perms.includes(`${resource}:${action}`)
}

/**
 * Owner-level business controls — deletion review and its badge, Restore / Push Back, opening balances and opening
 * stock: the Owner, Dev and (owner, 5 Nov 2026) the Employee, tested by name (never through can()). Settings → Data
 * (backup, restore, reset, clear) also needs `settings`. Month lock / unlock is not one of them: see canSetMonthLock.
 */
export const hasOwnerAuthority = (role: Role) => role === "OWNER" || role === "DEV" || role === "EMPLOYEE"

/** Locking or unlocking a month: the Owner and Dev only — never the Employee (owner, 11 Nov 2026). */
export const canSetMonthLock = (role: Role) => role === "OWNER" || role === "DEV"

/** Changing data in a locked month (Monthly Sheet Lock): the Owner and Dev only — never the Employee (owner, 5 Nov 2026). */
export const canBypassMonthLock = (role: Role) => role === "OWNER" || role === "DEV"

/** The AdBlue profiles (owner, 11 Nov 2026): only AdBlue and Diesel, never another module (src/lib/server/erp/profiles.ts). */
export const isAdBlueProfile = (role: Role) => role === "TATA_ADBLUE" || role === "ADBLUE"

/**
 * Editing or deleting a bulk AdBlue purchase re-costs every customer's draws: the Owner, Dev and Employee only (by name,
 * with the `adblue` permission). The AdBlue profiles add purchases but never change them (owner, 11 Nov 2026).
 */
export const canChangeAdBluePurchases = (role: Role, action: "edit" | "delete") => can(role, "adblue", action) && hasOwnerAuthority(role)
/**
 * AdBlue supplier payments (owner, 18 Nov 2026): money owed to and paid to AdBlue vendors — the Owner, Dev and Employee
 * (view / record / edit), never the AdBlue profiles (they hold adblue:* for stock only); delete: the Owner / Dev (can()).
 * The database: private.can('adblue', …) and private.is_owner_or_dev().
 */
export const canManageAdBluePayments = (role: Role, action: "view" | "create" | "edit" | "delete") => can(role, "adblue", action) && hasOwnerAuthority(role)

/** Removed roles (31 Oct 2026), named only where history shows them: audit events and the audit log's role filter. */
export const LEGACY_ROLES: { value: LegacyRole; label: string }[] = [
  { value: "ACCOUNTANT", label: "Accountant (former role)" },
  { value: "OPS_MANAGER", label: "Operations Manager (former role)" },
]

export function roleLabel(role: Role | LegacyRole) {
  return [...ROLES, ...LEGACY_ROLES].find((r) => r.value === role)?.label ?? role
}
