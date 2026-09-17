-- Session 299e: admin page "App Content" (FAQ + business info editor).
-- Data only: seed role_permissions so the nav item appears for admin + manager.
INSERT INTO public.role_permissions (role, page_id, allowed) VALUES
 ('admin','appcontent',true), ('manager','appcontent',true),
 ('laundry_tech','appcontent',false), ('attendant','appcontent',false), ('cpa','appcontent',false)
ON CONFLICT (role, page_id) DO NOTHING;
-- Rollback: DELETE FROM public.role_permissions WHERE page_id = 'appcontent';
