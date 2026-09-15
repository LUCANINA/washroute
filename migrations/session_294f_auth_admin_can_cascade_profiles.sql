-- Session 294f (applied 2026-09-15)
-- auth.users -> public.profiles is ON DELETE CASCADE, and the cascade runs as
-- supabase_auth_admin (owner of auth.users), which had no privilege on profiles.
-- Every auth.admin.deleteUser() failed "permission denied for table profiles", so
-- stale phone logins were never cleared and SMS codes landed on empty logins.
GRANT SELECT, DELETE ON TABLE public.profiles TO supabase_auth_admin;
-- Rollback: REVOKE SELECT, DELETE ON TABLE public.profiles FROM supabase_auth_admin;
