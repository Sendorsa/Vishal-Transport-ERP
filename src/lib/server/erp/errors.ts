/**
 * How errors of the shared-database backend reach the browser (used by /api/erp and /api/erp/changes). Its own module
 * (no "server-only") so the offline checks can test it: npm run check:erp-errors.
 */
import { PossibleDuplicateError } from "@/lib/api"
import { ConflictError } from "@/lib/versions"

/* ------------------------------------------------------------------ errors */

export interface ErpError {
  message: string
  code?: "CONFLICT" | "DUPLICATE"
  duplicate?: { id: string; label: string }
}

/**
 * The app's own checks (permission, month lock, stock, reasons, conflicts) keep their messages. A database refusal is
 * turned into business language; nothing else (SQL text, constraint names) ever reaches the browser.
 */
export function toErpError(e: unknown): { status: number; body: ErpError; log: boolean } {
  if (e instanceof ConflictError) return { status: 409, body: { message: e.message, code: "CONFLICT" }, log: false }
  if (e instanceof PossibleDuplicateError) return { status: 409, body: { message: e.message, code: "DUPLICATE", duplicate: e.duplicate }, log: false }
  const pg = e as { code?: string; message?: string; severity?: string }
  if (typeof pg?.code === "string" && /^[0-9A-Z]{5}$/.test(pg.code) && pg.severity) {
    const msg = pg.message ?? ""
    const business = !/^(new row|duplicate key|insert or update|update or delete|null value|.*violates)/i.test(msg) && !/no audit event/.test(msg)
    switch (pg.code) {
      case "23505": return { status: 409, body: { message: "That already exists (a duplicate name, registration, code or number)." }, log: false }
      case "23503": return { status: 409, body: { message: "This record is linked to other records and can't be changed that way." }, log: false }
      case "23P01": return { status: 409, body: { message: "Those dates overlap an existing period." }, log: false }
      case "40001": case "40P01": return { status: 409, body: { message: "Someone else saved at the same moment. Please try again." }, log: false }
      case "42501": return { status: 403, body: { message: business ? msg : "Your role or the month lock doesn't allow this change. Nothing was saved." }, log: false }
      case "23514": case "P0001": case "22023": if (business) return { status: 400, body: { message: msg }, log: false }
    }
    return { status: 500, body: { message: "Something went wrong. Nothing was saved." }, log: true }
  }
  // A connection failure (Node / Postgres.js: ENOTFOUND, ECONNREFUSED, CONNECT_TIMEOUT…) carries a code and the
  // database host in its message — never shown. The app's own errors carry no code (ConflictError is handled above).
  if (e instanceof Error && typeof (e as { code?: unknown }).code === "string") return { status: 503, body: { message: "Can't reach the database right now. Nothing was saved — try again in a moment." }, log: true }
  if (e instanceof Error && !(e instanceof TypeError) && !(e instanceof RangeError)) return { status: 400, body: { message: e.message }, log: false }
  return { status: 500, body: { message: "Something went wrong. Nothing was saved." }, log: true }
}
