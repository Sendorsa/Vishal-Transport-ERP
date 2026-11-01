"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { Menu } from "lucide-react"
import { useSidebar } from "@/components/ui/sidebar"
import { useRole } from "@/lib/app-state"
import { cn } from "@/lib/utils"
import { isActive, mobileTabs } from "./nav"

/**
 * Phones: a bottom tab bar within thumb reach. Four tabs from what this role sees in the sidebar (the items marked
 * `mobile` first, e.g. Dashboard / Trips / Diesel / Invoices for Dev; Fuel Stations / Diesel / Tankers / AdBlue for
 * the Fuel-only roles), in sidebar order. "More" opens the full sidebar drawer with every other item — nothing is
 * removed. The active tab is highlighted; "More" is highlighted when the current page lives in the drawer.
 */
export function MobileNav() {
  const pathname = usePathname()
  const [role] = useRole()
  const { setOpenMobile } = useSidebar()
  const tabs = mobileTabs(role)
  const inDrawer = !tabs.some((i) => isActive(pathname, i.href))

  const tab = (active: boolean) =>
    cn(
      "flex min-h-14 w-full flex-col items-center justify-center gap-0.5 px-1 text-[11px] leading-tight",
      active ? "font-semibold text-primary" : "text-muted-foreground"
    )
  const icon = (active: boolean) => cn("flex h-7 w-12 items-center justify-center rounded-full transition-colors", active && "bg-primary/10")

  return (
    <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-30 border-t bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
      <ul className="grid grid-cols-5">
        {tabs.map((item) => {
          const active = isActive(pathname, item.href)
          return (
            <li key={item.href}>
              <Link href={item.href} aria-current={active ? "page" : undefined} className={tab(active)}>
                <span className={icon(active)}>
                  <item.icon className="size-5" />
                </span>
                <span className="max-w-full truncate">{item.short ?? item.title}</span>
              </Link>
            </li>
          )
        })}
        <li className="col-start-5">
          <button type="button" onClick={() => setOpenMobile(true)} className={tab(inDrawer)} aria-label="More: all sections">
            <span className={icon(inDrawer)}>
              <Menu className="size-5" />
            </span>
            More
          </button>
        </li>
      </ul>
    </nav>
  )
}
