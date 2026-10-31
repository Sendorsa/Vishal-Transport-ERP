"use client"

import { Fragment } from "react"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { useCurrentMonth } from "@/lib/app-state"
import { AppSidebar } from "./app-sidebar"
import { AppHeader } from "./app-header"
import { MobileNav } from "./mobile-nav"

export function AppShell({ children }: { children: React.ReactNode }) {
  // A new India month remounts the page: the default month, month lists, lock labels and "this month" figures are
  // recalculated without a reload. Saves never rely on this — the API checks today's date itself.
  const month = useCurrentMonth()
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className="min-w-0">
        <AppHeader />
        <main className="mx-auto w-full max-w-[1600px] flex-1 px-3 pt-4 pb-24 md:px-6 md:pt-6 md:pb-10">
          <Fragment key={month}>{children}</Fragment>
        </main>
      </SidebarInset>
      <MobileNav />
    </SidebarProvider>
  )
}
