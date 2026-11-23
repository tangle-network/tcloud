/**
 * Shared internals for the {@link TCloudClient} service groups.
 *
 * `client.ts` owns configuration, metering, retry/timeout and the request
 * helpers; the service-group modules (`client-keys.ts`, `client-media.ts`,
 * `client-search.ts`, `client-decisions.ts`) receive those helpers through a
 * {@link ClientContext} so they never reach into the client's private state.
 * Nothing here is part of the public package surface beyond `TCloudError`,
 * which `client.ts` re-exports.
 */

import type { PrivacyConfig } from './types'

export type ClientRequestInit = RequestInit & { method?: string }

/** The client capabilities a service-group module may use. */
export interface ClientContext {
  readonly baseURL: string
  readonly platformURL: string
  /** `baseURL` without the trailing `/v1` — the router's `/api/*` root. */
  readonly apiRoot: string
  /** Default request headers (auth, client id, routing). Copy before mutating. */
  readonly headers: Record<string, string>
  readonly privacy: PrivacyConfig | undefined
  /** Enforce spending/request limits before a billable call. */
  checkLimits(): void
  /** Count a billable request that bypassed the shared helpers. */
  countRequest(): void
  /** Billable JSON call: limits → fetch with retry/timeout → count. */
  request<T>(url: string, init?: ClientRequestInit): Promise<T>
  /** Read-only JSON call: no limits check, no counting. */
  fetch<T>(url: string, init?: ClientRequestInit): Promise<T>
  /** Billable call returning the raw Response (non-JSON bodies). */
  requestRaw(url: string, init?: ClientRequestInit): Promise<Response>
  /** Billable call whose caller headers merge beside the client's. */
  requestWithResponse(url: string, init?: ClientRequestInit): Promise<Response>
}

export class TCloudError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'TCloudError'
  }
}

/**
 * Route a fetch call through the configured privacy proxy.
 * - direct: standard fetch
 * - relayer: POST to relayer's /relay/proxy or /relay/proxy-stream
 */
export async function proxiedFetch(
  privacy: PrivacyConfig | undefined,
  url: string,
  init: RequestInit,
  streaming: boolean,
): Promise<Response> {
  if (!privacy || privacy.mode === 'direct') {
    return fetch(url, init)
  }

  if (privacy.mode !== 'relayer') {
    throw new Error(`Unsupported privacy mode: ${String(privacy.mode)}`)
  }
  if (!privacy.relayerUrl) {
    throw new Error('relayerUrl is required when privacy mode is "relayer"')
  }
  const proxyPath = streaming ? '/relay/proxy-stream' : '/relay/proxy'
  const headers: Record<string, string> = {}
  if (init.headers) {
    const entries = init.headers instanceof Headers
      ? Array.from(init.headers.entries())
      : Object.entries(init.headers as Record<string, string>)
    for (const [key, value] of entries) headers[key] = value
  }
  return fetch(`${privacy.relayerUrl}${proxyPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: init.signal,
    body: JSON.stringify({
      target: url,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
      headers,
    }),
  })
}
