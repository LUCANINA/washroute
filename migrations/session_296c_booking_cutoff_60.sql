-- Session 296c (2026-09-16): a slot can be booked until 60 min before it ends (was 30).
-- David: "only allow pickups within one hour or more from the end of the window".
-- Applies to all 14 route templates (only trigger: route_templates_updated_at; no messaging).
-- Rollback: ALTER TABLE ... SET DEFAULT 30; UPDATE public.route_templates SET booking_cutoff_minutes = 30 WHERE booking_cutoff_minutes = 60;
ALTER TABLE public.route_templates ALTER COLUMN booking_cutoff_minutes SET DEFAULT 60;
UPDATE public.route_templates SET booking_cutoff_minutes = 60 WHERE booking_cutoff_minutes = 30;
