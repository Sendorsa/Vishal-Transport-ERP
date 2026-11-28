-- Owner's instruction, 28 Nov 2026: a new ERP profile "EMP 1" (role value EMP1) — the Employee's access plus Expense
-- (Road Tax, Fitness, Fines, Broker Charges; view and edit only). NOT YET APPLIED to any project.
-- Script A of two. Adds the role value only; nothing uses it yet, so it is safe on its own.
-- PostgreSQL can't use a new enum value in the transaction that adds it: run and COMMIT this script BEFORE
-- 20261129000100_emp1_profile.sql. Mirrors `Role` in src/lib/types.ts (check:supabase-diesel pins erp_role = Role).
-- Apply in the Supabase SQL Editor after review. Removing a value later means recreating the type (as 20261101000000);
-- the rollback script (10-rollback-emp1-profile.sql) leaves it in place, unused.

alter type public.erp_role add value if not exists 'EMP1' after 'EMPLOYEE';
