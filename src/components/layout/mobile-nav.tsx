"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { Menu } from "lucide-react"
import { useSidebar } from "@/components/ui/sidebar"
import { useCan, useRole } from "@/lib/app-state"
import { cn } from "@/lib/utils"
import { NAV_ITEMS, isActive, showInNav } from "./nav"

/** Bottom tab bar on phones; "More" opens the full sidebar sheet. */
export function MobileNav() {
  const pathname = usePathname()
  const can = useCan()
  const [role] = useRole()
  const { setOpenMobile } = useSidebar()
  const items = NAV_ITEMS.filter((i) => i.mobile && can(i.resource) && showInNav(role, i)).slice(0, 4)

  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 border-t bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
      <ul className="grid grid-cols-5">
        {items.map((item) => {
          const active = isActive(pathname, item.href)
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                className={cn(
                  "flex flex-col items-center gap-0.5 py-2 text-[11px]",
                  active ? "font-medium text-foreground" : "text-muted-foreground"
                )}
              >
                <item.icon className="size-5" />
                {item.title}
              </Link>
            </li>
          )
        })}
        <li className={cn(items.length < 4 && "col-start-5")}>
          <button
            type="button"
            onClick={() => setOpenMobile(true)}
            className="flex w-full flex-col items-center gap-0.5 py-2 text-[11px] text-muted-foreground"
          >
            <Menu className="size-5" />
            More
          </button>
        </li>
      </ul>
    </nav>
  )
}
