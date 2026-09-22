Functions in this repo that are reachable from the internet must check the caller
themselves. `verify_jwt: true` is NOT a check: the anon key is published in every
app, so anyone can present a valid JWT. Copy the `authorize()` block from
charge-order/index.ts (staff role check + x-wr-internal secret for DB callers).
