-- Session 299 (2026-09-17): shared website + app content (FAQ, business info).
--
-- * faq_topics / faq_items: FAQ shown on familylaundry.com and in the customer app.
--   Answers may contain live tokens ({price:Wash & Fold}, {fee:Delivery Fee},
--   {plan:price}, {referral:friend}, {site:phone}, {zones:cities} …) that the
--   website renderer / app fill from site_public_values() — never typed numbers.
-- * site_info: key/value business details (phone, email, addresses, hours).
-- * Everyone (anon included) can READ — this is public website content.
--   Only admin/manager can write (RLS).
-- * site_public_values(): SECURITY DEFINER, anon-callable, returns ONLY public
--   price-list values + site_info + service-area city names. No customer data.
-- * Nothing here sends a message.
--
-- Rollback:
--   DROP FUNCTION public.site_public_values();
--   DROP TABLE public.faq_items; DROP TABLE public.faq_topics; DROP TABLE public.site_info;
--   DROP FUNCTION public.is_content_editor();

CREATE OR REPLACE FUNCTION public.is_content_editor()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role IN ('admin','manager'));
$function$;
REVOKE EXECUTE ON FUNCTION public.is_content_editor() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.is_content_editor() FROM anon;
GRANT  EXECUTE ON FUNCTION public.is_content_editor() TO authenticated, service_role;

CREATE TABLE public.faq_topics (
  id          bigserial   PRIMARY KEY,
  slug        text        NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{1,40}$'),
  name        text        NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  sort_order  integer     NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.faq_items (
  id           bigserial   PRIMARY KEY,
  topic_id     bigint      NOT NULL REFERENCES public.faq_topics(id) ON DELETE RESTRICT,
  question     text        NOT NULL CHECK (length(question) BETWEEN 1 AND 200),
  answer       text        NOT NULL CHECK (length(answer) BETWEEN 1 AND 5000),
  audience     text        NOT NULL DEFAULT 'everyone' CHECK (audience IN ('everyone','residential','commercial')),
  show_on_web  boolean     NOT NULL DEFAULT true,
  show_in_app  boolean     NOT NULL DEFAULT true,
  sort_order   integer     NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   text
);
CREATE INDEX faq_items_topic_idx ON public.faq_items (topic_id, sort_order);

CREATE TABLE public.site_info (
  key         text        PRIMARY KEY CHECK (key ~ '^[a-z0-9_]{1,40}$'),
  label       text        NOT NULL,
  value       text        NOT NULL DEFAULT '' CHECK (length(value) <= 2000),
  sort_order  integer     NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  text
);

ALTER TABLE public.faq_topics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.faq_items  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.site_info  ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON public.faq_topics, public.faq_items, public.site_info TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.faq_topics, public.faq_items, public.site_info TO authenticated;
GRANT ALL ON public.faq_topics, public.faq_items, public.site_info TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.faq_topics_id_seq, public.faq_items_id_seq TO authenticated, service_role;

CREATE POLICY faq_topics_read ON public.faq_topics FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY faq_items_read  ON public.faq_items  FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY site_info_read  ON public.site_info  FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY faq_topics_write ON public.faq_topics FOR ALL TO authenticated USING (public.is_content_editor()) WITH CHECK (public.is_content_editor());
CREATE POLICY faq_items_write  ON public.faq_items  FOR ALL TO authenticated USING (public.is_content_editor()) WITH CHECK (public.is_content_editor());
CREATE POLICY site_info_write  ON public.site_info  FOR ALL TO authenticated USING (public.is_content_editor()) WITH CHECK (public.is_content_editor());

-- Live public values for tokens. Delivery price list = residential web prices.
CREATE OR REPLACE FUNCTION public.site_public_values()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT jsonb_build_object(
    'price', COALESCE((SELECT jsonb_object_agg(s.name, jsonb_build_object('amount', s.base_price, 'type', s.pricing_type))
                         FROM public.services s WHERE s.pricelist = 'Delivery' AND s.show_in_app), '{}'::jsonb),
    'retail', COALESCE((SELECT jsonb_object_agg(s.name, jsonb_build_object('amount', s.base_price, 'type', s.pricing_type))
                         FROM public.services s WHERE s.pricelist = 'Retail'), '{}'::jsonb),
    'fee', COALESCE((SELECT jsonb_object_agg(DISTINCT_f.name, DISTINCT_f.amount)
                       FROM (SELECT DISTINCT ON (f.name) f.name, f.amount
                               FROM public.service_fees f
                              WHERE f.show_in_app AND (f.pricelist IS NULL OR f.pricelist = 'Delivery')
                              ORDER BY f.name, (f.pricelist IS NULL)) DISTINCT_f), '{}'::jsonb),
    'plan', COALESCE((SELECT jsonb_build_object('name', p.name, 'price', p.price_monthly, 'lbs', p.weight_limit_lbs,
                                                'overage', p.overage_price_per_lb)
                        FROM public.subscription_plans p WHERE p.is_active ORDER BY p.price_monthly LIMIT 1), '{}'::jsonb),
    'referral', (SELECT jsonb_build_object('enabled', COALESCE((c->>'enabled')::boolean, false),
                                           'friend', c->'friend_credit', 'referrer', c->'referrer_credit')
                   FROM (SELECT public.referral_config() AS c) x),
    'site', COALESCE((SELECT jsonb_object_agg(i.key, i.value) FROM public.site_info i), '{}'::jsonb),
    'cities', COALESCE((SELECT jsonb_agg(DISTINCT initcap(c) ORDER BY initcap(c))
                          FROM public.service_zones z
                          CROSS JOIN LATERAL unnest(CASE WHEN cardinality(z.cities) > 0 THEN z.cities ELSE ARRAY[z.name] END) c
                         WHERE z.polygon IS NOT NULL AND z.name <> 'Commercial'), '[]'::jsonb)
  );
$function$;
REVOKE EXECUTE ON FUNCTION public.site_public_values() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.site_public_values() TO anon, authenticated, service_role;

-- ── Seed ────────────────────────────────────────────────────────────────
INSERT INTO public.site_info (key, label, value, sort_order) VALUES
 ('phone',            'Customer phone',        '(510) 842-3560', 10),
 ('email',            'Customer email',        'info@familylaundry.com', 20),
 ('office_address',   'Office address',        '5215 Genoa St, Oakland CA 94608', 30),
 ('dropoff_address',  'Drop-off location',     '2609 Foothill Blvd, Oakland', 40),
 ('dropoff_hours',    'Drop-off hours',        '7 am – 10 pm, 7 days a week', 50),
 ('dropoff_cutoff',   'Same-day drop-off cutoff', 'Drop off before 10 am for same-day pickup, after 10 am for next-day.', 60),
 ('founded',          'Founded',               '2019', 70),
 ('app_ios_url',      'iOS app link',          '', 80),
 ('app_android_url',  'Android app link',      '', 90),
 ('giftcard_url',     'Gift card link',        'https://www.familylaundry.com/gifts-cards', 100);

INSERT INTO public.faq_topics (slug, name, sort_order) VALUES
 ('pickup-delivery', 'Pickup & Delivery', 10),
 ('cleaning',        'Cleaning',          20),
 ('general',         'General',           30);

WITH t AS (SELECT id, slug FROM public.faq_topics)
INSERT INTO public.faq_items (topic_id, sort_order, audience, show_on_web, show_in_app, question, answer, updated_by)
SELECT t.id, v.ord, v.aud, v.web, v.app, v.q, v.a, 'seed (session 299, from familylaundry.com/faq)'
FROM (VALUES
 ('pickup-delivery', 10, 'everyone', true, true, 'What cities do you serve?',
  $a$We serve {zones:cities}. [See the service map](/service-map) to check your address.$a$),
 ('pickup-delivery', 20, 'residential', true, true, 'Do you have a minimum per order?',
  $a$The minimum is one bag at {price:Wash & Fold} (up to 25 lbs) plus a {fee:Delivery Fee} delivery fee.

Each bag fits about 25 lbs of laundry, 3 standard pillows, 3 standard blankets, or 2 standard duvets.$a$),
 ('pickup-delivery', 30, 'everyone', true, true, 'Do I have to be home for pickup or delivery?',
  $a$No. Leave your bag(s) on your doorstep or porch, and tell us where in your delivery instructions.

Please note there is a {fee:Missed Pickup Fee} missed pickup/delivery fee.$a$),
 ('pickup-delivery', 40, 'residential', true, true, 'Will you provide a laundry bag before my first pickup?',
  $a$No. For your first pickup, please put your laundry in sealed trash bags. We return your clean laundry in Family Laundry bags that are yours to keep for your next order.

Our bags hold about 2 tall kitchen bags (or one large black trash bag).$a$),
 ('pickup-delivery', 50, 'everyone', true, true, 'How do I schedule a laundry pickup?',
  $a$In the Family Laundry app, or on the web at [app.familylaundry.com](https://app.familylaundry.com). Regular customers can also text **PICKUP** to {site:phone}.

Prefer a human? Call {site:phone}. Leave a message and we'll call you back the same day.$a$),
 ('pickup-delivery', 60, 'everyone', true, true, 'How do I skip or cancel a pickup?',
  $a$Reply **SKIP** to our text, or cancel it in the app.

Please don't text CANCEL or STOP: those words unsubscribe you from all our texts.$a$),
 ('pickup-delivery', 70, 'everyone', true, true, 'What pickup times are available?',
  $a$Morning, midday and evening windows, depending on your area. You can book a window up to 60 minutes before it ends.$a$),
 ('pickup-delivery', 80, 'everyone', true, true, 'What is the turnaround time?',
  $a$Most orders come back the next day. Same-day delivery is available in most areas for an extra {fee:Same-Day Surcharge}.$a$),
 ('pickup-delivery', 90, 'residential', true, true, 'What does delivery cost?',
  $a${fee:Delivery Fee} per order. Delivery is free for subscribers.$a$),

 ('cleaning', 10, 'everyone', true, true, 'What cleaning products do you use?',
  $a$Free & Clear hypoallergenic detergents, white vinegar and Oxi. We never use bleach, fragrances or softeners.$a$),
 ('cleaning', 20, 'everyone', true, true, 'Who actually does my laundry?',
  $a$We do, every step of the way. Everyone who touches your laundry is a Family Laundry employee. Our trained launderers work in our own facilities, and our drivers use our own delivery vehicles. We never outsource.$a$),
 ('cleaning', 30, 'residential', true, true, 'Do you offer Air Dry for delicates?',
  $a$Yes, Air Dry is {price:Air Dry} per delicates bag. Choose **Air Dry** when you book, and put your delicates in a separate bag. We'll give you a reusable 15"×19" delicates bag at no extra cost.$a$),
 ('cleaning', 40, 'everyone', true, true, 'Can you clean dog bedding, large comforters and sleeping bags?',
  $a$Yes. We have big machines for larger items. If it fits in a Family Laundry bag, we'll wash it.$a$),
 ('cleaning', 50, 'everyone', true, true, 'Do you offer dry cleaning?',
  $a$No. Our specialty is wash & fold. We use only water and hypoallergenic detergents.$a$),
 ('cleaning', 60, 'residential', true, true, 'Do you bleach whites?',
  $a$No, we never use chlorine bleach. We offer bleach alternatives instead: Vinegar ({price:Vinegar} per bag) and Oxi ({price:Oxi} per bag).$a$),
 ('cleaning', 70, 'everyone', true, true, 'Why Free and Clear only?',
  $a$Many popular detergents contain chemicals such as phthalates, used to make scents last. They have been linked to skin irritation, and we'd rather keep them away from our customers, our team and the environment.

Less junk in our laundry = less junk in nature.$a$),
 ('cleaning', 80, 'everyone', true, true, 'Do you check clothing labels for laundering instructions?',
  $a$Our standard process is warm water and a medium tumble dry. Please send only machine-washable items, and set aside anything labeled dry clean only or hand wash only.$a$),
 ('cleaning', 90, 'everyone', true, true, 'What can''t you wash?',
  $a$Dry-clean-only and hand-wash-only items, shoes and sneakers, and anything that doesn't fit in a Family Laundry bag.$a$),

 ('general', 10, 'everyone', true, true, 'How can I reach you?',
  $a$Call {site:phone}. If we miss your call, leave a voicemail and we'll call you back as soon as possible. You can also email {site:email} anytime.

Returning customers can reply to our last text.$a$),
 ('general', 20, 'residential', true, true, 'Do you offer Subscription Plans?',
  $a$Yes. For {plan:price}/month you get {plan:lbs} lbs of wash & fold (about 4 bags), unlimited pickups and free next-day delivery.

Usage above {plan:lbs} lbs is {plan:overage}/lb. Same-day delivery is {fee:Same-Day Surcharge}, and add-ons are charged separately. Stop anytime. Subscribe in the app or email {site:email}.$a$),
 ('general', 30, 'residential', true, true, 'Do you have a referral program?',
  $a$Yes. Share your code from **Rewards** in the app. Your friend gets {referral:friend} off their first order, and you get {referral:referrer} once it's paid.$a$),
 ('general', 40, 'everyone', true, true, 'Can I bring my laundry to you?',
  $a$Absolutely! Bring it to {site:dropoff_address}, open {site:dropoff_hours}. {site:dropoff_cutoff} Drop-off wash & fold is {retail:Wash & Fold}.$a$),
 ('general', 50, 'everyone', true, true, 'What happens if an item is lost or damaged?',
  $a$We take great care with every item. In the rare event something is lost or damaged, contact us within 48 hours and we'll make it right.$a$),
 ('general', 60, 'everyone', true, true, 'Can I tip my driver?',
  $a$Yes. Set a default tip in the app under **Preferences**, or change it on any order.$a$),
 ('general', 70, 'everyone', true, true, 'Do you sell gift cards?',
  $a$Yes! [Buy an e-gift card here]({site:giftcard_url}). The recipient just creates a Family Laundry account and the gift card applies to their order.$a$),
 ('general', 80, 'commercial', true, true, 'Will you do laundry for my business?',
  $a$Absolutely! We serve Airbnb hosts, hotels, salons, childcare centers, massage and chiropractic practices, gyms, grocery stores and other local businesses. [Get a quote](/services-4).$a$),
 ('general', 90, 'everyone', true, true, 'Do you serve apartment buildings as a group?',
  $a$Yes, we offer discounts for coordinated pickups in multi-unit buildings. Email {site:email} to set it up with your neighbors.$a$),
 ('general', 100, 'everyone', true, false, 'How do I download the Family Laundry app?',
  $a$Get the Family Laundry app for iOS or Android, or use it on the web at [app.familylaundry.com](https://app.familylaundry.com). Schedule pickups, track orders and manage your account.$a$),
 ('general', 110, 'everyone', false, false, 'When am I charged?',
  $a$DRAFT — confirm timing before publishing. To the card on file once your order is processed.$a$)
) AS v(topic, ord, aud, web, app, q, a)
JOIN t ON t.slug = v.topic;
