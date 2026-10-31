import type { Metadata } from "next"
import { AuditLog } from "@/features/audit/audit-log"

export const metadata: Metadata = { title: "Audit Log" }

export default function AuditLogPage() {
  return <AuditLog />
}
