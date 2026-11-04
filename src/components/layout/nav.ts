import {
  ArrowLeftRight,
  BarChart3,
  Container,
  Droplets,
  Bus,
  FileText,
  Fuel,
  LayoutDashboard,
  Route,
  ScrollText,
  Settings,
  Store,
  Users,
  type LucideIcon,
} from "lucide-react"
import { can, type Resource } from "@/lib/permissions"
import type { Role } from "@/lib/types"

/**
 * Sidebar sections, in display order. Add a section here (e.g. a future "Fleet") and tag its items
 * with it — the sidebar renders every section with the same header style.
 */
export const NAV_GROUPS = ["Overview", "Operations", "Fuel", "Finance", "System"] as const
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
}

export const NAV_ITEMS: NavItem[] = [
  { title: "Dashboard", href: "/dashboard", icon: LayoutDashboard, resource: "dashboard", group: "Overview", mobile: true },
  { title: "Customers", href: "/customers", icon: Users, resource: "customers", group: "Operations" },
  { title: "Vehicles", href: "/vehicles", icon: Bus, resource: "vehicles", group: "Operations" },
  { title: "Trips", href: "/trips", icon: Route, resource: "trips", group: "Operations", mobile: true },
  // Fuel: fuel-related modules (future: fuel vendors, analytics, reconciliation, purchase orders).
  { title: "Fuel Stations", short: "Stations", href: "/fuel-stations", icon: Store, resource: "diesel", group: "Fuel" },
  { title: "Diesel", href: "/diesel", icon: Fuel, resource: "diesel", group: "Fuel", mobile: true },
  { title: "Diesel Tankers", short: "Tankers", href: "/tanker", icon: Container, resource: "diesel", group: "Fuel" },
  { title: "AdBlue", href: "/adblue", icon: Droplets, resource: "diesel", group: "Fuel" },
  { title: "Invoices", href: "/invoices", icon: FileText, resource: "invoices", group: "Finance", mobile: true },
  { title: "Payments", href: "/payments", icon: ArrowLeftRight, resource: "payments", group: "Finance" },
  { title: "Reports", href: "/reports", icon: BarChart3, resource: "reports", group: "Finance" },
  { title: "Settings", href: "/settings", icon: Settings, resource: "settings", group: "System" },
  // Owner and Dev (`audit` permission); the API refuses the log to every other role too.
  { title: "Audit Log", href: "/audit", icon: ScrollText, resource: "audit", group: "System" },
]

/**
 * Sidebar visibility only — not a permission (owner, 4 Nov 2026). Dev sees every item its role can use, unchanged.
 * The Owner and the Employee see only the Fuel section and the Audit Log (Settings and every other section hidden);
 * the Audit Log still needs the `audit` permission (`navFor`), which the Employee doesn't have. Hidden modules keep
 * their routes, permissions and API access (src/lib/permissions.ts).
 */
export const showInNav = (role: Role, item: NavItem) => role === "DEV" || item.group === "Fuel" || item.href === "/audit"

export function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`)
}

/** The sidebar items a role sees (permission + sidebar visibility) — also everything in the phone drawer ("More"). */
export const navFor = (role: Role) => NAV_ITEMS.filter((i) => can(role, i.resource) && showInNav(role, i))

/**
 * The phone tab bar: four of the role's own sidebar items (those marked `mobile` first), in sidebar order. Dev:
 * Dashboard / Trips / Diesel / Invoices; Owner and Employee: Fuel Stations / Diesel / Diesel Tankers / AdBlue.
 * Everything else stays one tap away under "More" (the full drawer). Pinned in `npm run check:roles`.
 */
export function mobileTabs(role: Role) {
  const items = navFor(role)
  const picked = new Set([...items.filter((i) => i.mobile), ...items.filter((i) => !i.mobile)].slice(0, 4))
  return items.filter((i) => picked.has(i))
}
