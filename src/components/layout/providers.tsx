"use client"

import { useEffect, useState } from "react"
import { isServer, MutationCache, QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ConflictError } from "@/lib/versions"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Toaster } from "@/components/ui/sonner"
import { subscribeExternal } from "@/lib/storage/local-store"
import { isSharedBackend } from "@/lib/api/client"
import { keysForModules } from "@/lib/api/hooks"

function makeQueryClient() {
  const client: QueryClient = new QueryClient({
    // A stale edit was refused (someone else saved first): load their version in the background. The open dialog keeps
    // what the user typed, so they can re-apply it on top of the newer record.
    mutationCache: new MutationCache({ onError: (e) => void (e instanceof ConflictError && client.invalidateQueries()) }),
    defaultOptions: {
      queries: {
        staleTime: isSharedBackend ? 15_000 : 60_000,
        // Shared database: coming back to the tab shows what other people saved meanwhile.
        refetchOnWindowFocus: isSharedBackend,
        retry: 1,
      },
    },
  })
  return client
}

let browserQueryClient: QueryClient | undefined

function getQueryClient() {
  if (isServer) return makeQueryClient()
  if (!browserQueryClient) browserQueryClient = makeQueryClient()
  return browserQueryClient
}

/** Keeps other open tabs in sync when data changes in this one. */
function StorageSync({ client }: { client: QueryClient }) {
  useEffect(
    () =>
      subscribeExternal((name) => {
        if (name === "meta") client.invalidateQueries()
        else client.invalidateQueries({ queryKey: [name] })
      }),
    [client]
  )
  return null
}

/** How often other people's changes are picked up on the shared database (owner's decision OD-5: 20 seconds). */
export const SYNC_INTERVAL_MS = 20_000

/**
 * Shared database: every 20 seconds while the tab is visible (and at once when it becomes visible again), asks the
 * server which modules changed since the last look — as this role may see them — and refreshes only those queries.
 * No page reload; forms keep their own state, so unsaved input is never overwritten. Offline: it just tries again.
 */
function SharedSync({ client }: { client: QueryClient }) {
  useEffect(() => {
    let cursor: string | null = null
    let busy = false
    const poll = async () => {
      if (busy || document.visibilityState !== "visible") return
      busy = true
      try {
        const res = await fetch(`/api/erp/changes${cursor ? `?since=${encodeURIComponent(cursor)}` : ""}`, { cache: "no-store", credentials: "same-origin" })
        if (res.ok && (res.headers.get("content-type") ?? "").includes("application/json")) {
          const body = (await res.json()) as { cursor: string; modules: string[] }
          if (cursor && body.modules.length) await Promise.all(keysForModules(body.modules).map((k) => client.invalidateQueries({ queryKey: [k] })))
          cursor = body.cursor
        }
      } catch {
        // offline or the server is unreachable: nothing to refresh; the next tick tries again
      } finally {
        busy = false
      }
    }
    void poll()
    const timer = setInterval(poll, SYNC_INTERVAL_MS)
    const onVisible = () => void poll()
    document.addEventListener("visibilitychange", onVisible)
    window.addEventListener("online", onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener("visibilitychange", onVisible)
      window.removeEventListener("online", onVisible)
    }
  }, [client])
  return null
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(getQueryClient)
  return (
    <QueryClientProvider client={client}>
      <TooltipProvider delayDuration={200}>
        {isSharedBackend ? <SharedSync client={client} /> : <StorageSync client={client} />}
        {children}
        <Toaster position="bottom-right" richColors closeButton mobileOffset={{ bottom: "calc(8.5rem + env(safe-area-inset-bottom))" }} /> {/* phones: above the tab bar and a form's fixed Save bar */}
      </TooltipProvider>
    </QueryClientProvider>
  )
}
