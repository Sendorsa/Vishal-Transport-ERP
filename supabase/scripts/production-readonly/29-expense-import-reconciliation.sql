-- READ-ONLY. Expense import reconciliation (Phase 2B, §7.5 / §7.6): per batch — items by outcome; imported entries still
-- present / deleted since; per section × month counts and Σ amounts of the batch's entries; per-broker outstanding; the
-- latest rollback status (from the audit trail). Compare with the import's dry-run report. A single SELECT — changes nothing.
select jsonb_pretty(coalesce(jsonb_agg(b order by b ->> 'created_at'), '[]'::jsonb)) as reconciliation
from (
  select jsonb_build_object(
    'batch', ib.id,
    'source', ib.source_label,
    'created_at', to_char(ib.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'items_by_outcome', (select jsonb_object_agg(k, n) from (select source_collection || ':' || outcome as k, count(*) as n from expense.import_items i where i.batch_id = ib.id group by 1) x),
    'entries_imported', (select count(*) from expense.import_items i where i.batch_id = ib.id and i.source_collection = 'expenses' and i.outcome = 'IMPORTED'),
    'entries_present', (select count(*) from expense.entries e where e.import_batch_id = ib.id),
    'entries_deleted_since', (select count(*) from expense.import_items i where i.batch_id = ib.id and i.source_collection = 'expenses' and i.outcome = 'IMPORTED'
                              and not exists (select 1 from expense.entries e where e.id = coalesce(i.target_id, i.source_id))),
    'per_section_month', (select jsonb_object_agg(k, v) from (
        select e.section || ' ' || to_char(e.date, 'YYYY-MM') as k, jsonb_build_object('records', count(*), 'amount', sum(e.amount), 'paid', sum(e.paid_amount)) as v
        from expense.entries e where e.import_batch_id = ib.id group by e.section, to_char(e.date, 'YYYY-MM')) x),
    'latest_rollback', (select ev.note from audit.events ev where ev.record_id = ib.id and ev.action = 'UPDATED' and ev.note like 'Rollback %' order by ev.at desc limit 1)
  ) as b
  from expense.import_batches ib
) batches
union all
select jsonb_pretty(coalesce((select jsonb_object_agg(k, v) from (
  select broker_key as k, sum(case when entry_type = 'PAYMENT' then -paid_amount else amount - paid_amount end) as v
  from expense.entries where section = 'BROKER' group by broker_key) x), '{}'::jsonb)) as broker_outstanding_now;
