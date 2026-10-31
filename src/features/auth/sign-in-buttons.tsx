"use client"

import { useEffect, useState } from "react"
import { Loader2, LogOut } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { COOKIE_NEXT, LANDING } from "@/lib/auth/gate"
import { useSession } from "@/lib/app-state"
import { createClient } from "@/lib/supabase/client"
import { cn } from "@/lib/utils"

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="size-5">
      <path fill="#4285F4" d="M23.52 12.27c0-.85-.08-1.67-.22-2.45H12v4.64h6.46a5.52 5.52 0 0 1-2.4 3.62v3h3.88c2.27-2.09 3.58-5.17 3.58-8.81Z" />
      <path fill="#34A853" d="M12 24c3.24 0 5.96-1.07 7.94-2.92l-3.88-3c-1.07.72-2.45 1.15-4.06 1.15-3.12 0-5.77-2.11-6.71-4.95H1.28v3.1A12 12 0 0 0 12 24Z" />
      <path fill="#FBBC05" d="M5.29 14.28a7.2 7.2 0 0 1 0-4.56v-3.1H1.28a12 12 0 0 0 0 10.76l4.01-3.1Z" />
      <path fill="#EA4335" d="M12 4.77c1.76 0 3.34.61 4.59 1.8l3.44-3.44A11.5 11.5 0 0 0 12 0 12 12 0 0 0 1.28 6.62l4.01 3.1C6.23 6.88 8.88 4.77 12 4.77Z" />
    </svg>
  )
}

/** "Continue with Google": Supabase Google OAuth. Remembers where to return (a short-lived cookie the callback reads). */
export function GoogleSignInButton({ next = LANDING, className }: { next?: string; className?: string }) {
  const [pending, setPending] = useState(false)
  const signIn = async () => {
    setPending(true)
    try {
      const secure = window.location.protocol === "https:" ? "; Secure" : ""
      document.cookie = `${COOKIE_NEXT}=${encodeURIComponent(next)}; Path=/; Max-Age=600; SameSite=Lax${secure}`
      const { error } = await createClient().auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: `${window.location.origin}/auth/callback` },
      })
      if (error) throw error
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Sign-in couldn't start. Please try again.")
      setPending(false)
    }
  }
  return (
    <Button type="button" size="lg" variant="outline" onClick={signIn} disabled={pending} className={cn("h-11 w-full gap-3 bg-background text-sm font-medium shadow-sm", className)}>
      {pending ? <Loader2 className="size-5 animate-spin" /> : <GoogleMark />}
      {pending ? "Redirecting to Google…" : "Continue with Google"}
    </Button>
  )
}

/**
 * Signs out and reloads the login page. A full page load on purpose: it drops the in-memory data cache and the
 * session the layout rendered, and the proxy re-checks the (now absent) session.
 */
export async function signOutToLogin() {
  try {
    await createClient().auth.signOut()
  } finally {
    window.location.assign(new URL("/login?signedout=1", window.location.origin).href)
  }
}

/**
 * The login page can be reached by an in-app navigation (a session that expired, or an account deactivated, while the
 * ERP was open): the proxy redirects that navigation here, but the layout above still holds the old session. A full
 * reload makes the server recompute it, so the login page never sits inside a stale ERP shell.
 */
export function ReloadIfStaleShell() {
  const staleSession = useSession()
  useEffect(() => {
    if (staleSession) window.location.reload()
  }, [staleSession])
  return null
}

/** Signs out (e.g. to try a different Google account). */
export function SignOutButton({ label = "Use a different Google account" }: { label?: string }) {
  const [pending, setPending] = useState(false)
  return (
    <Button
      type="button"
      variant="secondary"
      className="w-full"
      disabled={pending}
      onClick={async () => {
        setPending(true)
        await signOutToLogin()
      }}
    >
      {pending ? <Loader2 className="size-4 animate-spin" /> : <LogOut className="size-4" />} {label}
    </Button>
  )
}
