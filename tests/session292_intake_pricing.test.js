// WashRoute session 292 — intake pricing coverage test.
//
// Run from the repo root:   node tests/session292_intake_pricing.test.js
// Exits non-zero if any case fails. No DB, no browser — it reads the SHIPPED
// getFeesForPricelist out of admin-dashboard/index.html and replays the
// pricelist/coverage rule from resolveOrderPricelist against known orders.
//
// Session 196 made the SUBSCRIPTION resolve from the order. It left `pricelist`
// — and so the delivery fee — resolving from the customer's LIVE record. This
// guards the other half, plus the coverage test 196 never had.
//
const fs=require('fs');
const src=fs.readFileSync('admin-dashboard/index.html','utf8');
const g=src.match(/function getFeesForPricelist\(pricelist\)\s*\{[\s\S]*?\n  \}/);
if(!g){console.error('could not extract getFeesForPricelist — did it move?');process.exit(1);}
let allFees=[
 {name:'Delivery Fee',amount:'9.95',is_active:true,pricelist:null},
 {name:'Same-Day Surcharge',amount:'14.95',is_active:true,pricelist:null},
 {name:'Delivery Fee',amount:'0.00',is_active:true,pricelist:'Subscription'},
];
eval(g[0]);
const fee=pl=>parseFloat(getFeesForPricelist(pl).find(f=>f.name==='Delivery Fee'&&f.is_active)?.amount||0);
const SERVICES=[
 {name:'Wash & Fold',pricelist:'Delivery',base_price:'65.00',is_addon:false},
 {name:'Wash & Fold',pricelist:'Subscription',base_price:'0.00',is_addon:false},
 {name:'Wash & Fold',pricelist:'Commercial',base_price:'1.75',is_addon:false,pricing_type:'per_lb'},
];

// resolveOrderPricelist + the two call sites it feeds, transcribed.
function price(order, sub, customerPricelist){
  let covered=false;
  if(order.subscription_id && sub){
    const placedAt=order.created_at?new Date(order.created_at):null;
    const live=['active','past_due','paused'].includes(sub.status);
    const endsAt=sub.cancelled_at||sub.current_period_end;
    covered=live||(!!placedAt&&!!endsAt&&placedAt<=new Date(endsAt));
  }
  const pricelist=covered?'Subscription':(customerPricelist||'Delivery');
  let svc=order.service;                       // the order's own stored service
  if(!svc||svc.pricelist!==pricelist) svc=SERVICES.find(s=>!s.is_addon&&s.pricelist===pricelist)||svc;
  return {pricelist, base:parseFloat(svc.base_price), deliveryFee:fee(pricelist)};
}

let fails=0;
const eq=(n,got,want)=>{const ok=JSON.stringify(got)===JSON.stringify(want);if(!ok)fails++;
  console.log(`${ok?'PASS':'FAIL'}  ${n}`); if(!ok)console.log(`        got ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);};

const SUB=SERVICES[1], DEL=SERVICES[0];

console.log('=== the bug: Kate Roberts #14666 ===');
eq('booked while covered, weighed in 38 min after the plan cancelled',
  price({subscription_id:'s1',created_at:'2026-09-10T01:10:24Z',service:SUB},
        {status:'cancelled',cancelled_at:'2026-09-10T14:29:59Z',current_period_end:'2026-09-10T14:29:20Z'},
        'Delivery'),
  {pricelist:'Subscription',base:0,deliveryFee:0});

console.log('\n=== the same bug inverted: Candy RamirezHale #14302 ===');
eq('recurring order generated 7 weeks AFTER the plan was cancelled',
  price({subscription_id:'s2',created_at:'2026-09-05T02:35:22Z',service:SUB},
        {status:'cancelled',cancelled_at:'2026-07-13T07:28:29Z',current_period_end:'2026-07-13T07:27:57Z'},
        'Delivery'),
  {pricelist:'Delivery',base:65,deliveryFee:9.95});

console.log('\n=== no regression for everyone else ===');
eq('ordinary active subscriber',
  price({subscription_id:'s3',created_at:'2026-09-11T00:00:00Z',service:SUB},
        {status:'active',cancelled_at:null,current_period_end:'2026-10-01T00:00:00Z'},'Subscription'),
  {pricelist:'Subscription',base:0,deliveryFee:0});
eq('past_due subscriber still covered (matches link_subscription_on_order_fn)',
  price({subscription_id:'s3b',created_at:'2026-09-11T00:00:00Z',service:SUB},
        {status:'past_due',cancelled_at:null,current_period_end:'2026-09-01T00:00:00Z'},'Subscription'),
  {pricelist:'Subscription',base:0,deliveryFee:0});
eq('paused subscriber still covered',
  price({subscription_id:'s4',created_at:'2026-09-11T00:00:00Z',service:SUB},
        {status:'paused',cancelled_at:null,current_period_end:'2026-09-01T00:00:00Z'},'Subscription'),
  {pricelist:'Subscription',base:0,deliveryFee:0});
eq('plain pay-as-you-go order',
  price({created_at:'2026-09-11T00:00:00Z',service:DEL},null,'Delivery'),
  {pricelist:'Delivery',base:65,deliveryFee:9.95});
eq('commercial order untouched',
  price({created_at:'2026-09-11T00:00:00Z',service:SERVICES[2]},null,'Commercial'),
  {pricelist:'Commercial',base:1.75,deliveryFee:9.95});
eq('booked exactly AT period end (inclusive boundary)',
  price({subscription_id:'s5',created_at:'2026-09-10T14:29:20Z',service:SUB},
        {status:'cancelled',cancelled_at:null,current_period_end:'2026-09-10T14:29:20Z'},'Delivery'),
  {pricelist:'Subscription',base:0,deliveryFee:0});
eq('booked one second after period end',
  price({subscription_id:'s6',created_at:'2026-09-10T14:29:21Z',service:SUB},
        {status:'cancelled',cancelled_at:null,current_period_end:'2026-09-10T14:29:20Z'},'Delivery'),
  {pricelist:'Delivery',base:65,deliveryFee:9.95});
eq('subscription row unreadable/missing — falls back to live customer state',
  price({subscription_id:'gone',created_at:'2026-09-11T00:00:00Z',service:SUB},null,'Subscription'),
  {pricelist:'Subscription',base:0,deliveryFee:0});

console.log('\n=== fee table sanity ===');
eq('Subscription pricelist -> $0 delivery', fee('Subscription'), 0);
eq('Delivery pricelist -> $9.95',           fee('Delivery'),     9.95);
allFees=[allFees[2],allFees[0],allFees[1]];
eq('still $0 with the fee rows in a different order', fee('Subscription'), 0);

console.log(fails?`\n❌ ${fails} FAILING`:'\n✅ all green');
process.exit(fails?1:0);
