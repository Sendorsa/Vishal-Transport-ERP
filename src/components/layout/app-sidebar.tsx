"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { BrandLogo } from "@/components/shared/brand-logo"
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
import { useRole } from "@/lib/app-state"
import { useUnreviewedDeletions } from "@/lib/api/hooks"
import { NAV_GROUPS, isActive, navFor } from "./nav"
import { landingFor } from "@/lib/auth/gate"
import { hasOwnerAuthority } from "@/lib/permissions"
import { isSharedBackend } from "@/lib/api/client"

const GROUPS = NAV_GROUPS

export function AppSidebar() {
  const pathname = usePathname()
  const [role] = useRole()
  const { setOpenMobile } = useSidebar()
  const items = navFor(role) // permission + sidebar visibility (AdBlue profiles: AdBlue, then Diesel)
  // Owner only: deletion events not yet reviewed, shown on the Audit Log item (hidden at 0).
  const unreviewed = useUnreviewedDeletions(hasOwnerAuthority(role)).data ?? 0
  const badgeFor = (href: string) => (href === "/audit" && unreviewed > 0 ? unreviewed : null)

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild tooltip="Vishal Transport">
              <Link href={landingFor(role)} onClick={() => setOpenMobile(false)}>
                <BrandLogo className="size-8" />
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
          {isSharedBackend ? "Shared database · synced across devices" : "Prototype · data stored in this browser"}
        </p>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
