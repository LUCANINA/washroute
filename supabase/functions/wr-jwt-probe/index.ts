// wr-jwt-probe -- a throwaway function that exists ONLY to measure what a CLI
// deploy does to verify_jwt. It reads nothing, writes nothing, and is called by
// nothing. Session 283. Delete it once the measurement is recorded.
//
// How to read it: POST with no Authorization header.
//   401 {"code":"UNAUTHORIZED_NO_AUTH_HEADER"}  -> the GATEWAY answered: verify_jwt TRUE
//   200 {"probe":"wr-jwt-probe",...}             -> the FUNCTION answered: verify_jwt FALSE
import "jsr:@supabase/functions-js/edge-runtime.d.ts"

Deno.serve((_req: Request) => new Response(JSON.stringify({
  probe: 'wr-jwt-probe',
  reached: 'the function body, so the gateway did not stop this call',
  verify_jwt: false,
  marker: 'WR_PROBE_V2_CLI',
}), { status: 200, headers: { 'Content-Type': 'application/json' } }))
