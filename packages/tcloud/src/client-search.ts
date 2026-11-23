import { defineService } from './client-service'
import type {
  RerankOptions,
  RerankResponse,
  ResearchOptions,
  ResearchResponse,
  SearchOptions,
  SearchResponse,
} from './types'

export const searchMethods = defineService({
  /** Rerank documents by relevance to a query */
  async rerank(options: RerankOptions): Promise<RerankResponse> {
    return this._request(`${this.baseURL}/rerank`, {
      method: 'POST',
      body: JSON.stringify({
        model: options.model || 'rerank-english-v3.0',
        query: options.query,
        documents: options.documents,
        top_n: options.top_n,
      }),
    })
  },

  /** Search the web through Tangle Router billing and provider routing. */
  async search(options: SearchOptions): Promise<SearchResponse> {
    return this._request(`${this.baseURL}/search`, {
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
  },

  /** Run a multi-step deep-research task through Tangle Router billing and
   *  provider routing (POST /v1/research). Slower and costlier than `search` —
   *  the provider synthesizes an answer over many fetches. Pick depth with
   *  `effort` (provider-specific vocabulary; see {@link ResearchOptions.effort}). */
  async research(options: ResearchOptions): Promise<ResearchResponse> {
    return this._request(`${this.baseURL}/research`, {
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
  },

  // ---------------------------------------------------------------------------
  // Vector Store (requires operator routing — X-Tangle-Service/Blueprint/Operator)
  // ---------------------------------------------------------------------------

  /** Create a vector collection on the operator's vector store */
  async createCollection(options: { name: string; dimensions: number; distance_metric?: string }): Promise<any> {
    return this._request(`${this.baseURL}/collections`, {
      method: 'POST',
      body: JSON.stringify(options),
    })
  },

  /** List collections on the operator's vector store */
  async listCollections(): Promise<any> {
    return this._fetch(`${this.baseURL}/collections`)
  },

  /** Upsert vectors into a collection */
  async upsertVectors(collection: string, vectors: Array<{ id: string; vector: number[]; metadata?: Record<string, any> }>): Promise<any> {
    return this._request(`${this.baseURL}/collections/${encodeURIComponent(collection)}/upsert`, {
      method: 'POST',
      body: JSON.stringify({ vectors }),
    })
  },

  /** Similarity search in a collection */
  async queryVectors(collection: string, options: { vector: number[]; top_k?: number; filter?: Record<string, any> }): Promise<any> {
    return this._request(`${this.baseURL}/collections/${encodeURIComponent(collection)}/query`, {
      method: 'POST',
      body: JSON.stringify(options),
    })
  },

  /** RAG query — embed text + search collection in one call */
  async ragQuery(options: { query: string; collection: string; top_k?: number; embedding_model?: string }): Promise<any> {
    return this._request(`${this.baseURL}/rag`, {
      method: 'POST',
      body: JSON.stringify(options),
    })
  },
})
