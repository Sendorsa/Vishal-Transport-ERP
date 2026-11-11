/**
 * The `api` the UI calls (through hooks.ts). Same shape on both backends, so no component knows which one runs:
 * - `local` (default): the browser's localStorage (src/lib/api/index.ts) — the offline / fallback backend.
 * - `supabase` (NEXT_PUBLIC_DATA_BACKEND=supabase): every call goes to POST /api/erp, which runs the same `api.*` on
 *   the server against the shared database as the signed-in account. The browser is never the source of truth.
 */
import { api as localApi, PossibleDuplicateError } from "./index"
import { ConflictError, pendingVersions } from "@/lib/versions"
import { previewRole } from "@/lib/identity"
import { isAdBlueProfile } from "@/lib/permissions"
import { profileCall } from "@/lib/server/erp/profiles"
import { isReadMethod } from "./reads"

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

/** Thrown instead of a write made through the application UI while a DEV previews another role. */
export class PreviewWriteBlockedError extends Error {
  constructor() {
    super("UI Preview Mode: saving is blocked to prevent accidental changes. Return to Dev to make changes — nothing was saved.")
  }
}

/** Thrown instead of a read a previewed AdBlue profile couldn't make (the server refuses it for a real account). */
export class PreviewReadBlockedError extends Error {
  constructor(role: string) {
    super(`UI Preview Mode: ${role === "TATA_ADBLUE" ? "Tata Adblue" : "Adblue"} can't load this — the server refuses it for that role.`)
  }
}

/**
 * A read while a DEV previews an AdBlue profile: the profile's own method list and shapes (profiles.ts), so the screens
 * show what that profile would see — not DEV's data. Tata Adblue gets an empty customer scope: no customer's data is
 * shown, because a preview has no grants (it says so in the banner). Interface only: the request still runs as DEV.
 */
function previewRead(ns: string, method: string, read: () => Promise<unknown>): Promise<unknown> {
  const role = previewRole()
  if (!role || !isAdBlueProfile(role)) return read()
  const shaped = profileCall(role, `${ns}.${method}`, read, role === "TATA_ADBLUE" ? new Set<string>() : null)
  return shaped ? shaped() : Promise.reject(new PreviewReadBlockedError(role))
}

/**
 * UI Preview Mode (identity.ts): while it's on, every `api` method the UI calls that isn't a read is refused here,
 * before it reaches the browser store or the server — whatever the previewed role's screens offer. Reads pass through
 * unchanged for the Owner / Employee previews; for an AdBlue profile they get that profile's method list and shapes
 * (previewRead). This blocks accidental writes through the normal application UI only: it is not server-side
 * enforcement. The API and the server still authorise as the verified DEV account, with DEV's actual permissions, so
 * direct API or database requests may still modify data.
 */
function blockWritesWhilePreviewing(target: typeof localApi): typeof localApi {
  return new Proxy(target, {
    get: (t, ns: string) => {
      const group = Reflect.get(t, ns) as Record<string, unknown> | undefined
      if (!group || typeof group !== "object") return group
      return new Proxy(group, {
        get: (g, method: string) => {
          const fn = Reflect.get(g, method)
          if (typeof fn !== "function") return fn
          if (isReadMethod(ns, method)) return (...args: unknown[]) => (previewRole() ? previewRead(ns, method, () => Reflect.apply(fn, g, args)) : Reflect.apply(fn, g, args))
          return (...args: unknown[]) => {
            if (previewRole()) throw new PreviewWriteBlockedError()
            return Reflect.apply(fn, g, args)
          }
        },
      })
    },
  })
}

export const api: typeof localApi = blockWritesWhilePreviewing(isSharedBackend ? remoteApi() : localApi)
