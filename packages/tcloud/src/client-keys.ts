/**
 * Account service group for {@link TCloudClient}: billing, API keys
 * (including the budget-derived child mint), projects and user info.
 * Internal module — the public surface is the client's methods.
 */

import type { ApiKeyInfo, CreateKeyOptions, CreatedKey, CreditBalance, UpdateKeyOptions } from './types'
import type { ClientContext } from './client-core'
import { deriveChildBudgetUsd } from './decisions'

export async function credits(ctx: ClientContext): Promise<CreditBalance> {
  const { data } = await ctx.fetch<{ data: CreditBalance }>(`${ctx.platformURL}/v1/billing/balance`)
  return data
}

export async function addCredits(ctx: ClientContext, amount: number): Promise<{ url: string }> {
  const { data } = await ctx.fetch<{ data: { url: string } }>(`${ctx.platformURL}/v1/billing/topup`, {
    method: 'POST',
    body: JSON.stringify({ amount }),
  })
  return data
}

export async function transactions(ctx: ClientContext, limit = 50): Promise<{ id: string; amount: number; type: string; product: string | null; description: string | null; createdAt: string }[]> {
  const { data } = await ctx.fetch<{ data: { id: string; amount: number; type: string; product: string | null; description: string | null; createdAt: string }[] }>(`${ctx.platformURL}/v1/billing/transactions?limit=${limit}`)
  return data
}

export async function createKey(ctx: ClientContext, opts: CreateKeyOptions): Promise<CreatedKey> {
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
  const { data } = await ctx.fetch<{ data: CreatedKey }>(`${ctx.platformURL}/v1/keys`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
  return data
}

export async function getKey(ctx: ClientContext, id: string): Promise<ApiKeyInfo> {
  const { data } = await ctx.fetch<{ data: ApiKeyInfo }>(`${ctx.platformURL}/v1/keys/${id}`)
  return data
}

export async function keys(ctx: ClientContext, opts?: { children?: boolean }): Promise<ApiKeyInfo[]> {
  const q = opts?.children ? '?children=true' : ''
  const { data } = await ctx.fetch<{ data: ApiKeyInfo[] }>(`${ctx.platformURL}/v1/keys${q}`)
  return data
}

export async function updateKey(ctx: ClientContext, id: string, updates: UpdateKeyOptions): Promise<ApiKeyInfo> {
  const { data } = await ctx.fetch<{ data: ApiKeyInfo }>(`${ctx.platformURL}/v1/keys/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  })
  return data
}

export async function revokeKey(ctx: ClientContext, id: string): Promise<void> {
  await ctx.fetch(`${ctx.platformURL}/v1/keys/${id}`, { method: 'DELETE' })
}

export async function rotateKey(ctx: ClientContext, id: string): Promise<{ newKey: CreatedKey; revokedKeyId: string }> {
  const { data } = await ctx.fetch<{ data: { newKey: CreatedKey; revokedKeyId: string } }>(`${ctx.platformURL}/v1/keys/${id}/rotate`, { method: 'POST' })
  return data
}

export async function createProject(ctx: ClientContext, name: string, product?: string): Promise<{ id: string; name: string }> {
  const { data } = await ctx.fetch<{ data: { id: string; name: string } }>(`${ctx.platformURL}/v1/projects`, {
    method: 'POST',
    body: JSON.stringify({ name, product }),
  })
  return data
}

export async function projects(ctx: ClientContext): Promise<{ id: string; name: string; product: string | null; createdAt: string }[]> {
  const { data } = await ctx.fetch<{ data: { id: string; name: string; product: string | null; createdAt: string }[] }>(`${ctx.platformURL}/v1/projects`)
  return data
}

export async function userInfo(ctx: ClientContext): Promise<{ user: { id: string; email: string; name?: string }; balance: number; subscription: { plan: string; status: string } | null; usage: Record<string, { cost: number; count: number }> }> {
  return ctx.fetch(`${ctx.apiRoot}/api/auth/userinfo`)
}
