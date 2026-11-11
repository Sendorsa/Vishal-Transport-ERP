/**
 * Database types for supabase/migrations, in the shape `supabase gen types typescript` produces.
 * Hand-written: covers the `public` schema only (the Data API's schema). The Diesel schemas (core, fuel, finance,
 * audit, private) are deliberately not exposed through the Data API (D-1: writes go through a server-side Postgres
 * connection), so supabase-js never needs types for them. Once a project is linked, regenerate with:
 *   npx supabase gen types typescript --linked --schema public > src/lib/supabase/database.types.ts
 */
export type ErpRole = "OWNER" | "DEV" | "EMPLOYEE" | "TATA_ADBLUE" | "ADBLUE" // 20261101000000_erp_roles_three.sql, 20261111000100_erp_roles_adblue.sql
export type AccountStatus = "INVITED" | "ACTIVE" | "DISABLED"

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
    // Account functions (20261101000700_accounts.sql). Each checks the caller's role inside the database.
    Functions: {
      link_google_account: { Args: Record<PropertyKey, never>; Returns: { role: ErpRole; status: AccountStatus }[] }
      add_account: { Args: { p_email: string; p_role: ErpRole; p_full_name?: string | null }; Returns: string }
      set_account_role: { Args: { p_id: string; p_role: ErpRole; p_reason: string }; Returns: undefined }
      set_account_status: { Args: { p_id: string; p_status: AccountStatus; p_reason: string }; Returns: undefined }
      relink_account: { Args: { p_id: string; p_new_email: string; p_reason: string }; Returns: undefined }
      // Tata Adblue's customers (20261111000200_adblue_profiles.sql), Dev only.
      set_customer_access: { Args: { p_profile_id: string; p_customer_ids: string[]; p_reason: string }; Returns: undefined }
      list_customer_access: { Args: Record<PropertyKey, never>; Returns: { profile_id: string; customer_id: string; granted_at: string }[] }
    }
    Enums: { erp_role: ErpRole; account_status: AccountStatus }
    CompositeTypes: { [_ in never]: never }
  }
}
