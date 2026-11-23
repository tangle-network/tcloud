import type { TCloudClient } from './client'

export class TCloudError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'TCloudError'
  }
}

// The service methods run on the client itself. Derive their internal receiver
// from the implementation so transport helpers stay private on the public SDK.
type ServiceContext = Pick<TCloudClient, 'baseURL' | 'platformURL'> & {
  headers: TCloudClient['headers']
  _request: TCloudClient['_request']
  _fetch: TCloudClient['_fetch']
  _requestRaw: TCloudClient['_requestRaw']
  _requestWithResponse: TCloudClient['_requestWithResponse']
  _requestMultipart: TCloudClient['_requestMultipart']
  _proxiedFetch: TCloudClient['_proxiedFetch']
}

export function defineService<T>(methods: T & ThisType<ServiceContext & T>): T {
  return methods
}
