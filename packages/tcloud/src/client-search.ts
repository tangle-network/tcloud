/**
 * Search service group for {@link TCloudClient}: rerank, web search,
 * deep research, and operator vector stores / RAG.
 * Internal module — the public surface is the client's methods.
 */

import type { RerankOptions, RerankResponse, ResearchOptions, ResearchResponse, SearchOptions, SearchResponse } from './types'
import type { ClientContext } from './client-core'

export async function rerank(ctx: ClientContext, options: RerankOptions): Promise<RerankResponse> {
  return ctx.request(`${ctx.baseURL}/rerank`, {
    method: 'POST',
    body: JSON.stringify({
      model: options.model || 'rerank-english-v3.0',
      query: options.query,
      documents: options.documents,
      top_n: options.top_n,
    }),
  })
}

export async function search(ctx: ClientContext, options: SearchOptions): Promise<SearchResponse> {
  return ctx.request(`${ctx.baseURL}/search`, {
    method: 'POST',
    signal: options.signal,
    body: JSON.stringify({
      query: options.query,
      provider: options.provider,
      model: options.model,
      maxResults: options.maxResults,
      searchRecency: options.searchRecency,
      includeDomains: options.includeDomains,
      excludeDomains: options.excludeDomains,
    }),
  })
}

export async function research(ctx: ClientContext, options: ResearchOptions): Promise<ResearchResponse> {
  return ctx.request(`${ctx.baseURL}/research`, {
    method: 'POST',
    body: JSON.stringify({
      query: options.query,
      provider: options.provider,
      model: options.model,
      effort: options.effort,
      maxResults: options.maxResults,
      searchRecency: options.searchRecency,
      includeDomains: options.includeDomains,
      excludeDomains: options.excludeDomains,
      outputSchema: options.outputSchema,
    }),
  })
}

export async function createCollection(ctx: ClientContext, options: { name: string; dimensions: number; distance_metric?: string }): Promise<any> {
  return ctx.request(`${ctx.baseURL}/collections`, {
    method: 'POST',
    body: JSON.stringify(options),
  })
}

export async function listCollections(ctx: ClientContext): Promise<any> {
  return ctx.fetch(`${ctx.baseURL}/collections`)
}

export async function upsertVectors(ctx: ClientContext, collection: string, vectors: Array<{ id: string; vector: number[]; metadata?: Record<string, any> }>): Promise<any> {
  return ctx.request(`${ctx.baseURL}/collections/${encodeURIComponent(collection)}/upsert`, {
    method: 'POST',
    body: JSON.stringify({ vectors }),
  })
}

export async function queryVectors(ctx: ClientContext, collection: string, options: { vector: number[]; top_k?: number; filter?: Record<string, any> }): Promise<any> {
  return ctx.request(`${ctx.baseURL}/collections/${encodeURIComponent(collection)}/query`, {
    method: 'POST',
    body: JSON.stringify(options),
  })
}

export async function ragQuery(ctx: ClientContext, options: { query: string; collection: string; top_k?: number; embedding_model?: string }): Promise<any> {
  return ctx.request(`${ctx.baseURL}/rag`, {
    method: 'POST',
    body: JSON.stringify(options),
  })
}
