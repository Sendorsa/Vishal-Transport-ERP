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
  "audit", // central Audit Log — view only; Owner and Dev
] as const
export type Resource = (typeof RESOURCES)[number]

/**
 * Resources only the Owner may use (none today). The Owner-only actions are refused to every other
 * role by name (`currentRole() !== "OWNER"`): deletion review and its badge, restore, month lock /
 * unlock, and changing data in a locked month (src/domain/month-lock.ts). Viewing the audit log is not
 * one of them: Dev has it too.
 */
export const OWNER_ONLY: readonly Resource[] = []

/** Every module, every action — except the Owner-only ones. The one list full-access roles share. */
const FULL_ACCESS: Permission[] = RESOURCES.filter((r) => !OWNER_ONLY.includes(r)).map((r) => `${r}:*` as const)

export type Action = "view" | "create" | "edit" | "delete" | "finance"
export type Permission = `${Resource}:${Action}` | `${Resource}:*` | "*"

export const ROLES: { value: Role; label: string; description: string }[] = [
  { value: "OWNER", label: "Owner", description: "Full access across both companies" },
  { value: "DEV", label: "Dev", description: "Every module and action, including viewing the audit log, without Owner-only controls (deletion review, restore, month locks)" },
  { value: "EMPLOYEE", label: "Employee", description: "Log trips and diesel fills" },
]

const MAP: Record<Role, Permission[]> = {
  OWNER: ["*"],
  // Full access minus Owner-only: shares FULL_ACCESS, so it follows every module added later.
  DEV: FULL_ACCESS,
  // Employees edit their own rows too; the month lock (src/domain/month-lock.ts) decides which months.
  EMPLOYEE: ["dashboard:view", "vehicles:view", "trips:view", "trips:create", "trips:edit", "diesel:view", "diesel:create", "diesel:edit"],
}

export function can(role: Role, resource: Resource, action: Action = "view") {
  const perms = MAP[role]
  return perms.includes("*") || perms.includes(`${resource}:*`) || perms.includes(`${resource}:${action}`)
}

/** Removed roles (31 Oct 2026), named only where history shows them: audit events and the audit log's role filter. */
export const LEGACY_ROLES: { value: LegacyRole; label: string }[] = [
  { value: "ACCOUNTANT", label: "Accountant (former role)" },
  { value: "OPS_MANAGER", label: "Operations Manager (former role)" },
]

export function roleLabel(role: Role | LegacyRole) {
  return [...ROLES, ...LEGACY_ROLES].find((r) => r.value === role)?.label ?? role
}
