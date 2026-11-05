/**
 * Which `api.<ns>.<method>` calls only read. One list for the shared database's allowlist (server/erp/http.ts: reads
 * run without the write lock) and UI Preview Mode (client.ts: the UI's other calls are blocked while previewing — a
 * browser guard against accidental changes, not server-side enforcement).
 */
const READS = new Set(["list", "get", "history", "editedIds", "unreviewedDeletions", "checkRestore", "exportBackup"])

export const isReadMethod = (ns: string, method: string) => READS.has(method) || (ns === "settings" && method === "get")
