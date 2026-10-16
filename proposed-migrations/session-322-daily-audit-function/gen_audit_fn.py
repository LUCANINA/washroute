import re, json

SRC = 'database/audits/daily_audit.sql'
src = open(SRC).read()

def strip_comments(s):
    out=[]; i=0; n=len(s); q=None
    while i < n:
        c = s[i]
        if q:
            out.append(c)
            if c == q:
                if q == "'" and i+1 < n and s[i+1] == "'":
                    out.append(s[i+1]); i += 2; continue
                q = None
            i += 1; continue
        if c in ("'", '"'):
            q = c; out.append(c); i += 1; continue
        if c == '-' and i+1 < n and s[i+1] == '-':
            while i < n and s[i] != '\n': i += 1
            continue
        out.append(c); i += 1
    return ''.join(out)

def split_stmts(s):
    parts=[]; cur=[]; i=0; n=len(s); q=None
    while i < n:
        c=s[i]
        if q:
            cur.append(c)
            if c == q:
                if q == "'" and i+1 < n and s[i+1] == "'":
                    cur.append(s[i+1]); i += 2; continue
                q=None
            i+=1; continue
        if c in ("'", '"'):
            q=c; cur.append(c); i+=1; continue
        if c == ';':
            parts.append(''.join(cur)); cur=[]; i+=1; continue
        cur.append(c); i+=1
    if ''.join(cur).strip(): parts.append(''.join(cur))
    return [p.strip() for p in parts if p.strip()]

hdr = re.compile(r'^--\s*@check\s+id=(\S+)\s+name="([^"]*)"\s+priority=(P[0-3])\s*$', re.M)
ms = list(hdr.finditer(src))
LABEL = re.compile(r"^SELECT\s+'[^']*'\s+AS\s+check_name$", re.I | re.S)

checks=[]; problems=[]
for i,m in enumerate(ms):
    end = ms[i+1].start() if i+1 < len(ms) else len(src)
    body = src[m.end():end]
    stmts = [s for s in split_stmts(strip_comments(body)) if not LABEL.match(s.strip())]
    if not stmts:
        problems.append((m.group(1), 'no statement')); continue
    for s_i, q in enumerate(stmts):
        q = q.strip()
        if q.split()[0].upper() not in ('SELECT', 'WITH'):
            problems.append((m.group(1), 'not a select')); continue
        # A check file entry may hold more than one independent query (check 16
        # has an invalid-polygon query and an overlapping-zones query). Emit each
        # as its own sub-check rather than merging them, so the counts stay apart.
        sfx = '' if len(stmts) == 1 else chr(ord('a') + s_i)
        nm = m.group(2) if len(stmts) == 1 else '%s (%s)' % (m.group(2), sfx)
        checks.append({'id': m.group(1) + sfx, 'name': nm, 'prio': m.group(3), 'sql': q})

if problems:
    raise SystemExit('PROBLEMS: %r' % (problems,))

def dq(s):
    # dollar-quote the SQL body; pick a tag that does not occur in it
    for tag in ('q','qq','qqq','auditq'):
        t = '$%s$' % tag
        if t not in s: return t
    raise SystemExit('no safe dollar-quote tag')

blocks=[]
for c in checks:
    lit_name = c['name'].replace("'", "''")
    blocks.append(f"""  -- ── check {c['id']}: {c['name'][:70]}
  BEGIN
    SELECT count(*) INTO v_n FROM (
{chr(10).join('      ' + l for l in c['sql'].splitlines())}
    ) q;
    RETURN QUERY SELECT '{c['id']}'::text, '{lit_name}'::text, '{c['prio']}'::text, v_n, NULL::text;
  EXCEPTION WHEN OTHERS THEN
    RETURN QUERY SELECT '{c['id']}'::text, '{lit_name}'::text, '{c['prio']}'::text, NULL::bigint, SQLERRM::text;
  END;
""")

mig = f"""-- session_322_run_daily_audit.sql
--
-- Moves the {len(checks)} detection queries in database/audits/daily_audit.sql into a single
-- read-only database function, so the daily bug check no longer needs a shell on
-- David's Mac to read that file. Cloud-only scheduled runs can now call:
--
--     SELECT * FROM public.run_daily_audit();
--
-- and get one row per check: check_id, check_name, priority, row_count, error.
-- row_count = 0 means clear. A non-null `error` means that one check failed to
-- run (its own EXCEPTION block) — the other {len(checks)-1} still report.
--
-- The queries below are copied VERBATIM from daily_audit.sql by
-- proposed-migrations/session-322-daily-audit-function/gen_audit_fn.py.
-- daily_audit.sql remains the source of truth: change it there, re-run the
-- generator, and apply a new migration. Do not hand-edit the bodies here.
--
-- Checks that are NOT SQL are not included (check 24, the driver-app RPC
-- call-site scan, is a filesystem check: scripts/audit-rpc-call-sites.sh).
--
-- SECURITY: SECURITY DEFINER because the audit must see every row regardless of
-- RLS, exactly as David's admin session does today. It is read-only (no INSERT,
-- UPDATE, DELETE anywhere in the body) and gated on assert_staff(), so a
-- customer JWT cannot call it. anon and PUBLIC are revoked explicitly — per the
-- session 148 lesson, REVOKE PUBLIC alone is not enough on Supabase.

CREATE OR REPLACE FUNCTION public.run_daily_audit()
RETURNS TABLE (
  check_id    text,
  check_name  text,
  priority    text,
  row_count   bigint,
  error       text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_n bigint;
BEGIN
  PERFORM assert_staff();

{chr(10).join(blocks)}
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.run_daily_audit() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.run_daily_audit() FROM anon;
GRANT  EXECUTE ON FUNCTION public.run_daily_audit() TO authenticated, service_role;

COMMENT ON FUNCTION public.run_daily_audit() IS
  'Read-only daily health audit: one row per check from database/audits/daily_audit.sql. Staff only. Generated by session-322 generator — edit daily_audit.sql, not this function.';
"""

open('proposed-migrations/session-322-daily-audit-function/session_322_run_daily_audit.sql','w').write(mig)
print("checks embedded:", len(checks))
print("migration chars:", len(mig))
print("ids:", ", ".join(c['id'] for c in checks))
