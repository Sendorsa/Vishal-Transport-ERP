import { PermissionError } from "@/lib/api"
import { runInDatabase } from "@/lib/server/erp/engine"
import { cleanVersions, requestIdentity, resolveMethod, serverTransact, toErpError } from "@/lib/server/erp/http"
import { profileCall } from "@/lib/server/erp/profiles"

/**
 * POST /api/erp — one `api.*` call against the shared database: { method: "diesel.create", args: [...], expected }.
 * The caller is the verified account of the session (never a role or user id from the body). Only methods of the public
 * `api` object are callable; reset / clear / restore of the whole database never are. The AdBlue profiles may call only
 * their listed methods, and their reads are limited to what they may see (profiles.ts). One transaction per call.
 */
export async function POST(request: Request) {
  const identity = await requestIdentity()
  if ("error" in identity) return Response.json({ error: { message: identity.error } }, { status: identity.status })
  let body: { method?: unknown; args?: unknown; expected?: unknown }
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: { message: "Bad request." } }, { status: 400 })
  }
  const target = resolveMethod(body.method)
  if (!target || !Array.isArray(body.args)) return Response.json({ error: { message: "Unknown operation." } }, { status: 400 })
  const args = body.args as unknown[]
  const method = String(body.method)
  // Refused attempts go to the server log (Vercel), never into the audit trail: role, account, method, reason.
  const denied = (reason: string) => console.warn(`[erp-denied] ${JSON.stringify({ role: identity.role, profileId: identity.profileId, method, reason })}`)
  const call = profileCall(identity.role, method, () => target.fn(...args))
  if (!call) {
    denied("not a method of this role")
    return Response.json({ error: { message: "Your role can't do that." } }, { status: 403 })
  }
  try {
    const result = await runInDatabase(serverTransact(), identity, target.write, cleanVersions(body.expected), call)
    return Response.json({ result: result ?? null })
  } catch (e) {
    const { status, body: error, log } = toErpError(e)
    if (e instanceof PermissionError || status === 403 || /database refused/.test(error.message)) denied(error.message)
    if (log) console.error(`[erp] ${method} failed for ${identity.role} ${identity.profileId}:`, e)
    return Response.json({ error }, { status })
  }
}
