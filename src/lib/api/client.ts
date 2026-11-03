/**
 * The `api` the UI calls (through hooks.ts). Same shape on both backends, so no component knows which one runs:
 * - `local` (default): the browser's localStorage (src/lib/api/index.ts) — the offline / fallback backend.
 * - `supabase` (NEXT_PUBLIC_DATA_BACKEND=supabase): every call goes to POST /api/erp, which runs the same `api.*` on
 *   the server against the shared database as the signed-in account. The browser is never the source of truth.
 */
import { api as localApi, PossibleDuplicateError } from "./index"
import { ConflictError, pendingVersions } from "@/lib/versions"

export const DATA_BACKEND: "local" | "supabase" = process.env.NEXT_PUBLIC_DATA_BACKEND === "supabase" ? "supabase" : "local"
export const isSharedBackend = DATA_BACKEND === "supabase"

class ServerError extends Error {}

async function call(method: string, args: unknown[], expected: Record<string, string> | null): Promise<unknown> {
  let res: Response
  try {
    res = await fetch("/api/erp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method, args, expected: expected ?? undefined }), credentials: "same-origin", cache: "no-store" })
  } catch {
    throw new ServerError("Can't reach the server — check the internet connection. Nothing was saved.")
  }
  // The sign-in gate redirects an expired session to the login page instead of answering.
  if (res.redirected || !(res.headers.get("content-type") ?? "").includes("application/json")) {
    if (typeof window !== "undefined") window.location.reload() // the sign-in gate takes it to /login, remembering the page
    throw new ServerError("Your session has ended. Sign in again.")
  }
  const body = (await res.json()) as { result?: unknown; error?: { message: string; code?: string; duplicate?: { id: string; label: string } } }
  if (res.ok) return body.result
  if (body.error?.code === "CONFLICT") throw new ConflictError()
  if (body.error?.code === "DUPLICATE" && body.error.duplicate) throw new PossibleDuplicateError(body.error.duplicate)
  throw new ServerError(body.error?.message ?? "Something went wrong. Nothing was saved.")
}

/** `api.<ns>.<method>(…)` → POST /api/erp. The record versions are captured synchronously, as the call starts. */
function remoteApi(): typeof localApi {
  return new Proxy({} as typeof localApi, {
    get: (_, ns: string) =>
      new Proxy(
        {},
        {
          get: (__, method: string) =>
            (...args: unknown[]) => call(`${ns}.${method}`, args, pendingVersions()),
        }
      ),
  })
}

export const api: typeof localApi = isSharedBackend ? remoteApi() : localApi
