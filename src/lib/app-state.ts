"use client"

/**
 * Session: current role and company scope. The role comes from the signed-in Google account's ERP account
 * (verified on the server, src/lib/auth/session.ts, handed down by AppShell through SessionProvider). The stored
 * localStorage role (`vt:ui:role`) is only the fallback for code with no signed-in session (the offline checks).
 * Company scope stays a per-browser preference.
 */
import { createContext, useCallback, useContext, useSyncExternalStore } from "react"
import type { AuditActor, CompanyScope, LegacyRole, Role } from "./types"
import { can, type Action, type Resource } from "./permissions"
import { monthKey, msUntilIndiaMidnight, todayISO } from "./format"

const ROLE_KEY = "vt:ui:role"
const COMPANY_KEY = "vt:ui:company"

const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

function subscribe(cb: () => void) {
  listeners.add(cb)
  const onStorage = (e: StorageEvent) => {
    if (e.key === ROLE_KEY || e.key === COMPANY_KEY) cb()
  }
  window.addEventListener("storage", onStorage)
  return () => {
    listeners.delete(cb)
    window.removeEventListener("storage", onStorage)
  }
}

function read<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = window.localStorage.getItem(key) as T | null
    return v && allowed.includes(v) ? v : fallback
  } catch {
    return fallback
  }
}

const ROLES = ["OWNER", "DEV", "EMPLOYEE"] as const
const SCOPES = ["GROUP", "VT", "VTHPL"] as const
const LEGACY: readonly LegacyRole[] = ["ACCOUNTANT", "OPS_MANAGER"]

/** The signed-in account, verified on the server for this page load (null on /login and in the offline checks). */
export interface VerifiedSession {
  role: Role
  email: string | null
}
const SessionContext = createContext<VerifiedSession | null>(null)
export const SessionProvider = SessionContext.Provider
export const useSession = () => useContext(SessionContext)

// The verified role for code outside React (the API's currentRole). Browser only: on the server, module state
// would be shared between requests.
let verifiedRole: Role | null = null
export function setVerifiedRole(role: Role | null) {
  if (typeof window !== "undefined") verifiedRole = role
}

/**
 * The stored session role. A removed role (Accountant / Operations Manager, 31 Oct 2026) reads as Employee — never
 * the unknown-role fallback to Owner, which would promote it. The stored value itself is left as it is.
 */
function readRole(): Role {
  if (verifiedRole) return verifiedRole
  try {
    if (LEGACY.includes(window.localStorage.getItem(ROLE_KEY) as LegacyRole)) return "EMPLOYEE"
  } catch {
    /* storage unavailable */
  }
  return read<Role>(ROLE_KEY, ROLES, "OWNER")
}

/** Current role outside React (the API's "who is calling"). Becomes the session's role with real auth. */
export function currentRole(): Role {
  return typeof window === "undefined" ? "OWNER" : readRole()
}

/**
 * Who is acting, for the audit trail. The prototype has no login, so there is no user id or name —
 * only the mock-session role. They stay null rather than being invented; real auth fills them here.
 */
export function currentActor(): AuditActor {
  return { kind: "SESSION", userId: null, name: null, role: currentRole() }
}

export function useRole(): [Role, (r: Role) => void] {
  const session = useContext(SessionContext)
  const stored = useSyncExternalStore(
    subscribe,
    readRole,
    () => "OWNER" as Role
  )
  // A signed-in account's role can't be switched from the browser.
  const set = useCallback(
    (r: Role) => {
      if (session) return
      window.localStorage.setItem(ROLE_KEY, r)
      emit()
    },
    [session]
  )
  return [session?.role ?? stored, set]
}

/**
 * Calls `cb` at each India midnight (one timer, re-armed after it fires) and when the tab becomes visible again —
 * a sleeping computer delays timers. useCurrentMonth only re-renders when the month actually changed.
 */
function subscribeMidnight(cb: () => void) {
  let timer: ReturnType<typeof setTimeout>
  const arm = () => {
    timer = setTimeout(() => {
      cb()
      arm()
    }, msUntilIndiaMidnight() + 1000)
  }
  arm()
  const onVisible = () => document.visibilityState === "visible" && cb()
  document.addEventListener("visibilitychange", onVisible)
  return () => {
    clearTimeout(timer)
    document.removeEventListener("visibilitychange", onVisible)
  }
}

const currentMonth = () => monthKey(todayISO())

/** The current India calendar month ("yyyy-MM"); a tab left open re-renders when it changes. */
export function useCurrentMonth() {
  return useSyncExternalStore(subscribeMidnight, currentMonth, currentMonth)
}

export function useCompanyScope(): [CompanyScope, (s: CompanyScope) => void] {
  const scope = useSyncExternalStore(
    subscribe,
    () => read<CompanyScope>(COMPANY_KEY, SCOPES, "GROUP"),
    () => "GROUP" as CompanyScope
  )
  const set = useCallback((s: CompanyScope) => {
    window.localStorage.setItem(COMPANY_KEY, s)
    emit()
  }, [])
  return [scope, set]
}

export function useCan() {
  const [role] = useRole()
  return useCallback((resource: Resource, action: Action = "view") => can(role, resource, action), [role])
}
