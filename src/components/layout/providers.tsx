"use client"

import { useEffect, useState } from "react"
import { isServer, QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Toaster } from "@/components/ui/sonner"
import { subscribeExternal } from "@/lib/storage/local-store"

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 60_000,
        refetchOnWindowFocus: false,
        retry: 1,
      },
    },
  })
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

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(getQueryClient)
  return (
    <QueryClientProvider client={client}>
      <TooltipProvider delayDuration={200}>
        <StorageSync client={client} />
        {children}
        <Toaster position="bottom-right" richColors closeButton mobileOffset={{ bottom: "calc(8.5rem + env(safe-area-inset-bottom))" }} /> {/* phones: above the tab bar and a form's fixed Save bar */}
      </TooltipProvider>
    </QueryClientProvider>
  )
}
