/**
 * Database types for supabase/migrations, in the shape `supabase gen types typescript` produces.
 * Hand-written: covers the `public` schema only (the Data API's schema). The Diesel schemas (core, fuel, finance,
 * audit, private) are deliberately not exposed through the Data API (D-1: writes go through a server-side Postgres
 * connection), so supabase-js never needs types for them. Once a project is linked, regenerate with:
 *   npx supabase gen types typescript --linked --schema public > src/lib/supabase/database.types.ts
 */
type ErpRole = "OWNER" | "DEV" | "EMPLOYEE" // 20261101000000_erp_roles_three.sql
type AccountStatus = "INVITED" | "ACTIVE" | "DISABLED"

export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string
          user_id: string | null
          email: string
          full_name: string | null
          role: ErpRole
          status: AccountStatus
          invited_by: string | null
          activated_at: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          user_id?: string | null
          email: string
          full_name?: string | null
          role: ErpRole
          status?: AccountStatus
          invited_by?: string | null
          activated_at?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: Partial<Database["public"]["Tables"]["profiles"]["Insert"]>
        Relationships: []
      }
    }
    Views: { [_ in never]: never }
    Functions: { [_ in never]: never }
    Enums: { erp_role: ErpRole; account_status: AccountStatus }
    CompositeTypes: { [_ in never]: never }
  }
}
