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
import type { Resource } from "@/lib/permissions"
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
}

export const NAV_ITEMS: NavItem[] = [
  { title: "Dashboard", href: "/", icon: LayoutDashboard, resource: "dashboard", group: "Overview", mobile: true },
  { title: "Customers", href: "/customers", icon: Users, resource: "customers", group: "Operations" },
  { title: "Vehicles", href: "/vehicles", icon: Bus, resource: "vehicles", group: "Operations" },
  { title: "Trips", href: "/trips", icon: Route, resource: "trips", group: "Operations", mobile: true },
  // Fuel: fuel-related modules (future: fuel vendors, analytics, reconciliation, purchase orders).
  { title: "Fuel Stations", href: "/fuel-stations", icon: Store, resource: "diesel", group: "Fuel" },
  { title: "Diesel", href: "/diesel", icon: Fuel, resource: "diesel", group: "Fuel", mobile: true },
  { title: "Diesel Tankers", href: "/tanker", icon: Container, resource: "diesel", group: "Fuel" },
  { title: "AdBlue", href: "/adblue", icon: Droplets, resource: "diesel", group: "Fuel" },
  { title: "Invoices", href: "/invoices", icon: FileText, resource: "invoices", group: "Finance", mobile: true },
  { title: "Payments", href: "/payments", icon: ArrowLeftRight, resource: "payments", group: "Finance" },
  { title: "Reports", href: "/reports", icon: BarChart3, resource: "reports", group: "Finance" },
  { title: "Settings", href: "/settings", icon: Settings, resource: "settings", group: "System" },
  // Owner and Dev (`audit` permission); the API refuses the log to every other role too.
  { title: "Audit Log", href: "/audit", icon: ScrollText, resource: "audit", group: "System" },
]

/**
 * Sidebar visibility only — not a permission. Dev sees every item its role can use; every other role
 * sees only the Fuel section, and the Owner also the Audit Log (System), where the deletion badge is.
 * Hidden modules keep their routes and permissions (src/lib/permissions.ts).
 */
export const showInNav = (role: Role, item: NavItem) => role === "DEV" || item.group === "Fuel" || (role === "OWNER" && item.resource === "audit")

export function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`)
}
