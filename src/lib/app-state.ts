"use client"

/**
 * Session: current role and company scope. The role comes from the signed-in Google account's ERP account
 * (verified on the server, src/lib/auth/session.ts, handed down by AppShell through SessionProvider). The stored
 * localStorage role (`vt:ui:role`) is only the fallback for code with no signed-in session (the offline checks).
 * Company scope stays a per-browser preference.
 */
import { createContext, useCallback, useContext, useSyncExternalStore } from "react"
import type { CompanyScope, Role } from "./types"
import { currentActor, currentRole, previewRole, readStoredRole, setPreviewRole, setVerifiedSession, subscribePreview } from "./identity"
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

const SCOPES = ["GROUP", "VT", "VTHPL"] as const

/** The signed-in account, verified on the server for this page load (null on /login and in the offline checks). */
export interface VerifiedSession {
  role: Role
  email: string | null
}
const SessionContext = createContext<VerifiedSession | null>(null)
export const SessionProvider = SessionContext.Provider
export const useSession = () => useContext(SessionContext)

/** Kept for existing callers: the identity of API calls lives in src/lib/identity.ts. */
export { currentActor, currentRole }
export const setVerifiedRole = (role: Role | null, email: string | null = null) => setVerifiedSession(role ? { role, email } : null)

/** UI Preview Mode (interface only, see identity.ts): the previewed role, or null. */
export { setPreviewRole }
export const usePreviewRole = () => useSyncExternalStore(subscribePreview, previewRole, () => null)

/**
 * The role the UI renders for: the signed-in account's role — or, while a DEV previews another role, that role.
 * Never used for authorization: the API and the server use the verified account (identity.ts).
 */
export function useRole(): [Role, (r: Role) => void] {
  const session = useContext(SessionContext)
  const preview = usePreviewRole()
  const stored = useSyncExternalStore(
    subscribe,
    readStoredRole,
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
  return [session ? (session.role === "DEV" && preview) || session.role : stored, set]
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
