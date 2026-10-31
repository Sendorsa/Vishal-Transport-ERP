import type { Metadata } from "next"
import { Geist, Geist_Mono } from "next/font/google"
import { Providers } from "@/components/layout/providers"
import { AppShell } from "@/components/layout/app-shell"
import { getServerAuth } from "@/lib/auth/session"
import "./globals.css"

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
})

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
})

export const metadata: Metadata = {
  title: { default: "Vishal Transport ERP", template: "%s · Vishal Transport ERP" },
  description: "Fleet, trips, diesel, billing and profitability for Vishal Group (VT + VTHPL).",
}

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // The signed-in account, verified on the server (the proxy has already sent everyone else to /login).
  const auth = await getServerAuth()
  const session = auth.status === "ACTIVE" && auth.role ? { role: auth.role, email: auth.email } : null
  return (
    <html lang="en-IN" suppressHydrationWarning className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full bg-muted/40">
        <Providers>
          <AppShell session={session}>{children}</AppShell>
        </Providers>
      </body>
    </html>
  )
}
