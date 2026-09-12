import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

// referral-notify — session 292
//
// Two outbound messages the referral program needs, both to a person who is NOT
// the customer on the triggering order, which is why notification_queue (keyed by
// order) could not carry them:
//
//   referral_qualified — "your friend ordered, here's your credit"  -> the referrer
//   referral_reminder  — "your $25 is still waiting"                -> the friend
//
// Called by pg_cron through sweep_referral_notifications() with the x-wr-internal
// secret. Sending itself is delegated to send-sms so Twilio credentials, the
// StatusCallback and the sms_messages log all stay in one place.
//
// THREE independent gates stand between this code and a customer's phone:
//   1. settings.referral_config.enabled must be true
//   2. the message_templates row must have sms_enabled = true
//   3. the referral must be in the right state and not already stamped
// Pass { dryRun: true } to see exactly who would be messaged, sending nothing.

const SUPABASE_URL     = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SVC_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const MAX_PER_RUN = 20;   // a referral backlog can never become a broadcast

type Send = { kind: string; customer_id: string; phone: string; body: string; referral_id: string };

async function authorize(req: Request): Promise<boolean> {
  const svc = createClient(SUPABASE_URL, SUPABASE_SVC_KEY);

  // Internal DB caller: pg_cron and SECURITY DEFINER functions cannot present the
  // service-role key, so they send the shared secret instead (session 227h).
  const internal = req.headers.get('x-wr-internal') || '';
  if (internal) {
    const { data } = await svc.from('wr_internal_auth').select('secret').maybeSingle();
    if (data?.secret && internal === data.secret) return true;
  }

  const m = (req.headers.get('Authorization') || '').match(/^Bearer\s+(.+)$/i);
  if (m && m[1] === SUPABASE_SVC_KEY) return true;

  return false;   // no anon key, no user sessions — nothing else should call this
}

function fill(tpl: string, vars: Record<string, string>): string {
  return Object.entries(vars).reduce(
    (out, [k, v]) => out.replaceAll(`{{${k}}}`, v),
    tpl || ''
  );
}

const money = (n: unknown) => {
  const v = Number(n || 0);
  return '$' + (Number.isInteger(v) ? v : v.toFixed(2));
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*' } });
  }

  try {
    if (!await authorize(req)) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { 'Content-Type': 'application/json' },
      });
    }

    let dryRun = false;
    try { dryRun = !!(await req.json())?.dryRun; } catch (_) { /* no body is fine */ }

    const db = createClient(SUPABASE_URL, SUPABASE_SVC_KEY);

    // A dry run also answers the question that cost session 176/177 fifteen hours
    // of broken charging: can the data API actually see these columns? A stale
    // PostgREST schema cache would make the queries below return nothing at all,
    // silently, so the probe reports it instead of failing quietly.
    let schema: unknown = null;
    if (dryRun) {
      const { error } = await db.from('referrals')
        .select('id, friend_reminded_at, referrer_notified_at').limit(1);
      schema = error ? { ok: false, code: error.code, message: error.message } : { ok: true };
    }

    // ── gate 1: the program itself ───────────────────────────────────────
    const { data: cfgRow } = await db.from('settings').select('referral_config').eq('id', 1).maybeSingle();
    const cfg = cfgRow?.referral_config || {};
    if (cfg.enabled !== true) {
      return new Response(JSON.stringify({ ok: true, skipped: 'program_disabled', sent: 0, schema }),
        { headers: { 'Content-Type': 'application/json' } });
    }

    // ── gate 2: the templates ────────────────────────────────────────────
    const { data: tpls } = await db.from('message_templates')
      .select('trigger_key, sms_enabled, sms_body')
      .in('trigger_key', ['referral_qualified', 'referral_reminder']);
    const tpl = Object.fromEntries((tpls || []).map(t => [t.trigger_key, t]));

    const sends: Send[] = [];

    // ── the referrer's "you earned credit" ───────────────────────────────
    if (tpl.referral_qualified?.sms_enabled) {
      const { data: rows } = await db.from('referrals')
        .select('id, referrer_customer_id, referred_customer_id, referrer_credit_amount, referrer_credit_method')
        .eq('status', 'qualified')
        .is('referrer_notified_at', null)
        .limit(MAX_PER_RUN);

      for (const r of rows || []) {
        const { data: ref } = await db.from('customers')
          .select('id, first_name_cache, phone_cache').eq('id', r.referrer_customer_id).maybeSingle();
        const { data: friend } = await db.from('customers')
          .select('first_name_cache').eq('id', r.referred_customer_id).maybeSingle();
        if (!ref?.phone_cache) continue;

        sends.push({
          kind: 'referral_qualified',
          referral_id: r.id,
          customer_id: ref.id,
          phone: ref.phone_cache,
          body: fill(tpl.referral_qualified.sms_body, {
            first_name:   ref.first_name_cache || 'there',
            friend_name:  friend?.first_name_cache || 'your friend',
            amount:       money(r.referrer_credit_amount),
            credit_place: r.referrer_credit_method === 'invoice_adjustment' ? 'your next invoice' : 'your account',
          }),
        });
      }
    }

    // ── the friend's one nudge ───────────────────────────────────────────
    const remindDays = cfg.friend_reminder_days;
    if (tpl.referral_reminder?.sms_enabled && remindDays != null && Number(remindDays) > 0) {
      const cutoff = new Date(Date.now() - Number(remindDays) * 86400000).toISOString();
      const { data: rows } = await db.from('referrals')
        .select('id, referred_customer_id, referrer_customer_id, referred_credit_amount, claimed_at')
        .eq('status', 'claimed')
        .is('friend_reminded_at', null)
        .lt('claimed_at', cutoff)
        .limit(MAX_PER_RUN);

      for (const r of rows || []) {
        // Still no order at all? Then the credit really is sitting unused.
        const { count } = await db.from('orders')
          .select('id', { count: 'exact', head: true })
          .eq('customer_id', r.referred_customer_id);
        if ((count || 0) > 0) continue;

        const { data: friend } = await db.from('customers')
          .select('id, first_name_cache, phone_cache').eq('id', r.referred_customer_id).maybeSingle();
        const { data: ref } = await db.from('customers')
          .select('first_name_cache').eq('id', r.referrer_customer_id).maybeSingle();
        if (!friend?.phone_cache) continue;

        sends.push({
          kind: 'referral_reminder',
          referral_id: r.id,
          customer_id: friend.id,
          phone: friend.phone_cache,
          body: fill(tpl.referral_reminder.sms_body, {
            first_name:    friend.first_name_cache || 'there',
            referrer_name: ref?.first_name_cache || 'a friend',
            amount:        money(r.referred_credit_amount),
          }),
        });
      }
    }

    if (dryRun) {
      return new Response(JSON.stringify({ ok: true, dryRun: true, would_send: sends.length, schema, sends }),
        { headers: { 'Content-Type': 'application/json' } });
    }

    // ── send, then stamp — one at a time, so a failure costs one message ──
    let sent = 0;
    const failures: unknown[] = [];

    for (const s of sends) {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/send-sms`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${SUPABASE_SVC_KEY}`,
          'apikey': SUPABASE_SVC_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ to: s.phone, body: s.body, customer_id: s.customer_id }),
      });

      if (!res.ok) {
        failures.push({ referral_id: s.referral_id, kind: s.kind, status: res.status, detail: await res.text() });
        continue;   // leave it unstamped so the next run retries
      }

      const stamp = s.kind === 'referral_qualified'
        ? { referrer_notified_at: new Date().toISOString() }
        : { friend_reminded_at:   new Date().toISOString() };
      await db.from('referrals').update(stamp).eq('id', s.referral_id);
      sent++;
    }

    if (failures.length) {
      await db.from('_health_alerts').insert({
        alert_type: 'referral_notify_failed',
        severity: 'warning',
        message: `${failures.length} referral notification(s) failed to send`,
        context: { failures },
      });
    }

    return new Response(JSON.stringify({ ok: true, sent, failed: failures.length }),
      { headers: { 'Content-Type': 'application/json' } });

  } catch (err) {
    console.error('referral-notify error:', err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
});
