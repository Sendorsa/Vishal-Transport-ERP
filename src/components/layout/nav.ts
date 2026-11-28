import {
  ArrowLeftRight,
  BarChart3,
  Container,
  Droplets,
  Bus,
  CircleDot,
  ClipboardCheck,
  FileText,
  Gavel,
  Handshake,
  IdCard,
  Landmark,
  ShieldCheck,
  Fuel,
  LayoutDashboard,
  Route,
  ScrollText,
  Settings,
  Store,
  Users,
  type LucideIcon,
} from "lucide-react"
import { can, expenseSectionAllowed, isAdBlueProfile, type Resource } from "@/lib/permissions"
import type { ExpenseSection, Role } from "@/lib/types"

/**
 * Sidebar sections, in display order. Add a section here (e.g. a future "Fleet") and tag its items
 * with it — the sidebar renders every section with the same header style.
 */
export const NAV_GROUPS = ["Overview", "Operations", "Fuel", "Tyre Data", "Expense", "Finance", "System"] as const
export type NavGroup = (typeof NAV_GROUPS)[number]

export interface NavItem {
  title: string
  href: string
  icon: LucideIcon
  resource: Resource
  group: NavGroup
  mobile?: boolean
  /** Shorter label for the phone tab bar. */
  short?: string
  /** `false`: never fills a phone tab slot — the item stays one tap away under "More". */
  tab?: false
  /** An Expense section's page: shown only to a role that may use that section (EMP 1: no Insurance — owner, 28 Nov 2026). */
  expenseSection?: ExpenseSection
}

export const NAV_ITEMS: NavItem[] = [
  { title: "Dashboard", href: "/dashboard", icon: LayoutDashboard, resource: "dashboard", group: "Overview", mobile: true },
  { title: "Customers", href: "/customers", icon: Users, resource: "customers", group: "Operations" },
  { title: "Vehicles", href: "/vehicles", icon: Bus, resource: "vehicles", group: "Operations", tab: false },
  // Drivers (owner, 27 Nov 2026): the central driver master — with the vehicles permission, like Vehicles.
  { title: "Drivers", href: "/drivers", icon: IdCard, resource: "vehicles", group: "Operations", tab: false },
  { title: "Trips", href: "/trips", icon: Route, resource: "trips", group: "Operations", mobile: true },
  // Fuel: fuel-related modules (future: fuel vendors, analytics, reconciliation, purchase orders).
  { title: "Fuel Stations", short: "Stations", href: "/fuel-stations", icon: Store, resource: "diesel", group: "Fuel" },
  { title: "Diesel", href: "/diesel", icon: Fuel, resource: "diesel", group: "Fuel", mobile: true },
  { title: "Diesel Tankers", short: "Tankers", href: "/tanker", icon: Container, resource: "diesel", group: "Fuel" },
  { title: "AdBlue", href: "/adblue", icon: Droplets, resource: "adblue", group: "Fuel" },
  // Tyre Data (owner, 17 Nov 2026): tyre / repair invoices.
  { title: "Tyre", href: "/tyre", icon: CircleDot, resource: "tyres", group: "Tyre Data" },
  // Expense (owner, 25 Nov 2026). Permission `expenses`: Dev, the Owner (28 Nov 2026) and EMP 1 without Insurance
  // (UNRELEASED_ROLES, HIDDEN_EXPENSE_SECTIONS in permissions.ts) — never the Employee.
  { title: "Road Tax", href: "/road-tax", icon: Landmark, resource: "expenses", group: "Expense", tab: false, expenseSection: "ROAD_TAX" },
  { title: "Insurance", href: "/insurance", icon: ShieldCheck, resource: "expenses", group: "Expense", tab: false, expenseSection: "INSURANCE" },
  { title: "Fitness", href: "/fitness", icon: ClipboardCheck, resource: "expenses", group: "Expense", tab: false, expenseSection: "FITNESS" },
  { title: "Fines", href: "/fines", icon: Gavel, resource: "expenses", group: "Expense", tab: false, expenseSection: "FINE" },
  { title: "Broker Charges", short: "Broker", href: "/broker-charges", icon: Handshake, resource: "expenses", group: "Expense", tab: false, expenseSection: "BROKER" },
  { title: "Invoices", href: "/invoices", icon: FileText, resource: "invoices", group: "Finance", mobile: true },
  { title: "Payments", href: "/payments", icon: ArrowLeftRight, resource: "payments", group: "Finance" },
  { title: "Reports", href: "/reports", icon: BarChart3, resource: "reports", group: "Finance" },
  { title: "Settings", href: "/settings", icon: Settings, resource: "settings", group: "System" },
  // `audit` permission: Owner, Dev and Employee.
  { title: "Audit Log", href: "/audit", icon: ScrollText, resource: "audit", group: "System" },
]

/**
 * Sidebar visibility only — not a permission (owner, 4 Nov 2026). Dev sees every item its role can use, unchanged.
 * The Owner and the Employee see only the Fuel and Tyre Data sections and the Audit Log (Settings and every other
 * section hidden; Tyre Data added 17 Nov 2026, Expense 25 Nov 2026) — plus Operations → Vehicles (21 Nov 2026) and Drivers (27 Nov 2026) for both, and, for the Owner
 * only, Finance → Payments (owner, 18 Nov 2026); the Audit Log needs the `audit` permission (`navFor`); Settings needs
 * `settings`, which the Employee doesn't have. Hidden modules keep their routes, permissions and API access
 * (src/lib/permissions.ts).
 */
export const showInNav = (role: Role, item: NavItem) =>
  (!item.expenseSection || expenseSectionAllowed(role, item.expenseSection)) &&
  (isAdBlueProfile(role)
    ? PROFILE_NAV.includes(item.href)
    : role === "DEV" || item.group === "Fuel" || item.group === "Tyre Data" || item.group === "Expense" || item.href === "/audit" || item.href === "/vehicles" || item.href === "/drivers" || (role === "OWNER" && OWNER_EXTRA_NAV.includes(item.href)))

/** Finance pages the Owner sees in the sidebar besides Fuel / Tyre Data / Audit Log (owner, 18 Nov 2026): Payments only. */
const OWNER_EXTRA_NAV = ["/payments"]

/** Tata Adblue and Adblue (owner, 11 Nov 2026): AdBlue, then Diesel — nothing else, in the sidebar or on the phone. */
const PROFILE_NAV = ["/adblue", "/diesel"]

export function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`)
}

/** The sidebar items a role sees (permission + sidebar visibility) — also everything in the phone drawer ("More"). */
export function navFor(role: Role) {
  const items = NAV_ITEMS.filter((i) => can(role, i.resource) && showInNav(role, i))
  return isAdBlueProfile(role) ? items.sort((a, b) => PROFILE_NAV.indexOf(a.href) - PROFILE_NAV.indexOf(b.href)) : items
}

/**
 * The phone tab bar: four of the role's own sidebar items (those marked `mobile` first), in sidebar order. Dev:
 * Dashboard / Trips / Diesel / Invoices; Owner and Employee: Fuel Stations / Diesel / Diesel Tankers / AdBlue.
 * Everything else — and every `tab: false` item (Vehicles) — stays one tap away under "More" (the full drawer).
 * Pinned in `npm run check:roles`.
 */
export function mobileTabs(role: Role) {
  const items = navFor(role)
  const picked = new Set([...items.filter((i) => i.mobile), ...items.filter((i) => !i.mobile && i.tab !== false)].slice(0, 4))
  return items.filter((i) => picked.has(i))
}
