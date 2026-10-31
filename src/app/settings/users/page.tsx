import type { Metadata } from "next"
import { UserAccounts } from "@/features/settings/user-accounts"

export const metadata: Metadata = { title: "User accounts" }

export default async function UserAccountsPage(props: PageProps<"/settings/users">) {
  const { error } = await props.searchParams
  return <UserAccounts error={typeof error === "string" ? error : undefined} />
}
