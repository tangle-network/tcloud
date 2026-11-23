import type { TCloudClient } from './client'
import type { PrivacyConfig } from './types'

export class TCloudError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'TCloudError'
  }
}

// The service methods run on the client itself. Derive their internal receiver
// from the implementation so transport helpers stay private on the public SDK.
export type ServiceContext = Pick<TCloudClient, 'baseURL' | 'platformURL' | 'model'> & {
  headers: TCloudClient['headers']
  _request: TCloudClient['_request']
  _fetch: TCloudClient['_fetch']
  _requestRaw: TCloudClient['_requestRaw']
  _requestWithResponse: TCloudClient['_requestWithResponse']
  privacy: TCloudClient['privacy']
  checkLimits: TCloudClient['checkLimits']
  _requestCount: TCloudClient['_requestCount']
  _allowedModelsCache: TCloudClient['_allowedModelsCache']
}

export function defineService<T>(methods: T & ThisType<ServiceContext & T>): T {
  return methods
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
