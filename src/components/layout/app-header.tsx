"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { Building2, Check, ChevronDown, Eye, LogOut, Undo2, Users } from "lucide-react"
import { Button } from "@/components/ui/button"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { Separator } from "@/components/ui/separator"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { setPreviewRole, useCompanyScope, usePreviewRole, useRole, useSession } from "@/lib/app-state"
import { roleLabel } from "@/lib/permissions"
import { cn } from "@/lib/utils"
import { signOutToLogin } from "@/features/auth/sign-in-buttons"
import type { CompanyScope, Role } from "@/lib/types"

const SCOPES: { value: CompanyScope; label: string; description: string }[] = [
  { value: "GROUP", label: "Vishal Group", description: "Consolidated · VT + VTHPL" },
  { value: "VT", label: "Vishal Transport (VT)", description: "Primary company · goods, fuel outlet" },
  { value: "VTHPL", label: "VTHPL", description: "Managed by VT · buses, taxi, manpower" },
]

export function CompanySwitcher() {
  const [scope, setScope] = useCompanyScope()
  const current = SCOPES.find((s) => s.value === scope)!
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="max-w-[46vw] gap-1.5">
          <Building2 className="text-muted-foreground" />
          <span className="truncate">{scope === "GROUP" ? "Group" : scope}</span>
          <ChevronDown className="text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>Company</DropdownMenuLabel>
        <DropdownMenuGroup>
          {SCOPES.map((s) => (
            <DropdownMenuItem key={s.value} onSelect={() => setScope(s.value)} className="items-start">
              <Check className={s.value === current.value ? "mt-0.5 opacity-100" : "mt-0.5 opacity-0"} />
              <div className="grid">
                <span className="font-medium">{s.label}</span>
                <span className="text-xs text-muted-foreground">{s.description}</span>
              </div>
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const PREVIEW_OPTIONS: { value: Role; note: string }[] = [
  { value: "DEV", note: "Actual role" },
  { value: "OWNER", note: "Preview" },
  { value: "EMPLOYEE", note: "Preview" },
  { value: "TATA_ADBLUE", note: "Preview · no customers" },
  { value: "ADBLUE", note: "Preview" },
]

/**
 * DEV role preview: "Viewing as: Dev ▾". Shown only when the account verified on the server is DEV (the session the
 * layout passed down — never browser storage or the URL). Changes the interface only, not the identity or backend
 * permissions; writes through the UI are blocked to prevent accidental changes. See identity.ts.
 */
export function RolePreviewMenu() {
  const session = useSession()
  const preview = usePreviewRole()
  if (session?.role !== "DEV") return null
  const viewing = preview ?? "DEV"
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className={cn("gap-1.5", preview && "border-warning text-foreground")} aria-label={`Viewing as ${roleLabel(viewing)}. Change preview role`}>
          <Eye className={preview ? "text-warning" : "text-muted-foreground"} />
          <span className="hidden text-muted-foreground md:inline">Viewing as:</span>
          <span className="font-medium">{roleLabel(viewing)}</span>
          <ChevronDown className="text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel className="grid gap-0.5">
          <span>View the ERP as</span>
          <span className="text-xs font-normal text-muted-foreground">UI Preview Mode changes the interface only. Your account and permissions stay Dev.</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          {PREVIEW_OPTIONS.map((o) => (
            <DropdownMenuItem key={o.value} onSelect={() => setPreviewRole(o.value)}>
              <Check className={o.value === viewing ? "opacity-100" : "opacity-0"} />
              <span className="font-medium">{roleLabel(o.value)}</span>
              <span className="ml-auto text-xs text-muted-foreground">{o.note}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** While a DEV previews another role: says so on every page — interface only, identity and permissions stay Dev — with Return to Dev. */
function PreviewBanner() {
  const session = useSession()
  const preview = usePreviewRole()
  if (session?.role !== "DEV" || !preview) return null
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-warning bg-warning/15 px-3 py-2 text-sm md:px-4">
      <Eye className="size-4 shrink-0 text-warning" />
      <p className="min-w-0 flex-1">
        <span className="font-semibold uppercase tracking-wide">UI Preview Mode — viewing as {roleLabel(preview)}</span>
        <span className="text-muted-foreground">
          {" "}
          · Signed in as Dev{session.email ? ` (${session.email})` : ""}. Only the interface changes: DEV retains their actual DEV permissions. Writes
          through the normal application UI are blocked to prevent accidental changes; direct API or database requests may still modify data.
          {preview === "TATA_ADBLUE" &&
            " Tata Adblue sees only the customers Dev grants each account; this preview has no grants, so no customer's data is shown — only the shared AdBlue stock and purchases. It shows the interface, not any account's real customer access."}
          {preview === "ADBLUE" && " Adblue sees every customer's AdBlue and Diesel records, read-only for Diesel."}
        </span>
      </p>
      <Button size="sm" onClick={() => setPreviewRole(null)}>
        <Undo2 /> Return to Dev
      </Button>
    </div>
  )
}

/** The signed-in account: email, role (from the database, not switchable), User accounts for DEV, Sign out. */
export function AccountMenu() {
  const session = useSession()
  const [uiRole] = useRole()
  const role = session?.role ?? uiRole // the real account's role, never the previewed one
  const initials = roleLabel(role)
    .split(" ")
    .map((w) => w[0])
    .join("")
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="gap-2 px-1.5">
          <Avatar className="size-6">
            <AvatarFallback className="bg-primary text-[10px] text-primary-foreground">{initials}</AvatarFallback>
          </Avatar>
          <span className="hidden text-sm lg:inline">{roleLabel(role)}</span>
          <ChevronDown className="hidden text-muted-foreground lg:block" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="grid gap-0.5">
          <span className="truncate text-sm font-medium">{session?.email ?? "Signed in"}</span>
          <span className="text-xs font-normal text-muted-foreground">{roleLabel(role)}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {uiRole === "DEV" && (
          <DropdownMenuItem asChild>
            <Link href="/settings/users">
              <Users className="size-4" /> User accounts
            </Link>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={() => void signOutToLogin()}>
          <LogOut className="size-4" /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function AppHeader() {
  const pathname = usePathname()
  // Diesel is organised by customer company only — the VT / VTHPL selector doesn't apply there.
  const showEntitySwitcher = !pathname.startsWith("/diesel") && !pathname.startsWith("/fuel-stations") && !pathname.startsWith("/adblue") && !pathname.startsWith("/tanker")
  return (
    <div className="sticky top-0 z-20 shrink-0 bg-background">
      <header className="flex min-h-12 items-center gap-2 border-b bg-background/95 px-3 pt-[env(safe-area-inset-top)] backdrop-blur supports-[backdrop-filter]:bg-background/80 md:px-4">
        <SidebarTrigger className="-ml-1" />
        <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-4" />
        <span className="hidden text-sm font-medium text-muted-foreground sm:inline">Vishal Transport ERP</span>
        <div className="ml-auto flex items-center gap-1.5">
          {showEntitySwitcher && <CompanySwitcher />}
          <RolePreviewMenu />
          <AccountMenu />
        </div>
      </header>
      <PreviewBanner />
    </div>
  )
}
