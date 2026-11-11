-- Owner's instruction, 11 Nov 2026: two AdBlue profiles — Tata Adblue (customers Dev assigns) and Adblue (every customer).
-- Script A of two. Adds the role values only; nothing uses them yet, so it is safe on its own.
-- PostgreSQL can't use a new enum value in the transaction that adds it: run and COMMIT this script BEFORE
-- 20261111000200_adblue_profiles.sql. Mirrors `Role` in src/lib/types.ts (check:supabase-diesel pins erp_role = Role).
-- Apply in the Supabase SQL Editor after review. Removing a value later means recreating the type (as 20261101000000).

alter type public.erp_role add value if not exists 'TATA_ADBLUE';
alter type public.erp_role add value if not exists 'ADBLUE';
