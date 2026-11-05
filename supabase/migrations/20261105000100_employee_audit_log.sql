-- Owner's instruction, 5 Nov 2026: the Employee sees the Audit Log (sidebar → System), read-only.
-- Mirrors MAP in src/lib/permissions.ts (EMPLOYEE gains 'audit:view') and api.audit.list: the Owner and Dev read every
-- event; any other role reads only events of modules it can view (private.module_resource), never account events.
-- Writing, reviewing and restoring are unchanged (Owner / Dev: "Write own audit events", "Owner and Dev review
-- deletions", restores_event_id). Additive: earlier migrations are not edited.

insert into core.role_permissions (role, permission) values ('EMPLOYEE', 'audit:view') on conflict do nothing;

drop policy "Read audit events" on audit.events;
create policy "Read audit events" on audit.events for select to authenticated
  using ((select private.is_owner_or_dev()) or (module <> 'Accounts' and private.can(private.module_resource(module), 'view')));
