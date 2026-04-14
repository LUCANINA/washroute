-- Session 111: Subscription Phase 2 — idempotency + fast lookup
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS last_stripe_event_at TIMESTAMPTZ;

-- Index for fast lookup by stripe_subscription_id (used by webhook handlers)
CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_sub_id ON subscriptions(stripe_subscription_id) WHERE stripe_subscription_id IS NOT NULL;
