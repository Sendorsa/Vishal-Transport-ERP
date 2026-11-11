"use client"

import { Fragment, useEffect } from "react"
import { usePathname, useRouter } from "next/navigation"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { SessionProvider, setVerifiedRole, useCurrentMonth, usePreviewRole, type VerifiedSession } from "@/lib/app-state"
import { landingFor, profilePageAllowed } from "@/lib/auth/gate"
import { isAdBlueProfile } from "@/lib/permissions"
import { AppSidebar } from "./app-sidebar"
import { AppHeader } from "./app-header"
import { MobileNav } from "./mobile-nav"

export function AppShell({ session, children }: { session: VerifiedSession | null; children: React.ReactNode }) {
  const pathname = usePathname()
  setVerifiedRole(session?.role ?? null, session?.email ?? null) // the API's currentRole() / audit actor follow the signed-in account
  // A new India month remounts the page: the default month, month lists, lock labels and "this month" figures are
  // recalculated without a reload. Saves never rely on this — the API checks today's date itself.
  const month = useCurrentMonth()
  // UI Preview Mode of an AdBlue profile: the pages that profile may open, as the sign-in gate enforces for a real
  // account (gate.ts) — any other page goes to /adblue. Interface only: the real gate still sees DEV.
  const router = useRouter()
  const preview = usePreviewRole()
  const offLimits = session?.role === "DEV" && !!preview && isAdBlueProfile(preview) && !profilePageAllowed(preview, pathname)
  useEffect(() => {
    if (offLimits && preview) router.replace(landingFor(preview))
  }, [offLimits, preview, router])
  // Without a verified, ACTIVE account only the login page renders, with no ERP chrome. (The proxy already sends
  // everyone else to /login before anything renders; this is the second guard.)
  if (!session) return pathname === "/login" ? <>{children}</> : null
  return (
    <SessionProvider value={session}>
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset className="min-w-0">
          <AppHeader />
          <main className="mx-auto w-full max-w-[1600px] flex-1 px-3 pt-4 pb-[calc(5.5rem+env(safe-area-inset-bottom))] md:px-6 md:pt-6 md:pb-10">
            <Fragment key={month}>{offLimits ? null : children}</Fragment>
          </main>
        </SidebarInset>
        <MobileNav />
      </SidebarProvider>
    </SessionProvider>
  )
}
