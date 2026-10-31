"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { Truck } from "lucide-react"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar"
import { useCan, useRole } from "@/lib/app-state"
import { useUnreviewedDeletions } from "@/lib/api/hooks"
import { NAV_GROUPS, NAV_ITEMS, isActive, showInNav } from "./nav"

const GROUPS = NAV_GROUPS

export function AppSidebar() {
  const pathname = usePathname()
  const can = useCan()
  const [role] = useRole()
  const { setOpenMobile } = useSidebar()
  const items = NAV_ITEMS.filter((i) => can(i.resource) && showInNav(role, i))
  // Owner only: deletion events not yet reviewed, shown on the Audit Log item (hidden at 0).
  const unreviewed = useUnreviewedDeletions(role === "OWNER").data ?? 0
  const badgeFor = (href: string) => (href === "/audit" && unreviewed > 0 ? unreviewed : null)

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild tooltip="Vishal Transport">
              <Link href="/" onClick={() => setOpenMobile(false)}>
                <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                  <Truck className="size-4" />
                </div>
                <div className="grid flex-1 text-left leading-tight">
                  <span className="truncate text-sm font-semibold">Vishal Transport</span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {GROUPS.map((group) => {
          const groupItems = items.filter((i) => i.group === group)
          if (!groupItems.length) return null
          return (
            <SidebarGroup key={group}>
              <SidebarGroupLabel>{group}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {groupItems.map((item) => (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton asChild isActive={isActive(pathname, item.href)} tooltip={badgeFor(item.href) ? `${item.title} · ${badgeFor(item.href)} deletion${badgeFor(item.href) === 1 ? "" : "s"} to review` : item.title}>
                        <Link href={item.href} onClick={() => setOpenMobile(false)}>
                          <item.icon />
                          <span>{item.title}</span>
                        </Link>
                      </SidebarMenuButton>
                      {badgeFor(item.href) && (
                        <SidebarMenuBadge className="bg-red-600 text-white peer-hover/menu-button:text-white peer-data-active/menu-button:text-white" aria-label={`${badgeFor(item.href)} deletions to review`}>
                          {badgeFor(item.href)}
                        </SidebarMenuBadge>
                      )}
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          )
        })}
      </SidebarContent>
      <SidebarFooter>
        <p className="px-2 pb-1 text-[11px] leading-snug text-muted-foreground group-data-[collapsible=icon]:hidden">
          Prototype · data stored in this browser
        </p>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
