-- ============================================================
--  WashRoute — Full Database Schema
--  Run this in: Supabase → SQL Editor → New Query → Run
-- ============================================================

-- Extensions
create extension if not exists "uuid-ossp";

-- ────────────────────────────────────────────────────────────
--  PROFILES
--  Extends Supabase auth.users for all user types
-- ────────────────────────────────────────────────────────────
create table profiles (
  id          uuid references auth.users on delete cascade primary key,
  role        text not null default 'customer'
                check (role in ('customer', 'driver', 'admin')),
  first_name  text,
  last_name   text,
  phone       text,
  email       text,
  avatar_url  text,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

-- ────────────────────────────────────────────────────────────
--  CUSTOMERS
-- ────────────────────────────────────────────────────────────
create table customers (
  id                  uuid primary key default uuid_generate_v4(),
  profile_id          uuid references profiles(id) on delete cascade,
  stripe_customer_id  text unique,
  notes               text,
  preferences         jsonb default '{}',
  -- e.g. {"detergent": "unscented", "folding": "standard", "dryer_heat": "low"}
  is_retail           boolean default false,
  lifetime_value      numeric(10,2) default 0,
  total_orders        integer default 0,
  last_order_at       timestamptz,
  risk_status         text default 'active'
                        check (risk_status in ('active', 'at_risk', 'churned')),
  created_at          timestamptz default now(),
  updated_at          timestamptz default now()
);

-- ────────────────────────────────────────────────────────────
--  ADDRESSES
-- ────────────────────────────────────────────────────────────
create table addresses (
  id                    uuid primary key default uuid_generate_v4(),
  customer_id           uuid references customers(id) on delete cascade,
  label                 text,  -- 'Home', 'Work', etc.
  line1                 text not null,
  line2                 text,
  city                  text not null,
  state                 text not null,
  zip                   text not null,
  lat                   numeric(10,7),
  lng                   numeric(10,7),
  is_default            boolean default false,
  delivery_instructions text,
  created_at            timestamptz default now()
);

-- ────────────────────────────────────────────────────────────
--  DRIVERS
-- ────────────────────────────────────────────────────────────
create table drivers (
  id                    uuid primary key default uuid_generate_v4(),
  profile_id            uuid references profiles(id) on delete cascade,
  vehicle_type          text,
  vehicle_plate         text,
  is_active             boolean default true,
  current_lat           numeric(10,7),
  current_lng           numeric(10,7),
  last_location_update  timestamptz,
  created_at            timestamptz default now(),
  updated_at            timestamptz default now()
);

-- ────────────────────────────────────────────────────────────
--  SERVICES  (Wash & Fold, Shirt Service, etc.)
-- ────────────────────────────────────────────────────────────
create table services (
  id            uuid primary key default uuid_generate_v4(),
  name          text not null,
  description   text,
  pricing_type  text not null
                  check (pricing_type in ('per_lb', 'per_item', 'flat')),
  base_price    numeric(8,2) not null,
  is_active     boolean default true,
  sort_order    integer default 0,
  created_at    timestamptz default now()
);

-- ────────────────────────────────────────────────────────────
--  SUBSCRIPTION PLANS
-- ────────────────────────────────────────────────────────────
create table subscription_plans (
  id                uuid primary key default uuid_generate_v4(),
  name              text not null,
  description       text,
  price_monthly     numeric(8,2) not null,
  stripe_price_id   text unique,
  pickup_limit      integer,  -- null = unlimited
  features          jsonb default '[]',
  is_active         boolean default true,
  created_at        timestamptz default now()
);

-- ────────────────────────────────────────────────────────────
--  SUBSCRIPTIONS  (one per customer)
-- ────────────────────────────────────────────────────────────
create table subscriptions (
  id                      uuid primary key default uuid_generate_v4(),
  customer_id             uuid references customers(id) on delete cascade,
  plan_id                 uuid references subscription_plans(id),
  stripe_subscription_id  text unique,
  status                  text default 'active'
                            check (status in ('active', 'paused', 'cancelled', 'past_due')),
  current_period_start    timestamptz,
  current_period_end      timestamptz,
  preferred_pickup_day    text,    -- 'monday', 'tuesday', etc.
  preferred_pickup_window text,    -- '8am-10am', '10am-12pm', etc.
  created_at              timestamptz default now(),
  updated_at              timestamptz default now()
);

-- ────────────────────────────────────────────────────────────
--  ORDERS
-- ────────────────────────────────────────────────────────────
create table orders (
  id                        uuid primary key default uuid_generate_v4(),
  order_number              bigint generated always as identity,
  customer_id               uuid references customers(id),
  subscription_id           uuid references subscriptions(id),
  pickup_address_id         uuid references addresses(id),
  delivery_address_id       uuid references addresses(id),
  status                    text default 'pending_pickup'
                              check (status in (
                                'pending_pickup',
                                'picked_up',
                                'processing',
                                'ready',
                                'out_for_delivery',
                                'delivered',
                                'cancelled'
                              )),
  pickup_window_start       timestamptz,
  pickup_window_end         timestamptz,
  delivery_window_start     timestamptz,
  delivery_window_end       timestamptz,
  actual_pickup_at          timestamptz,
  actual_delivery_at        timestamptz,
  weight_lbs                numeric(6,2),
  special_instructions      text,
  stripe_payment_intent_id  text,
  total_amount              numeric(8,2) default 0,
  is_subscription_order     boolean default false,
  driver_rating             integer check (driver_rating between 1 and 5),
  rating_comment            text,
  created_at                timestamptz default now(),
  updated_at                timestamptz default now()
);

-- ────────────────────────────────────────────────────────────
--  ORDER ITEMS
-- ────────────────────────────────────────────────────────────
create table order_items (
  id           uuid primary key default uuid_generate_v4(),
  order_id     uuid references orders(id) on delete cascade,
  service_id   uuid references services(id),
  quantity     numeric(8,2) not null,  -- lbs for weight-based, count for per-item
  unit_price   numeric(8,2) not null,
  total_price  numeric(8,2) not null,
  notes        text,
  created_at   timestamptz default now()
);

-- ────────────────────────────────────────────────────────────
--  ROUTES
-- ────────────────────────────────────────────────────────────
create table routes (
  id                      uuid primary key default uuid_generate_v4(),
  name                    text not null,
  driver_id               uuid references drivers(id),
  date                    date not null,
  status                  text default 'scheduled'
                            check (status in ('scheduled', 'in_progress', 'complete', 'cancelled')),
  started_at              timestamptz,
  completed_at            timestamptz,
  estimated_duration_mins integer,
  total_stops             integer default 0,
  completed_stops         integer default 0,
  optimized_stop_order    jsonb,  -- array of route_stop IDs in optimized sequence
  created_at              timestamptz default now(),
  updated_at              timestamptz default now()
);

-- ────────────────────────────────────────────────────────────
--  ROUTE STOPS
-- ────────────────────────────────────────────────────────────
create table route_stops (
  id                 uuid primary key default uuid_generate_v4(),
  route_id           uuid references routes(id) on delete cascade,
  order_id           uuid references orders(id),
  stop_type          text not null check (stop_type in ('pickup', 'delivery')),
  stop_number        integer not null,  -- sequence position in route
  address_id         uuid references addresses(id),
  status             text default 'pending'
                       check (status in ('pending', 'en_route', 'complete', 'skipped')),
  estimated_arrival  timestamptz,
  actual_arrival     timestamptz,
  completed_at       timestamptz,
  driver_notes       text,
  photo_url          text,
  created_at         timestamptz default now(),
  updated_at         timestamptz default now()
);

-- ────────────────────────────────────────────────────────────
--  CONVERSATIONS  (unified inbox — SMS + email)
-- ────────────────────────────────────────────────────────────
create table conversations (
  id                      uuid primary key default uuid_generate_v4(),
  customer_id             uuid references customers(id),
  channel                 text not null check (channel in ('sms', 'email')),
  status                  text default 'open'
                            check (status in ('open', 'resolved', 'spam')),
  assigned_to             uuid references profiles(id),
  subject                 text,  -- email subject line
  last_message_at         timestamptz,
  twilio_conversation_sid text,
  created_at              timestamptz default now(),
  updated_at              timestamptz default now()
);

-- ────────────────────────────────────────────────────────────
--  MESSAGES
-- ────────────────────────────────────────────────────────────
create table messages (
  id                  uuid primary key default uuid_generate_v4(),
  conversation_id     uuid references conversations(id) on delete cascade,
  direction           text not null check (direction in ('inbound', 'outbound')),
  body                text not null,
  sent_by             uuid references profiles(id),  -- null = inbound from customer
  sent_at             timestamptz default now(),
  read_at             timestamptz,
  twilio_message_sid  text,
  created_at          timestamptz default now()
);

-- ────────────────────────────────────────────────────────────
--  NOTIFICATIONS LOG
-- ────────────────────────────────────────────────────────────
create table notifications (
  id           uuid primary key default uuid_generate_v4(),
  customer_id  uuid references customers(id),
  order_id     uuid references orders(id),
  type         text not null,
  -- 'pickup_reminder' | 'order_picked_up' | 'processing' |
  -- 'out_for_delivery' | 'delivered' | 'rating_request' | 'marketing'
  channel      text not null check (channel in ('sms', 'email')),
  status       text default 'sent' check (status in ('sent', 'delivered', 'failed')),
  body         text,
  sent_at      timestamptz default now()
);

-- ────────────────────────────────────────────────────────────
--  DAILY STATS CACHE  (powers reports without slow queries)
-- ────────────────────────────────────────────────────────────
create table daily_stats (
  id                    uuid primary key default uuid_generate_v4(),
  date                  date not null unique,
  total_orders          integer default 0,
  total_revenue         numeric(10,2) default 0,
  new_customers         integer default 0,
  active_subscriptions  integer default 0,
  completed_stops       integer default 0,
  orders_by_service     jsonb default '{}',
  created_at            timestamptz default now()
);

-- ────────────────────────────────────────────────────────────
--  ROW LEVEL SECURITY
-- ────────────────────────────────────────────────────────────
alter table profiles           enable row level security;
alter table customers          enable row level security;
alter table addresses          enable row level security;
alter table drivers            enable row level security;
alter table services           enable row level security;
alter table subscription_plans enable row level security;
alter table subscriptions      enable row level security;
alter table orders             enable row level security;
alter table order_items        enable row level security;
alter table routes             enable row level security;
alter table route_stops        enable row level security;
alter table conversations      enable row level security;
alter table messages           enable row level security;
alter table notifications      enable row level security;
alter table daily_stats        enable row level security;

-- Admins can read/write everything
create policy "Admins have full access"
  on profiles for all
  using (
    exists (
      select 1 from profiles p
      where p.id = auth.uid() and p.role = 'admin'
    )
  );

-- Customers can read their own profile
create policy "Customers read own profile"
  on profiles for select
  using (auth.uid() = id);

-- Customers can read their own data
create policy "Customers read own orders"
  on orders for select
  using (
    customer_id in (
      select id from customers where profile_id = auth.uid()
    )
  );

-- Drivers can read routes assigned to them
create policy "Drivers read own routes"
  on routes for select
  using (
    driver_id in (
      select id from drivers where profile_id = auth.uid()
    )
  );

create policy "Drivers read own route stops"
  on route_stops for select
  using (
    route_id in (
      select id from routes where driver_id in (
        select id from drivers where profile_id = auth.uid()
      )
    )
  );

-- ────────────────────────────────────────────────────────────
--  SEED DATA  — Services & Subscription Plan
-- ────────────────────────────────────────────────────────────
insert into services (name, description, pricing_type, base_price, sort_order)
values
  ('Wash & Fold',        'Washed, dried, and folded — priced per pound',         'per_lb',   2.25, 1),
  ('Shirt Service',      'Laundered and pressed, returned on hangers',            'per_item', 3.50, 2),
  ('Hang Dry / Delicates','Hand-wash and hang dry for delicates and activewear', 'per_item', 4.00, 3),
  ('Dry Cleaning',       'Professional dry cleaning per garment',                 'per_item', 8.00, 4);

insert into subscription_plans (name, description, price_monthly, pickup_limit, features)
values (
  'Monthly Unlimited',
  'Flat monthly rate — schedule as many pickups as you need.',
  89.00,
  null,
  '["Unlimited pickups", "Free delivery on all orders", "Priority scheduling", "Dedicated support line"]'
);

-- ────────────────────────────────────────────────────────────
--  INDEXES  (keeps queries fast as data grows)
-- ────────────────────────────────────────────────────────────
create index idx_orders_customer_id        on orders(customer_id);
create index idx_orders_status             on orders(status);
create index idx_orders_created_at         on orders(created_at desc);
create index idx_route_stops_route_id      on route_stops(route_id);
create index idx_route_stops_order_id      on route_stops(order_id);
create index idx_messages_conversation_id  on messages(conversation_id);
create index idx_conversations_customer_id on conversations(customer_id);
create index idx_customers_risk_status     on customers(risk_status);
create index idx_customers_last_order_at   on customers(last_order_at);
create index idx_daily_stats_date          on daily_stats(date desc);
