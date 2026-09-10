import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// cs-signal-scan v2 — customer-service escalation & pattern detection
//
// Design: docs/washroute/DESIGN-CS-ESCALATION.md
//
// WHY THIS EXISTS: a neighbour at 5811 Mendocino asked us seven times over seven
// weeks to stop parking in her driveway. Three reps sent three near-identical
// apologies. She is not a customer, so she was invisible to every dashboard we
// had, and nobody in management knew until the thread was shown to David on
// Sep 10 2026. This function reads raw comms directly; it does NOT depend on a
// rep filing anything, because that dependency is exactly what failed.
//
// MODES (body.mode, default 'dry'):
//   'dry'    — computes everything, writes NOTHING, returns the full report.
//   'write'  — upserts cs_signals and creates/updates cs_issues. Sends nothing.
//   'notify' — NOT IMPLEMENTED IN v1. Returns 501 on purpose. Email lands in a
//              later version and must pass washroute-preflight first: this
//              function reads customer comms, and anything that COULD message a
//              customer WILL message every customer until proven otherwise.
//
// The model classifies. It never closes an issue, never notifies, never sends.

const SUPABASE_URL  = Deno.env.get('SUPABASE_URL') ?? '';
const SVC_KEY       = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const ANON_KEY      = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const ANTHROPIC_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-wr-internal',
  'Content-Type': 'application/json',
};

const db: Record<string, string> = {
  'Authorization': `Bearer ${SVC_KEY}`,
  'apikey': SVC_KEY,
  'Content-Type': 'application/json',
};

async function dbGet(path: string): Promise<any[]> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: db });
  if (!r.ok) throw new Error(`dbGet ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
}

async function dbPost(path: string, body: unknown, prefer = 'return=representation'): Promise<any> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'POST', headers: { ...db, Prefer: prefer }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`dbPost ${path} -> ${r.status} ${await r.text()}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

async function dbPatch(path: string, body: unknown): Promise<any> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH', headers: { ...db, Prefer: 'return=representation' }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`dbPatch ${path} -> ${r.status} ${await r.text()}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

// ── Authorization ────────────────────────────────────────────────────────────
// Callers: pg_cron (posts the ANON key as bearer, plus the x-wr-internal
// secret), the service-role key, and staff hitting "Scan now" in the dashboard.
// Never anon-from-a-browser.
async function authorize(req: Request): Promise<{ ok: boolean; status?: number; reason?: string }> {
  const internal = req.headers.get('x-wr-internal') || '';
  if (internal) {
    const rows = await dbGet('wr_internal_auth?select=secret&limit=1');
    if (rows?.[0]?.secret && internal === rows[0].secret) return { ok: true };
  }
  const auth = req.headers.get('Authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return { ok: false, status: 401, reason: 'Missing Authorization header' };
  const jwt = m[1];
  if (jwt === SVC_KEY) return { ok: true };
  if (jwt === ANON_KEY) return { ok: false, status: 401, reason: 'Anon key alone not accepted' };

  // Staff JWT: verify the caller is admin/manager/attendant.
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/is_cs_team`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}`, apikey: ANON_KEY, 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (r.ok && (await r.json()) === true) return { ok: true };
  return { ok: false, status: 403, reason: 'Not authorized' };
}

// ── Stage 1: cheap prefilter ────────────────────────────────────────────────
// Volume is ~30 inbound messages a day, so the prefilter runs in TypeScript
// rather than as a SECURITY DEFINER SQL function. That keeps every tunable in
// one readable file and avoids a second migration against the one thing that
// cannot be undone.
const THEME_PATTERNS: Array<[string, RegExp]> = [
  ['damage',         /\b(holes?|torn|tear|ripped|rip in|snagged?|damaged|ruined|destroyed)\b/i],
  ['lost_item',      /\b(missing|lost|never returned|didn'?t get back|short a|not in my (order|bag)|wrong (order|bag))\b/i],
  ['quality',        /\b(stain(ed)?|dirty|not clean|still smells?|odou?r|musty)\b/i],
  ['parking',        /\b(park(ing|ed)?|driveway|blocked|blocking|loading zone)\b/i],
  ['missed_service', /\b(never (came|showed)|no.?show|didn'?t (come|show|pick)|missed (my )?(pickup|delivery)|still waiting)\b/i],
  ['billing',        /\b(overcharg\w*|double.?charg\w*|refund|charged me|wrong amount)\b/i],
  ['driver_conduct', /\b(rude|driver (was|is)|yelled|slammed|disrespect\w*)\b/i],
];

const ESCALATION_RE = /\b(again|still (happening|not)|keep asking|keeps? doing|third time|second time|every ?time|over (&|and) over|how many times|ridiculous|unacceptable|negative review|bad review|yelp|lawyer|attorney|police|fed up|had enough|what the fuck|asshole|bullshit)\b/i;

type Msg = { id: string; phone: string; customer_id: string | null; body: string; at: string; source: string };

function prefilter(m: Msg): { themes: string[]; escalating: boolean } {
  const themes = THEME_PATTERNS.filter(([, re]) => re.test(m.body)).map(([t]) => t);
  return { themes, escalating: ESCALATION_RE.test(m.body) };
}

// ── Stage 2: LLM classification ─────────────────────────────────────────────
// This is what separates a real grievance from a sales robocall. Measured on
// 12 months of history: of the 6 non-customer phones with 3+ contact days, ONE
// was a genuine complaint and five were vendor spam. No regex makes that call.
type Verdict = {
  is_complaint: boolean;
  theme: string;
  severity: number;
  is_same_as_open_issue: boolean;
  subject_ref: Record<string, unknown>;
  customer_intent: string;
  rationale: string;
};

const THEMES = ['parking','driver_conduct','damage','lost_item','missed_service','quality','billing','app','account','other'];

async function classify(thread: Msg[], openIssue: any | null): Promise<Verdict | null> {
  if (!ANTHROPIC_KEY) return null;
  const transcript = thread.map(m => `[${m.at}] ${m.source}: ${m.body.slice(0, 600)}`).join('\n');
  const prompt = `You triage inbound messages for a laundry pickup-and-delivery company in Oakland, CA.

Decide whether the MOST RECENT message is a genuine complaint or service grievance from a real person.

Not complaints: sales pitches, vendor outreach, marketing, robocalls, spam, wrong numbers,
ordinary scheduling requests, ordinary questions, and thank-you messages.

IMPORTANT: the sender may be a NON-CUSTOMER (a neighbour, a landlord, a passer-by). A
non-customer with a real grievance about our vans or our drivers is still a genuine complaint.

Thread (oldest first):
${transcript}

${openIssue ? `There is already an OPEN issue for this contact: theme=${openIssue.theme}, opened ${openIssue.first_reported_at}, reported ${openIssue.report_count} time(s), titled "${openIssue.title}".` : 'There is no open issue for this contact.'}

Reply with ONLY a JSON object, no prose:
{"is_complaint": bool,
 "theme": one of ${JSON.stringify(THEMES)},
 "severity": 1|2|3,
 "is_same_as_open_issue": bool,
 "subject_ref": {"address": str|null, "driver": str|null},
 "customer_intent": "one short clause: what they are asking us to DO",
 "rationale": "one short sentence"}

severity 1 = ordinary first-time complaint.
severity 2 = repeated, or a non-customer grievance.
severity 3 = threatens a review/legal action, uses profanity at us, or says they have asked repeatedly and nothing changed.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [
        { role: 'user', content: prompt },
        { role: 'assistant', content: '{' },   // prefill forces JSON
      ],
    }),
  });
  if (!res.ok) { console.error('[cs-signal-scan] anthropic', res.status, await res.text()); return null; }
  const j = await res.json();
  try {
    const v = JSON.parse('{' + (j?.content?.[0]?.text ?? ''));
    if (typeof v.is_complaint !== 'boolean') return null;
    if (!THEMES.includes(v.theme)) v.theme = 'other';
    v.severity = Math.min(3, Math.max(1, Number(v.severity) || 1));
    return v as Verdict;
  } catch (e) {
    console.error('[cs-signal-scan] unparseable verdict', e, j?.content?.[0]?.text);
    return null;
  }
}

// ── Main ────────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    const auth = await authorize(req);
    if (!auth.ok) return new Response(JSON.stringify({ error: auth.reason }), { status: auth.status ?? 401, headers: CORS });

    const body = await req.json().catch(() => ({}));
    const mode: string = body.mode ?? 'dry';
    const lookbackDays: number = Math.min(400, Math.max(1, Number(body.lookback_days) || 2));

    if (mode === 'notify') {
      return new Response(JSON.stringify({
        error: 'notify mode is not implemented in v1',
        detail: 'Email is added in a later version and must pass washroute-preflight first.',
      }), { status: 501, headers: CORS });
    }
    if (!['dry', 'write'].includes(mode)) {
      return new Response(JSON.stringify({ error: `unknown mode '${mode}'` }), { status: 400, headers: CORS });
    }

    const sinceIso = new Date(Date.now() - lookbackDays * 864e5).toISOString();
    const report: any = { mode, lookback_days: lookbackDays, since: sinceIso, candidates: 0, classified: 0, skipped_already_seen: 0, signals: [], errors: [] };

    // ── Gather inbound comms ────────────────────────────────────────────────
    const sms = await dbGet(
      `sms_messages?select=id,customer_id,from_number,body,created_at&direction=eq.inbound&created_at=gte.${sinceIso}&order=created_at.asc&limit=5000`);
    const vms = await dbGet(
      `voicemails?select=id,customer_id,from_number,transcription_text,created_at&created_at=gte.${sinceIso}&order=created_at.asc&limit=2000`);

    const msgs: Msg[] = [
      ...sms.filter((r: any) => r.body?.trim()).map((r: any) => ({
        id: r.id, phone: r.from_number, customer_id: r.customer_id, body: r.body, at: r.created_at, source: 'sms',
      })),
      ...vms.filter((r: any) => r.transcription_text?.trim()).map((r: any) => ({
        id: r.id, phone: r.from_number, customer_id: r.customer_id, body: r.transcription_text, at: r.created_at, source: 'voicemail',
      })),
    ].sort((a, b) => a.at.localeCompare(b.at));

    // ── Stage 1 ─────────────────────────────────────────────────────────────
    const candidates = msgs.filter(m => {
      const p = prefilter(m);
      return p.themes.length > 0 || p.escalating;
    });
    report.candidates = candidates.length;

    // One classification per contact, on their most recent candidate message.
    const byPhone = new Map<string, Msg[]>();
    for (const m of candidates) {
      if (!m.phone) continue;
      if (!byPhone.has(m.phone)) byPhone.set(m.phone, []);
      byPhone.get(m.phone)!.push(m);
    }

    for (const [phone, allPhoneMsgs] of byPhone) {
      try {
        // ── Idempotency gate ────────────────────────────────────────────────
        // A message must be counted ONCE, ever. Without this, re-running the
        // same window re-counts messages the last run already saw: the issue
        // that run created then looks like proof of a repeat contact, so
        // report_count climbs and severity ratchets to 3 on nothing new. A
        // detector that escalates on its own output is a cry-wolf generator,
        // and a queue nobody trusts is the failure we are fixing, not a new
        // one to ship. Caught by re-running an identical window and watching
        // severity-3 go 2 -> 5.
        const priorSignals = await dbGet(
          `cs_signals?select=id,fingerprint,severity,status,evidence&contact_phone=eq.${encodeURIComponent(phone)}`);
        const seenIds = new Set<string>();
        for (const sig of priorSignals) {
          for (const mid of (sig?.evidence?.message_ids ?? [])) seenIds.add(String(mid));
        }
        const phoneMsgs = allPhoneMsgs.filter(m => !seenIds.has(String(m.id)));
        if (phoneMsgs.length === 0) {
          report.skipped_already_seen++;
          // Nothing new from this contact. Refresh liveness only -- never
          // severity, never report_count. No LLM call either; reruns are free.
          if (mode === 'write') {
            for (const sig of priorSignals.filter((x: any) => x.status === 'open')) {
              await dbPatch(`cs_signals?id=eq.${sig.id}`, { last_seen_at: new Date().toISOString() });
            }
          }
          continue;
        }

        // Thread context: last 5 inbound messages from this phone, all time.
        const ctx = await dbGet(
          `sms_messages?select=id,customer_id,from_number,body,created_at&direction=eq.inbound&from_number=eq.${encodeURIComponent(phone)}&order=created_at.desc&limit=5`);
        const thread: Msg[] = ctx.reverse().filter((r: any) => r.body?.trim()).map((r: any) => ({
          id: r.id, phone: r.from_number, customer_id: r.customer_id, body: r.body, at: r.created_at, source: 'sms',
        }));
        const threadForModel = thread.length ? thread : phoneMsgs.slice(-5);

        const openIssues = await dbGet(
          `cs_issues?select=id,title,theme,status,report_count,first_reported_at,severity,resolved_at,resolution_action&contact_phone=eq.${encodeURIComponent(phone)}&order=created_at.desc&limit=5`);
        const openIssue = openIssues.find((i: any) => i.status !== 'resolved') ?? null;
        const recentlyClosed = openIssues.find((i: any) =>
          i.status === 'resolved' && i.resolved_at && (Date.now() - Date.parse(i.resolved_at)) < 30 * 864e5) ?? null;

        const verdict = await classify(threadForModel, openIssue);
        report.classified++;
        if (!verdict || !verdict.is_complaint) continue;

        const latest = phoneMsgs[phoneMsgs.length - 1];
        const isCustomer = !!latest.customer_id;
        const escalating = phoneMsgs.some(m => ESCALATION_RE.test(m.body));

        // ── Stage 3: detectors ────────────────────────────────────────────
        let signalType = 'repeat_contact';
        let severity = verdict.severity;

        if (!isCustomer) {
          signalType = 'noncustomer_complaint';
          severity = Math.max(severity, 2);
        }
        if (openIssue || recentlyClosed) {
          severity = Math.max(severity, 2);
          if ((openIssue?.report_count ?? 0) >= 2) severity = 3;
        }
        if (escalating) {
          signalType = 'escalation_language';
          severity = 3;
        }
        if (!openIssue && !recentlyClosed && isCustomer && !escalating) {
          // First-time customer complaint: real, but not an escalation yet.
          severity = Math.max(1, Math.min(severity, 1));
        }

        const fingerprint = `${signalType}:${phone}:${verdict.theme}`;
        const headline = `${isCustomer ? 'Customer' : 'NON-CUSTOMER'} ${phone} — ${verdict.theme.replace('_', ' ')}: ${verdict.customer_intent}`;

        const entry = {
          fingerprint, signal_type: signalType, severity, theme: verdict.theme,
          contact_phone: phone, customer_id: latest.customer_id, is_customer: isCustomer,
          headline,
          existing_issue_id: openIssue?.id ?? null,
          reopens: !openIssue && !!recentlyClosed,
          evidence: {
            message_ids: [...seenIds, ...phoneMsgs.map(m => String(m.id))],
            last_message: latest.body.slice(0, 500),
            last_message_at: latest.at,
            escalation_language: escalating,
          },
          llm_verdict: verdict,
        };
        report.signals.push(entry);

        if (mode !== 'write') continue;

        // ── Persist ───────────────────────────────────────────────────────
        let issueId = openIssue?.id ?? null;

        if (issueId) {
          await dbPatch(`cs_issues?id=eq.${issueId}`, {
            last_reported_at: latest.at,
            report_count: (openIssue.report_count ?? 1) + 1,
            severity: Math.max(openIssue.severity ?? 1, severity),   // never decreases
            theme: verdict.theme,
            updated_at: new Date().toISOString(),
          });
          await dbPost('cs_issue_comments', {
            issue_id: issueId, author: 'cs-signal-scan', comment_type: 'auto_detected',
            body: `Contacted again (${verdict.theme}): "${latest.body.slice(0, 300)}"`,
          }, 'return=minimal');
        } else if (recentlyClosed) {
          // Rule 2: re-contact within 30 days of a close reopens and escalates.
          await dbPatch(`cs_issues?id=eq.${recentlyClosed.id}`, {
            status: 'open', resolved_at: null,
            reopened_count: (recentlyClosed.reopened_count ?? 0) + 1,
            report_count: (recentlyClosed.report_count ?? 1) + 1,
            severity: Math.max(recentlyClosed.severity ?? 1, severity, 2),
            last_reported_at: latest.at,
            updated_at: new Date().toISOString(),
          });
          issueId = recentlyClosed.id;
          await dbPost('cs_issue_comments', {
            issue_id: issueId, author: 'cs-signal-scan', comment_type: 'auto_reopened',
            body: `REOPENED — same contact came back within 30 days of closure: "${latest.body.slice(0, 300)}"`,
          }, 'return=minimal');
        } else {
          const created = await dbPost('cs_issues', {
            title: headline.slice(0, 200),
            theme: verdict.theme, status: 'open', priority: severity >= 3 ? 'high' : severity === 2 ? 'medium' : 'low',
            severity, contact_phone: phone, customer_id: latest.customer_id, is_customer: isCustomer,
            subject_ref: verdict.subject_ref ?? {},
            first_reported_at: phoneMsgs[0].at, last_reported_at: latest.at,
            report_count: 1, created_by: 'cs-signal-scan',
            notes: `Auto-detected. Intent: ${verdict.customer_intent}\nRationale: ${verdict.rationale}\n\nLast message: "${latest.body.slice(0, 500)}"`,
          });
          issueId = created?.[0]?.id ?? null;
        }

        // Upsert the signal by fingerprint; carry it across runs.
        const existing = await dbGet(`cs_signals?select=id,severity,status&fingerprint=eq.${encodeURIComponent(fingerprint)}&limit=1`);
        if (existing.length) {
          const prev = existing[0];
          const patch: any = {
            last_seen_at: new Date().toISOString(),
            severity: Math.max(prev.severity ?? 1, severity),
            headline, evidence: entry.evidence, llm_verdict: verdict, issue_id: issueId,
            updated_at: new Date().toISOString(),
          };
          // Sticky suppression: a dismissed signal only comes back if it got worse.
          if (prev.status === 'suppressed' && severity <= (prev.severity ?? 1)) {
            delete patch.severity;
          } else if (prev.status === 'suppressed') {
            patch.status = 'open';
          }
          await dbPatch(`cs_signals?id=eq.${prev.id}`, patch);
        } else {
          await dbPost('cs_signals', {
            fingerprint, signal_type: signalType, severity, status: 'open',
            contact_phone: phone, customer_id: latest.customer_id, issue_id: issueId,
            theme: verdict.theme, headline, evidence: entry.evidence, llm_verdict: verdict,
          }, 'return=minimal');
        }
      } catch (e) {
        report.errors.push({ phone, error: String(e) });
      }
    }

    report.signals.sort((a: any, b: any) => b.severity - a.severity);
    report.summary = {
      total: report.signals.length,
      severity_3: report.signals.filter((s: any) => s.severity === 3).length,
      severity_2: report.signals.filter((s: any) => s.severity === 2).length,
      non_customer: report.signals.filter((s: any) => !s.is_customer).length,
    };

    return new Response(JSON.stringify(report, null, 2), { headers: CORS });
  } catch (e) {
    console.error('[cs-signal-scan] fatal', e);
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: CORS });
  }
});
