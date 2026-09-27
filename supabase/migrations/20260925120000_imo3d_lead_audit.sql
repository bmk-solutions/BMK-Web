-- A buyer's «سجّل اهتمامك» now lives in VERA and, through it, Developer OS (owner, 2026-09-25).
-- This project keeps a MASKED audit only: the masked phone (05••••123), the tour, the time, when
-- VERA accepted it and where VERA routed it. Never the full phone, the name or the message.
-- Existing rows (none in production when written) are masked in place; nothing is deleted.
-- Deploy order: apply this, then the code that writes leadAuditRow(); the old code's full-phone
-- insert is refused by the check below, never stored.
-- The old code also keyed its per-phone limit on the number itself (lead:+966…:<tour>); those
-- rows are deleted. The new keys are keyed hashes, which the pattern cannot match.
-- A limit spent on a request VERA did not accept is given back (imo3d_rate_limit_refund), so a
-- buyer who retried through an outage is never told his request was already sent.
BEGIN;
ALTER TABLE public.imo3d_leads ADD COLUMN forwarded_at timestamptz,ADD COLUMN vera_routed text;
UPDATE public.imo3d_leads SET phone=CASE WHEN regexp_replace(phone,'\D','','g') ~ '^(00966|966|0)?5[0-9]{8}$' THEN '05••••'||right(regexp_replace(phone,'\D','','g'),3)
 ELSE (CASE WHEN phone ~ '^\s*(\+|00)' THEN '+' ELSE '' END)||left(regexp_replace(regexp_replace(phone,'\D','','g'),'^00',''),2)||'••••'||right(regexp_replace(phone,'\D','','g'),3) END;
ALTER TABLE public.imo3d_leads DROP COLUMN name,DROP COLUMN note;
ALTER TABLE public.imo3d_leads ADD CONSTRAINT imo3d_leads_masked_phone CHECK(phone ~ '^\+?[0-9]{2}•{4}[0-9]{3}$'),
 ADD CONSTRAINT imo3d_leads_vera_routed CHECK(vera_routed IS NULL OR vera_routed IN('project','developer','hint','fallback')),
 ADD CONSTRAINT imo3d_leads_forwarded CHECK((forwarded_at IS NULL)=(vera_routed IS NULL));
CREATE OR REPLACE FUNCTION public.imo3d_list_leads(p_project_id text DEFAULT NULL,p_cursor_created_at timestamptz DEFAULT NULL,p_cursor_id text DEFAULT NULL,p_limit integer DEFAULT 50) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE total bigint; results jsonb; amount integer:=least(1000,greatest(1,p_limit));
BEGIN
 SELECT count(*) INTO total FROM public.imo3d_leads l JOIN public.imo3d_tours t ON t.id=l.tour_id WHERE p_project_id IS NULL OR t.project_id=p_project_id;
 SELECT coalesce(jsonb_agg(to_jsonb(s)),'[]') INTO results FROM (SELECT l.id,l.tour_id AS "tourId",l.phone,l.created_at AS "createdAt",l.forwarded_at AS "forwardedAt",l.vera_routed AS "routed",p.id AS "projectId",p.name AS "projectName",t.payload->>'title' AS "tourTitle" FROM public.imo3d_leads l JOIN public.imo3d_tours t ON t.id=l.tour_id JOIN public.imo3d_projects p ON p.id=t.project_id WHERE (p_project_id IS NULL OR p.id=p_project_id) AND (p_cursor_created_at IS NULL OR (l.created_at,l.id)<(p_cursor_created_at,p_cursor_id)) ORDER BY l.created_at DESC,l.id DESC LIMIT amount+1) s;
 RETURN jsonb_build_object('total',total,'hasMore',jsonb_array_length(results)>amount,'leads',CASE WHEN jsonb_array_length(results)>amount THEN results-amount ELSE results END);
END $$;
REVOKE ALL ON FUNCTION public.imo3d_list_leads(text,timestamptz,text,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.imo3d_list_leads(text,timestamptz,text,integer) TO service_role;
DELETE FROM public.imo3d_request_limits WHERE key ~ '^lead:\+?[0-9]{8,15}:';
CREATE FUNCTION public.imo3d_rate_limit_refund(p_key text) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 UPDATE public.imo3d_request_limits SET count=greatest(count-1,0) WHERE key=p_key;
$$;
REVOKE ALL ON FUNCTION public.imo3d_rate_limit_refund(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.imo3d_rate_limit_refund(text) TO service_role;
COMMIT;
