// Single source of truth for Xero authentication and tenant resolution.
//
// WHY THIS FILE EXISTS (session 222, 2026-08-19)
// ----------------------------------------------
// Every Xero-calling edge function used to carry its own copy of getXeroToken() and
// read XERO_TENANT_ID straight from the environment. That is fine for exactly one
// organisation and impossible for two, because the current connection is a Xero
// **Custom Connection** (client_credentials), which per Xero's own docs is:
//   - limited to ONE organisation,
//   - not eligible for the Xero App Marketplace,
//   - billed at $5/month USD per organisation (the standard code flow is free).
//
// So a move to a standard OAuth 2.0 app is inevitable for any multi-client future, and
// it is also the most likely route to scopes a Custom Connection does not offer --
// `accounting.journals.read` chief among them (see DESIGN-LOAN-POSTING-MODEL.md §9-§10).
//
// Under that flow, getting a token stops being a single stateless call and becomes:
//   look up this org's stored refresh token -> refresh it -> PERSIST THE ROTATED ONE
//   -> use the resulting access token with that org's tenant id.
// Xero rotates the refresh token on every use and expires it after 60 days of
// inactivity, so that persistence step is not optional and must not be duplicated
// across call sites.
//
// The point of this module is that when that day comes, **only this file changes.**
// Callers already pass an orgRef and receive ready-to-use headers back.
//
// USAGE
//   import { getXeroAuth } from './xero-auth.ts'
//   const { headers, tenantId } = await getXeroAuth()
//   const res = await fetch(url, { headers })
//   // and for writes:
//   const res = await fetch(url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body })

export interface XeroAuth {
  /** Ready to spread into fetch(). Includes Authorization, Xero-tenant-id and Accept. */
  headers: Record<string, string>
  /** The Xero tenant (organisation) id these headers are scoped to. */
  tenantId: string
  /** Raw bearer token, for the rare caller that needs to build headers itself. */
  accessToken: string
}

/**
 * Resolve credentials for a Xero organisation.
 *
 * @param orgRef Which organisation to authenticate against. Deliberately accepted and
 *   deliberately unused today: there is exactly one organisation, so passing anything
 *   other than undefined is currently an error rather than being silently ignored --
 *   a silent ignore is how you ship a multi-tenant bug that writes to the wrong org's
 *   ledger. Threading the parameter now is what makes the OAuth migration a swap
 *   instead of a rewrite of every call site.
 */
export async function getXeroAuth(orgRef?: string): Promise<XeroAuth> {
  const tenantId = Deno.env.get('XERO_TENANT_ID')
  if (!tenantId) throw new Error('XERO_TENANT_ID is not configured')

  // Fail loudly rather than quietly authenticating against the wrong organisation.
  // When this becomes multi-tenant, replace this guard with a real lookup.
  if (orgRef !== undefined && orgRef !== tenantId) {
    throw new Error(
      `getXeroAuth() was asked for org "${orgRef}" but this deployment is a Custom ` +
      `Connection bound to the single tenant "${tenantId}". Multi-org requires ` +
      `migrating to a standard OAuth 2.0 app -- see DESIGN-LOAN-POSTING-MODEL.md §10.`,
    )
  }

  const clientId = Deno.env.get('XERO_CLIENT_ID')
  const clientSecret = Deno.env.get('XERO_CLIENT_SECRET')
  if (!clientId || !clientSecret) throw new Error('XERO_CLIENT_ID / XERO_CLIENT_SECRET are not configured')

  const basic = btoa(`${clientId}:${clientSecret}`)
  const res = await fetch('https://identity.xero.com/connect/token', {
    method: 'POST',
    headers: { 'Authorization': `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  })
  if (!res.ok) throw new Error(`Xero token request failed: ${res.status} ${await res.text()}`)

  const accessToken = (await res.json()).access_token as string
  if (!accessToken) throw new Error('Xero token response contained no access_token')

  return {
    accessToken,
    tenantId,
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Xero-tenant-id': tenantId,
      'Accept': 'application/json',
    },
  }
}

/**
 * Diagnostic helper: which scopes did Xero actually grant?
 *
 * Exists because scope gaps in this project have twice been discovered as a mysterious
 * 401 on a specific endpoint rather than as a clear "you don't have that scope". The
 * Journals endpoint returning 401 for a missing `accounting.journals.read` is the
 * canonical example. Cheap to call when diagnosing an unexpected authorization failure.
 */
export async function getGrantedScopes(): Promise<string[]> {
  const clientId = Deno.env.get('XERO_CLIENT_ID')!
  const clientSecret = Deno.env.get('XERO_CLIENT_SECRET')!
  const basic = btoa(`${clientId}:${clientSecret}`)
  const res = await fetch('https://identity.xero.com/connect/token', {
    method: 'POST',
    headers: { 'Authorization': `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  })
  if (!res.ok) return []
  return String((await res.json()).scope || '').split(' ').filter(Boolean).sort()
}
