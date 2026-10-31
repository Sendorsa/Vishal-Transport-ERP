import type { Metadata } from "next"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { GoogleSignInButton } from "@/features/settings/user-accounts"

export const metadata: Metadata = { title: "Sign in" }

/** Google sign-in for ERP accounts. The rest of the ERP doesn't require it yet. */
export default function LoginPage() {
  return (
    <div className="mx-auto mt-10 max-w-md">
      <Card size="sm">
        <CardHeader>
          <CardTitle className="text-base font-semibold">Sign in to Vishal Transport</CardTitle>
          <CardDescription>
            Sign in with the Google account the system administrator (Dev) approved for you. A Google account
            without an approved, active ERP account gets no access.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <GoogleSignInButton />
        </CardContent>
      </Card>
    </div>
  )
}
