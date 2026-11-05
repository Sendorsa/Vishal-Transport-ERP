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

/** Every business module, every action — the Owner's list. Excludes the Dev-only resources. */
const BUSINESS_ACCESS: Permission[] = RESOURCES.filter((r) => !DEV_ONLY.includes(r)).map((r) => `${r}:*` as const)

export type Action = "view" | "create" | "edit" | "delete" | "finance"
export type Permission = `${Resource}:${Action}` | `${Resource}:*` | "*"

export const ROLES: { value: Role; label: string; description: string }[] = [
  { value: "OWNER", label: "Owner", description: "Every business module and Owner-level control (month locks, restore, deletion review); no account or system administration" },
  { value: "DEV", label: "Dev", description: "Everything the Owner can do, plus exclusive account and system administration" },
  { value: "EMPLOYEE", label: "Employee", description: "Everything the Owner can do except Settings" },
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
}

export function can(role: Role, resource: Resource, action: Action = "view") {
  if (DEV_ONLY.includes(resource) && role !== "DEV") return false
  const perms = MAP[role]
  return perms.includes("*") || perms.includes(`${resource}:*`) || perms.includes(`${resource}:${action}`)
}

/**
 * Owner-level business controls — month lock / unlock, changing a locked month, deletion review and its badge,
 * Restore / Push Back, opening balances and opening stock: the Owner, Dev and (owner, 5 Nov 2026) the Employee,
 * tested by name (never through can()). Settings → Data (backup, restore, reset, clear) also needs `settings`.
 */
export const hasOwnerAuthority = (role: Role) => role === "OWNER" || role === "DEV" || role === "EMPLOYEE"

/** Removed roles (31 Oct 2026), named only where history shows them: audit events and the audit log's role filter. */
export const LEGACY_ROLES: { value: LegacyRole; label: string }[] = [
  { value: "ACCOUNTANT", label: "Accountant (former role)" },
  { value: "OPS_MANAGER", label: "Operations Manager (former role)" },
]

export function roleLabel(role: Role | LegacyRole) {
  return [...ROLES, ...LEGACY_ROLES].find((r) => r.value === role)?.label ?? role
}
