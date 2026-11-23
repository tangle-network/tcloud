import { defineService } from './client-service'
import { deriveChildBudgetUsd } from './decisions'
import type {
  CreateKeyOptions,
  CreatedKey,
  ApiKeyInfo,
  UpdateKeyOptions,
} from './types'

export const keyMethods = defineService({
  /**
   * Create a new API key.
   * When called with an API key (not session), the new key is automatically
   * a child of the calling key — enabling hierarchical key delegation.
   *
   * Pass `parentKeyId` explicitly to create a child of a specific key.
   * Child keys inherit the parent's product scope, allowedModels, and rpmLimit
   * if not specified. Budget cannot exceed the parent's remaining budget.
   */
  async createKey(opts: CreateKeyOptions): Promise<CreatedKey> {
    // The platform reserves a child's budget against its parent's REMAINING;
    // an ask above it is refused outright. When the caller reports the
    // parent's remaining, derive the ask (never above it, never below the
    // platform minimum) instead of sending a flat default.
    const body: CreateKeyOptions & { budgetUsd?: number } = { ...opts }
    if (opts.parentBudgetRemainingUsd !== undefined) {
      body.budgetUsd = opts.budgetUsd !== undefined
        ? deriveChildBudgetUsd({ requestedUsd: opts.budgetUsd, parentRemainingUsd: opts.parentBudgetRemainingUsd })
        : undefined
      delete (body as { parentBudgetRemainingUsd?: number }).parentBudgetRemainingUsd
      if (body.budgetUsd === undefined) delete body.budgetUsd
    }
    const { data } = await this._fetch<{ data: CreatedKey }>(`${this.platformURL}/v1/keys`, {
      method: 'POST',
      body: JSON.stringify(body),
    })
    return data
  },

  /** Get a single API key by ID */
  async getKey(id: string): Promise<ApiKeyInfo> {
    const { data } = await this._fetch<{ data: ApiKeyInfo }>(`${this.platformURL}/v1/keys/${id}`)
    return data
  },

  /**
   * List API keys.
   * Pass `children: true` to list child keys of the calling API key.
   */
  async keys(opts?: { children?: boolean }): Promise<ApiKeyInfo[]> {
    const q = opts?.children ? '?children=true' : ''
    const { data } = await this._fetch<{ data: ApiKeyInfo[] }>(`${this.platformURL}/v1/keys${q}`)
    return data
  },

  /**
   * Update an API key's limits.
   * Can adjust budget, allowedModels, rpmLimit, expiresAt, and name.
   */
  async updateKey(id: string, updates: UpdateKeyOptions): Promise<ApiKeyInfo> {
    const { data } = await this._fetch<{ data: ApiKeyInfo }>(`${this.platformURL}/v1/keys/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    })
    return data
  },

  /** Revoke an API key. If the key has children, they are also revoked recursively. */
  async revokeKey(id: string): Promise<void> {
    await this._fetch(`${this.platformURL}/v1/keys/${id}`, { method: 'DELETE' })
  },

  /** Rotate an API key — creates new key with same config, revokes old */
  async rotateKey(id: string): Promise<{ newKey: CreatedKey; revokedKeyId: string }> {
    const { data } = await this._fetch<{ data: { newKey: CreatedKey; revokedKeyId: string } }>(`${this.platformURL}/v1/keys/${id}/rotate`, { method: 'POST' })
    return data
  },

  // ── Projects (via id.tangle.tools) ──

  /** Create a project for usage attribution */
  async createProject(name: string, product?: string): Promise<{ id: string; name: string }> {
    const { data } = await this._fetch<{ data: { id: string; name: string } }>(`${this.platformURL}/v1/projects`, {
      method: 'POST',
      body: JSON.stringify({ name, product }),
    })
    return data
  },

  /** List projects */
  async projects(): Promise<{ id: string; name: string; product: string | null; createdAt: string }[]> {
    const { data } = await this._fetch<{ data: { id: string; name: string; product: string | null; createdAt: string }[] }>(`${this.platformURL}/v1/projects`)
    return data
  },
})
