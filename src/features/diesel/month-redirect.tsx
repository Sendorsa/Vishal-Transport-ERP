"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"
import { PageSkeleton } from "@/components/shared/misc"
import { useSyncDieselMonth } from "./parts"

/**
 * Legacy `/diesel/[customer]/[month]` links: adopt the month as the module's reporting
 * month, then show the customer page (which lists that month's vehicles).
 */
export function MonthRedirect({ slug, month }: { slug: string; month: string }) {
  const router = useRouter()
  useSyncDieselMonth(month)
  useEffect(() => {
    router.replace(`/diesel/${slug}`)
  }, [router, slug])
  return <PageSkeleton />
}
