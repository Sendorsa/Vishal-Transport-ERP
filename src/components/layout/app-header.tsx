"use client"

import { usePathname } from "next/navigation"
import { Building2, Check, ChevronDown, UserCog } from "lucide-react"
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
import { useCompanyScope, useRole } from "@/lib/app-state"
import { ROLES, roleLabel } from "@/lib/permissions"
import type { CompanyScope } from "@/lib/types"

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

export function RoleSwitcher() {
  const [role, setRole] = useRole()
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
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel className="flex items-center gap-2">
          <UserCog className="size-4" /> Switch role (demo)
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {ROLES.map((r) => (
          <DropdownMenuItem key={r.value} onSelect={() => setRole(r.value)} className="items-start">
            <Check className={r.value === role ? "mt-0.5 opacity-100" : "mt-0.5 opacity-0"} />
            <div className="grid">
              <span className="font-medium">{r.label}</span>
              <span className="text-xs text-muted-foreground">{r.description}</span>
            </div>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function AppHeader() {
  const pathname = usePathname()
  // Diesel is organised by customer company only — the VT / VTHPL selector doesn't apply there.
  const showEntitySwitcher = !pathname.startsWith("/diesel") && !pathname.startsWith("/fuel-stations") && !pathname.startsWith("/adblue") && !pathname.startsWith("/tanker")
  return (
    <header className="sticky top-0 z-20 flex h-12 shrink-0 items-center gap-2 border-b bg-background/95 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/80 md:px-4">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-4" />
      <span className="hidden text-sm font-medium text-muted-foreground sm:inline">Vishal Transport ERP</span>
      <div className="ml-auto flex items-center gap-1.5">
        {showEntitySwitcher && <CompanySwitcher />}
        <RoleSwitcher />
      </div>
    </header>
  )
}
