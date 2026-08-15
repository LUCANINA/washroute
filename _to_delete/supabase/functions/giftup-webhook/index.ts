// giftup-webhook (session 141 pt 13, v9 — production)
//
// Receives webhook events from Gift Up! and turns them into rows in the
// WashRoute `discounts` table so the recipient can enter the gift card code
// in the customer app and have it land as account credit (existing
// redeem_discount_code RPC takes it from there).
//
// Confirmed Gift Up specifics from live testing:
//   * header: x-request-signature-sha-256: t=<ms>,sha256=<hex>
//   * signed payload: raw_body + t   (body concatenated with timestamp at the end)
//   * secret: used as raw string (NOT base64-decoded)
//   * event names: 'giftcardcreated' / 'giftcardupdated' / 'giftcardrefunded' / 'giftcardvoided'
//                  (one word, no dot — keep dotted variants accepted too for safety)
//
// Env required:
//   GIFTUP_WEBHOOK_SECRET     - shared secret set when creating webhooks in Gift Up
//   SUPABASE_URL              - automatic
//   SUPABASE_SERVICE_ROLE_KEY - automatic
//
// verify_jwt is false because Gift Up does not send a Supabase JWT;
// we authenticate the request via HMAC signature instead.

import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const SUPA_URL = Deno.env.get('SUPABASE_URL')!
const SUPA_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const SECRET   = Deno.env.get('GIFTUP_WEBHOOK_SECRET') || ''

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-request-signature-sha-256',
}

function safeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let r = 0
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return r === 0
}

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('')
}

function parseSignatureHeader(headerVal: string): { t: string | null; sig: string | null } {
  let t: string | null = null, sig: string | null = null
  for (const p of headerVal.split(',')) {
    const trimmed = p.trim()
    if (trimmed.startsWith('t=')) t = trimmed.slice(2)
    else if (trimmed.startsWith('sha256=')) sig = trimmed.slice('sha256='.length)
  }
  return { t, sig }
}

async function verifySignature(req: Request, body: string): Promise<{ ok: boolean; details: any }> {
  if (!SECRET) return { ok: false, details: { reason: 'no_secret_env' } }
  const headerVal = req.headers.get('x-request-signature-sha-256')
    || req.headers.get('X-Request-Signature-Sha-256')
  if (!headerVal) return { ok: false, details: { reason: 'no_sig_header' } }
  const { t, sig: providedSig } = parseSignatureHeader(headerVal)
  if (!t || !providedSig) return { ok: false, details: { reason: 'malformed_sig_header' } }

  // Confirmed Gift Up format: HMAC-SHA256(secret, body + t)
  const expected = providedSig.toLowerCase()
  const computed = await hmacHex(SECRET, `${body}${t}`)
  if (safeEq(computed, expected)) return { ok: true, details: { t } }
  return {
    ok: false,
    details: {
      reason: 'no_match',
      sig_received_first16: providedSig.slice(0, 16),
      sig_expected_first16: computed.slice(0, 16),
    },
  }
}

function parsePayload(payload: any) {
  // Normalise event name: strip dots/underscores so both 'giftcard.created'
  // and 'giftcardcreated' map to the same canonical key.
  const rawEvent = String(payload?.event || payload?.type || payload?.eventType || '').toLowerCase()
  const event = rawEvent.replace(/[._-]/g, '')
  const card  = payload?.giftCard || payload?.gift_card || payload?.data || payload
  const code  = card?.code || card?.giftCardCode || card?.id || null
  const valueRaw = card?.initialValue ?? card?.amount ?? card?.value ?? card?.originalValue ?? null
  const value = valueRaw == null ? null : Number(valueRaw)
  const status = String(card?.status ?? card?.state ?? '').toLowerCase() || null
  const refundedAt = card?.refundedAt || card?.refunded_at || card?.voidedAt || card?.cancelledAt || null
  return {
    event,
    code: code ? String(code).trim() : null,
    value,
    status,
    refundedAt: refundedAt ? String(refundedAt) : null,
    raw: payload,
  }
}

const DEAD_STATUSES = new Set(['refunded','voided','cancelled','canceled','expired','inactive','disabled'])

async function archiveDiscountByCode(db: any, code: string) {
  const { data: existing } = await db.from('discounts').select('id, active').eq('name', code).maybeSingle()
  if (!existing) return { ok: true, not_found: true }
  if (!existing.active) return { ok: true, already_archived: true, discount_id: existing.id }
  const { error } = await db.from('discounts').update({
    active: false, deleted_at: new Date().toISOString(),
  }).eq('id', existing.id)
  if (error) throw new Error(error.message)
  return { ok: true, archived: existing.id }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST')    return new Response('method not allowed', { status: 405, headers: CORS })

  const rawBody = await req.text()

  let body: any
  try { body = JSON.parse(rawBody) }
  catch { return new Response(JSON.stringify({ error: 'invalid json' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } }) }

  if (body && body.test === true) {
    return new Response(JSON.stringify({ ok: true, test: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  const v = await verifySignature(req, rawBody)
  if (!v.ok) {
    console.warn('[giftup-webhook] SIG FAIL details=', JSON.stringify(v.details))
    return new Response(JSON.stringify({ error: 'invalid signature', diag: v.details }), {
      status: 401, headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }

  const { event, code, value, status, refundedAt, raw } = parsePayload(body)
  console.log('[giftup-webhook] event:', event, 'code:', code, 'value:', value, 'status:', status)

  const db = createClient(SUPA_URL, SUPA_KEY)

  try {
    // Event names are normalised — dotted variants strip to one word.
    if (event === 'giftcardcreated' || event === 'ordercreated') {
      if (!code || !value || value <= 0) {
        console.warn('[giftup-webhook] missing code/value on created event', raw)
        return new Response(JSON.stringify({ ok: false, reason: 'missing_code_or_value' }), {
          status: 200, headers: { ...CORS, 'Content-Type': 'application/json' },
        })
      }
      const { data: existing } = await db.from('discounts').select('id').eq('name', code).maybeSingle()
      if (existing) {
        return new Response(JSON.stringify({ ok: true, idempotent: true, discount_id: existing.id }), {
          headers: { ...CORS, 'Content-Type': 'application/json' },
        })
      }
      const { data: created, error } = await db.from('discounts').insert({
        name: code, type: 'fixed', value: value, active: true,
      }).select('id').single()
      if (error) throw new Error(error.message)
      console.log('[giftup-webhook] created discount', created?.id, 'for code', code, 'value', value)
      return new Response(JSON.stringify({ ok: true, discount_id: created?.id }), {
        headers: { ...CORS, 'Content-Type': 'application/json' },
      })
    }

    if (event === 'giftcardrefunded' || event === 'giftcardvoided' || event === 'orderrefunded') {
      if (!code) return new Response(JSON.stringify({ ok: false, reason: 'missing_code' }), {
        status: 200, headers: { ...CORS, 'Content-Type': 'application/json' },
      })
      const result = await archiveDiscountByCode(db, code)
      return new Response(JSON.stringify(result), { headers: { ...CORS, 'Content-Type': 'application/json' } })
    }

    if (event === 'giftcardupdated') {
      if (!code) return new Response(JSON.stringify({ ok: true, reason: 'missing_code' }), {
        status: 200, headers: { ...CORS, 'Content-Type': 'application/json' },
      })
      const isDead = (status && DEAD_STATUSES.has(status)) || !!refundedAt
      if (!isDead) return new Response(JSON.stringify({ ok: true, noop: true, status }), {
        headers: { ...CORS, 'Content-Type': 'application/json' },
      })
      const result = await archiveDiscountByCode(db, code)
      return new Response(JSON.stringify({ ...result, archived_due_to: status || 'refundedAt timestamp' }), {
        headers: { ...CORS, 'Content-Type': 'application/json' },
      })
    }

    console.log('[giftup-webhook] no-op event:', event)
    return new Response(JSON.stringify({ ok: true, noop: true, event }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    })

  } catch (err: any) {
    console.error('[giftup-webhook] handler error:', err?.message || err)
    return new Response(JSON.stringify({ error: err?.message || String(err) }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
    })
  }
})
