# AI phone assistant ("Maya") — replaces voicemail

Status: phase 1 built 2026-10-09 — Maya exists in Retell and is testable from the Retell
dashboard. NOT connected to the live phone number yet. Decisions from David, 2026-10-09.

## Where things live
- Edge function `maya` (`supabase/functions/maya/index.ts`), deployed v1, **verify_jwt = false**
  (Retell can't send a JWT; every route checks its own credential). Redeploy with
  `--no-verify-jwt`.
- Retell: agent `agent_444dd14ce8fe402200d3d1610d`, LLM `llm_21a26e321c9382d35bdb41ec8721`.
  Prompt, greeting, tools and post-call fields are defined in the function — change them there and
  re-run setup, not in the Retell dashboard (setup overwrites dashboard edits).
- Secrets: `RETELL_API_KEY` (Supabase). The tool token is derived from it. The admin token is in
  `maya-admin.key` at the repo root (git-ignored); the function stores only its SHA-256.
- Re-run setup / change voice:
  `curl -X POST -H "x-maya-admin: $(cat maya-admin.key)" -H 'Content-Type: application/json' -d '{"voice_id":"cartesia-Nancy"}' https://umjpbuxrdydwejqtensq.supabase.co/functions/v1/maya/setup`
- Facts come live from `site_public_values()` + `faq_items` + `holidays` on every call (no typed
  prices). DRAFT FAQ answers are skipped.
- Each call → one inbound `sms_messages` row, body `📞 Call with Maya (m:ss)` / flags / caller /
  summary / `▶ recording`; `twilio_sid` = Retell call_id (dedupe). Recording copied to the
  `voicemails` bucket under `maya/`. Admin `renderMessageBubble` renders these like voicemails.
- Test phone number (Retell, $2/mo, bought by David 2026-10-09): **+1 (510) 973-4505** → inbound agent Maya. Not the business line.
- Web test calls have no caller ID: row uses the callback number the caller gave, else `maya-web-call`.

## Phase 2 — built 2026-10-09 (maya v4)
- Retell number → inbound webhook `/maya/inbound` (set by setup's wireNumbers). Caller ID →
  `find_customer_by_phone` → known, non-cancelled customer is greeted "Hi <first name>" (per-call
  begin_message override) and `{{caller_context}}` says "matches… Not verified yet."
- Account details only via `lookup_my_account` AFTER the caller says their pickup street name
  (house numbers/street types ignored, 1-letter STT slip allowed on 5+ letter words). Phone comes from
  Retell's signed call object, never from the model. Returns open orders (scheduled/processing/ready/
  failed/on hold) + last completed order (later of orders and customers.last_order_at). Read-only.
- Unsigned inbound/tool requests return no customer data. Caller ID can be spoofed — hence the street check.
- Post-call summary uses the name on file for known callers.

## Phase 3 — phone booking (built 2026-10-09, TEST MODE: `BOOKING_LIVE = false` in maya/index.ts)
Decisions (David, 2026-10-09): book one-time pickups for known AND new callers, skip, reschedule,
same-day where available; Maya asks new callers for text consent; normal 'confirmed' text after booking;
**no-card orders follow the same process as app bookings with no card** (NO CARD in Issues + the usual
payment_failed text if texts are on) — the "collect card hold" was built then dropped; charge-order unchanged.
`customers.card_needed_since` (migration maya_phase3_card_needed_since) was applied and is now UNUSED.
- Engine: `maya/booking.ts` — port of twilio-webhook PICKUP: get_slot_availability (capacity + route
  override), booking cutoff, holidays, delivery on next route day; same-day = customer-app rule
  (turnaround_hours, same-day later window). Insert identical to SMS PICKUP (source 'scheduled', $0,
  priced at intake — intake adds delivery + same-day fees). Move to `_shared/` when twilio-webhook adopts it.
- Tools: find_pickup_times, check_new_address (server geocode GOOGLE_MAPS_API_KEY + get_zone_for_point,
  HMAC-signed address_token, duplicate-address check), book_pickup, skip_pickup, reschedule_pickup.
  Every account action re-verifies the street; every write needs caller_confirmed=true after a read-back
  (first call returns the summary). Reschedule = book new, then skip old (cancel new if skip fails).
- New callers: customers row (no login), phone from caller ID, sms_consent_at only with their yes,
  otherwise sms_notifications_opt_out_at; sms_marketing_opt_out_at always (never agreed to marketing);
  notes "Signed up by phone with Maya…". Address row is_default. Rollback on failure.
- Script decisions (David, 2026-10-09, FAQ review): price ESTIMATE in the read-back (bags × base + delivery fee by
  price list + same-day; per-lb lists say "priced by weight"; subscribers "covered by plan"); add-ons/wash preferences
  are SAVED TO customers.preferences (David: next orders follow the same choices) — admin intake prices add-ons
  from preferences, not from the order — plus app-style {type:'addon'} lines on the booking; care requests with
  no add-on (wash temperature has no preference group) go to preferences._notes + special_instructions; gently mention the
  missed-pickup fee after booking; payment wording = charged after processing by weight, text link to add a card
  (or staff call if no texts). Bag = ~25 lb, about 2 tall kitchen bags or 1 large black trash bag (FAQ 4).
- Repeat (David, 2026-10-09): Maya asks one-time / weekly / every two weeks / monthly → orders.recurring_interval
  (weekly|biweekly|monthly), same as an app booking; trg_create_recurring_order_fn books the next one after each
  delivery/skip. Reschedule of a recurring pickup books a ONE-TIME replacement and skips the old one (the chain continues).
- `/maya/admin-tool` (admin token) runs any booking tool as a given caller number, always dry-run.

## Before go-live (phase 1b)
- Update FAQ 5 and 19 (website + app): they say "leave a voicemail/message and we'll call you back" — Maya answers now.
- Point the Twilio number at Retell, keeping the old voicemail path as fallback if Retell fails.
- Email info@ on each call needing a callback (the voicemail flow does this today).
- `twilio-voice-webhook` source is NOT in the repo — only the deployed copy exists. Download it first.


## Approach
Buy the voice, build the actions. A hosted voice platform (Retell preferred, Vapi alternative)
answers the existing Twilio number and calls WashRoute edge functions as tools. No home-built
real-time voice stack.

Today: Twilio number -> `twilio-voice-webhook` -> TTS greeting, 2-min recording -> `voicemails`
table + inbox + email to info@. Volume ~100 voicemails/month (Jun–Sep 2026), ~60% from known
customers. Real call volume likely 2–3x (hang-ups leave nothing). Est. cost $50–250/month.

## Persona
- Name: **Maya**, female voice. "Hi, this is Maya at Family Laundry."
- Warm, slightly slower pace than default (many callers are seniors).
- Language switching: answers in English, switches when the caller speaks another language.
  English/Spanish first; test others (Chinese, Vietnamese) before promising them.
- Voice: **cartesia-Nancy** (David, 2026-10-09). Grace felt strident. Most callers are 60+, so lowest pitch wins:
  measured previews Grace 242 Hz / brightness 7.7%, Cleo 219 Hz / 2.2%, Nancy 180 Hz / 5.3%.

## Phases (est. 4–7 sessions)
1. **Answer + summarize** — FAQ (prices, service area, hours); call summary + transcript into the
   inbox where voicemails land today. Keep the old voicemail path as fallback.
2. **Look up** — caller ID -> customer; "your next pickup is Tuesday".
3. **Book** — existing AND new customers (David, 2026-10-09: many customers are seniors and not
   tech savvy, so phone signup is required).
4. **Hand-off** — angry/complex callers to staff (feed the CS-escalation signals).

## Phase 3 rules
- New accounts are phone-only (no login) — normal: 4,428 of 6,287 customers already have none.
- Dedupe first: search phone, name, address before creating. Former customers predate `orders`
  (see CLAUDE.md "Customer order history predates the orders table").
- Address: caller spells street; geocode; check service area; read back; explicit "yes".
- Pickup read back; explicit "yes" before booking. Confirmation SMS (or note "landline").
- **Payment: book now, no card.** Maya never asks for or hears card numbers. Order carries a
  visible "No card on file — call customer" flag; plant staff call to collect before delivery.
- Rack station must show "call customer" for no-card orders, NOT "declined".
- Every phone-created account + first pickup flagged in admin for staff review.
- Before enabling booking: replay real voicemail transcripts against the booking logic
  (CLAUDE.md: widening what inbound means -> replay the corpus first). Run `washroute-preflight`.

## Open
- David to create the voice-platform account (needs his card).
- Which languages beyond Spanish.
