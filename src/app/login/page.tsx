import type { Metadata } from "next"
import Link from "next/link"
import { AlertCircle, CheckCircle2, Container, Fuel, Info, ShieldCheck, Store } from "lucide-react"
import { BrandLogo } from "@/components/shared/brand-logo"
import { GoogleSignInButton, ReloadIfStaleShell, SignOutButton } from "@/features/auth/sign-in-buttons"
import { getServerAuth } from "@/lib/auth/session"
import { LANDING, safeNext } from "@/lib/auth/gate"
import { cn } from "@/lib/utils"

export const metadata: Metadata = { title: "Sign in" }

const FEATURES = [
  { icon: Store, text: "Fuel stations, ledgers and payments" },
  { icon: Fuel, text: "Diesel by customer, vehicle and month" },
  { icon: Container, text: "Diesel tankers and AdBlue stock" },
  { icon: ShieldCheck, text: "Every change recorded in the audit log" },
]

function Notice({ tone, children }: { tone: "info" | "error" | "success"; children: React.ReactNode }) {
  const Icon = tone === "error" ? AlertCircle : tone === "success" ? CheckCircle2 : Info
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "flex gap-2.5 rounded-lg border px-3 py-2.5 text-sm",
        tone === "error" && "border-destructive/30 bg-destructive/5 text-destructive",
        tone === "success" && "border-emerald-600/25 bg-emerald-600/5 text-emerald-700 dark:text-emerald-400",
        tone === "info" && "bg-muted/60 text-foreground"
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" />
      <div className="grid gap-1">{children}</div>
    </div>
  )
}

/**
 * Sign-in for Vishal Transport ERP: Google only (no passwords, no registration, no invitations). The proxy sends
 * every signed-out visitor here and every approved, signed-in one away from here; this page explains the rest —
 * a Google account that isn't approved, a deactivated account, a cancelled or failed sign-in.
 */
export default async function LoginPage(props: PageProps<"/login">) {
  const params = await props.searchParams
  const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined)
  const next = safeNext(one(params.next))
  const error = one(params.error)
  const signedOut = one(params.signedout) === "1"
  const auth = await getServerAuth()
  const denied = auth.signedIn && auth.status !== "ACTIVE"

  return (
    <div className="grid min-h-svh bg-background lg:grid-cols-[1.05fr_1fr]">
      <ReloadIfStaleShell />
      {/* Brand panel */}
      <aside className="relative hidden overflow-hidden bg-primary text-primary-foreground lg:flex lg:flex-col lg:justify-between lg:p-12">
        <div aria-hidden className="pointer-events-none absolute inset-0 opacity-[0.08] [background-image:repeating-linear-gradient(135deg,currentColor_0_2px,transparent_2px_28px)]" />
        <div aria-hidden className="pointer-events-none absolute -right-24 -bottom-24 size-96 rounded-full bg-primary-foreground/10 blur-3xl" />
        <div className="relative flex items-center gap-3">
          <BrandLogo className="size-11 rounded-xl p-1.5" />
          <div className="leading-tight">
            <p className="text-lg font-semibold tracking-tight">Vishal Transport</p>
            <p className="text-xs uppercase tracking-[0.2em] text-primary-foreground/70">ERP</p>
          </div>
        </div>
        <div className="relative max-w-md space-y-6">
          <h1 className="text-3xl leading-tight font-semibold tracking-tight xl:text-4xl">Fleet, fuel and finance — in one place.</h1>
          <ul className="space-y-3">
            {FEATURES.map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-center gap-3 text-sm text-primary-foreground/85">
                <span className="flex size-8 items-center justify-center rounded-lg bg-primary-foreground/10">
                  <Icon className="size-4" />
                </span>
                {text}
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-xs text-primary-foreground/60">© Vishal Transport · Internal system for authorised staff</p>
      </aside>

      {/* Sign-in panel */}
      <main className="flex flex-col items-center justify-center px-4 py-10 sm:px-8">
        <div className="mb-8 flex items-center gap-3 lg:hidden">
          <BrandLogo className="size-10 rounded-xl p-1.5" />
          <div className="leading-tight">
            <p className="font-semibold tracking-tight">Vishal Transport</p>
            <p className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground">ERP</p>
          </div>
        </div>

        <div className="w-full max-w-sm space-y-6">
          <div className="space-y-1.5">
            <h2 className="text-2xl font-semibold tracking-tight">{denied ? "Access not available" : "Sign in"}</h2>
            <p className="text-sm text-muted-foreground">Access is restricted to approved Vishal Transport accounts.</p>
          </div>

          {!auth.configured ? (
            <Notice tone="error">
              <p className="font-medium">Sign-in isn&apos;t set up on this installation yet.</p>
              <p className="text-foreground/80">The Supabase connection settings are missing. Contact the system administrator (Dev).</p>
            </Notice>
          ) : denied ? (
            <div className="space-y-4">
              {auth.status === "DISABLED" ? (
                <Notice tone="error">
                  <p className="font-medium">This account has been deactivated.</p>
                  <p className="text-foreground/80">
                    {auth.email ? <strong className="font-medium">{auth.email}</strong> : "Your account"} no longer has access to the ERP. Contact the system administrator (Dev) if you think this is a mistake.
                  </p>
                </Notice>
              ) : (
                <Notice tone="error">
                  <p className="font-medium">This Google account isn&apos;t approved for the ERP.</p>
                  <p className="text-foreground/80">
                    You&apos;re signed in as {auth.email ? <strong className="font-medium">{auth.email}</strong> : "this Google account"}. Ask the system administrator (Dev) to add your account, or sign in with the Google account they approved. If your account has just been added, continue with Google again.
                  </p>
                </Notice>
              )}
              {auth.status !== "DISABLED" && <GoogleSignInButton next={next} />}
              <SignOutButton />
            </div>
          ) : auth.signedIn ? (
            // Approved and signed in: the proxy normally redirects before this renders.
            <Link href={next} className="block text-center text-sm font-medium text-primary underline-offset-4 hover:underline">
              Continue to the ERP
            </Link>
          ) : (
            <div className="space-y-4">
              {signedOut && <Notice tone="success">You&apos;ve been signed out.</Notice>}
              {error === "cancelled" && <Notice tone="info">Sign-in was cancelled. Continue with Google when you&apos;re ready.</Notice>}
              {error === "failed" && <Notice tone="error">We couldn&apos;t complete the sign-in. Please try again.</Notice>}
              {next !== LANDING && <Notice tone="info">Sign in to continue to the page you requested.</Notice>}
              <GoogleSignInButton next={next} />
            </div>
          )}

          <p className="text-center text-xs leading-relaxed text-muted-foreground">
            No passwords and no self-registration: accounts are created by the system administrator, and you sign in with the Google account they approved.
          </p>
        </div>
      </main>
    </div>
  )
}
