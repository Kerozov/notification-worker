-- Report real send jobs. Campaign parents summarize their pockets and do not send.
create or replace function public.admin_overdue_email_jobs(
  p_due_before timestamptz,
  p_stuck_before timestamptz
) returns table (
  id uuid, reason text, issue_count integer, priority integer, sort_at timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  with issues as (
    select job.id, coalesce(job.parent_id, job.id) as group_id,
      case job.status
        when 'processing' then 'stuck'
        when 'pending' then 'overdue'
        else 'failed'
      end as reason,
      case job.status when 'processing' then 1 when 'pending' then 2 else 3 end as priority,
      case when job.status = 'pending' then job.send_at else job.updated_at end as sort_at
    from public.email_jobs job
    where job.kind = 'send' and job.dismissed_at is null
      and (
        job.status = 'failed'
        or (job.status = 'processing' and job.updated_at <= p_stuck_before)
        or (
          job.status = 'pending'
          and job.send_at <= p_due_before and job.updated_at <= p_due_before
          -- An empty queue still needs a worker run to close the job.
          and coalesce((
            select coalesce(d.next_attempt_at, '-infinity'::timestamptz)
            from public.email_deliveries d
            where d.job_id = job.id and d.status = 'pending'
            order by d.next_attempt_at nulls first
            limit 1
          ), '-infinity'::timestamptz) <= p_due_before
        )
      )
      -- Unstarted pockets wait for the active pocket to advance the chain.
      and not (
        job.status = 'pending' and job.parent_id is not null
        and job.sent_count = 0 and job.failed_count = 0
        and exists (
          select 1 from public.email_jobs sibling
          where sibling.parent_id = job.parent_id and sibling.id <> job.id
            and (sibling.status = 'processing' or (
              sibling.updated_at > p_due_before and (
                sibling.status in ('sent', 'failed')
                or (sibling.status = 'pending' and (sibling.sent_count > 0 or sibling.failed_count > 0))
              )
            ))
        )
      )
  )
  select distinct on (group_id) issues.id, issues.reason,
    (count(*) over (partition by group_id))::integer, issues.priority, issues.sort_at
  from issues
  order by group_id, issues.priority, issues.sort_at, issues.id
$$;

revoke all on function public.admin_overdue_email_jobs(timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.admin_overdue_email_jobs(timestamptz, timestamptz)
  to service_role;
