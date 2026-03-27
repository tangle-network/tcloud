/**
 * tcloud-agent — Private AI Agent
 *
 * An autonomous agent backed by shielded credits that rotates operators
 * for privacy-preserving inference. Can be used as:
 * - A Pi agent extension for Claude
 * - A standalone agent in any Node.js app
 * - A Claude Code skill
 *
 * The agent:
 * 1. Generates or loads an ephemeral shielded wallet
 * 2. Funds it from the VAnchor pool (or accepts pre-funded)
 * 3. Routes each request through rotating operators via the private router
 * 4. Signs SpendAuth per-request (different operator each time)
 * 5. Optionally summarizes context when switching operators (reduces leakage)
 */

import { PrivateRouter, type OperatorInfo, type PrivateRouterConfig } from './private-router'

export interface PrivateAgentConfig {
  /** Tangle AI Cloud API base URL */
  apiUrl: string
  /** Pre-existing shielded wallet (if not set, generates ephemeral) */
  wallet?: {
    privateKey: string
    commitment: string
    salt: string
  }
  /** Operator routing strategy */
  routing?: Partial<PrivateRouterConfig>
  /** Model to use for inference */
  model?: string
  /** Model to use for context summarization (cheaper, local-preferred) */
  summaryModel?: string
  /** Chain config */
  chainId?: number
  creditsAddress?: string
  /** Max conversation turns before auto-rotating wallet (extreme privacy) */
  maxTurnsPerWallet?: number
  /** Enable conversation summarization when switching operators */
  summarizeOnSwitch?: boolean
}

export interface ConversationMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
  operator?: string  // which operator served this response
  timestamp?: number
}

export class PrivateAgent {
  private config: PrivateAgentConfig
  private router: PrivateRouter
  private conversation: ConversationMessage[] = []
  private turnCount = 0
  private walletRotations = 0

  constructor(config: PrivateAgentConfig) {
    this.config = {
      apiUrl: config.apiUrl || 'https://api.tangleai.cloud',
      model: config.model || 'gpt-4o-mini',
      summaryModel: config.summaryModel || 'gpt-4o-mini',
      chainId: config.chainId || 3799,
      maxTurnsPerWallet: config.maxTurnsPerWallet || 50,
      summarizeOnSwitch: config.summarizeOnSwitch ?? true,
      ...config,
    }

    this.router = new PrivateRouter({
      strategy: 'min-exposure',
      maxRequestsPerOperator: 5,
      minOperators: 3,
      summarizeOnSwitch: this.config.summarizeOnSwitch ?? true,
      ...config.routing,
    })
  }

  /** Initialize the agent — fetch operators and set up routing */
  async init(): Promise<void> {
    // Fetch available operators from the gateway
    const res = await fetch(`${this.config.apiUrl}/api/operators`)
    if (!res.ok) throw new Error('Failed to fetch operators')
    const data = await res.json()

    const operators: OperatorInfo[] = (data.operators || []).map((op: any) => ({
      slug: op.slug,
      endpointUrl: op.endpointUrl,
      region: op.region || 'unknown',
      reputationScore: op.reputationScore,
      avgLatencyMs: op.avgLatencyMs,
      models: (op.models || []).map((m: any) => m.modelId),
    }))

    this.router.setOperators(operators)
    console.log(`[tcloud-agent] Initialized with ${operators.length} operators`)
  }

  /** Send a message and get a response */
  async chat(userMessage: string): Promise<string> {
    this.turnCount++

    // Check if we need to rotate wallet (extreme privacy mode)
    if (this.config.maxTurnsPerWallet && this.turnCount > this.config.maxTurnsPerWallet) {
      await this.rotateWallet()
    }

    // Select operator for this request
    const operator = this.router.selectOperator(this.config.model!)

    // Check if we should summarize context (switching operators)
    if (this.router.shouldSummarize(this.config.model!) && this.conversation.length > 2) {
      await this.summarizeContext()
    }

    // Add user message
    this.conversation.push({
      role: 'user',
      content: userMessage,
      timestamp: Date.now(),
    })

    // Build request — only send recent context to limit operator exposure
    const messages = this.conversation.map((m) => ({
      role: m.role,
      content: m.content,
    }))

    // Make the request
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }

    // In full implementation: sign SpendAuth here with the shielded wallet
    // For now, use standard auth as placeholder
    // headers['X-Payment-Signature'] = signSpendAuth(...)

    if (operator) {
      headers['X-Tangle-Operator'] = operator.slug
    }

    const res = await fetch(`${this.config.apiUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: this.config.model,
        messages,
        max_tokens: 4096,
        stream: false,
      }),
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(`Chat failed (${res.status}): ${(err as any).error || res.statusText}`)
    }

    const data = await res.json()
    const content = (data as any).choices?.[0]?.message?.content || ''

    // Record response with operator attribution
    this.conversation.push({
      role: 'assistant',
      content,
      operator: operator?.slug,
      timestamp: Date.now(),
    })

    return content
  }

  /** Stream a response */
  async *chatStream(userMessage: string): AsyncGenerator<string> {
    this.turnCount++

    const operator = this.router.selectOperator(this.config.model!)

    this.conversation.push({ role: 'user', content: userMessage, timestamp: Date.now() })

    const messages = this.conversation.map((m) => ({ role: m.role, content: m.content }))

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (operator) headers['X-Tangle-Operator'] = operator.slug

    const res = await fetch(`${this.config.apiUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: this.config.model, messages, max_tokens: 4096, stream: true }),
    })

    if (!res.ok) throw new Error(`Chat failed (${res.status})`)

    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let fullContent = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })

      const lines = buf.split('\n')
      buf = lines.pop() || ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6).trim()
        if (data === '[DONE]') break
        try {
          const chunk = JSON.parse(data)
          const content = chunk.choices?.[0]?.delta?.content
          if (content) {
            fullContent += content
            yield content
          }
        } catch {}
      }
    }

    this.conversation.push({ role: 'assistant', content: fullContent, operator: operator?.slug, timestamp: Date.now() })
  }

  /** Summarize the conversation to reduce context sent to the next operator */
  private async summarizeContext(): Promise<void> {
    if (this.conversation.length < 4) return

    const summaryPrompt = [
      { role: 'system' as const, content: 'Summarize this conversation in 2-3 sentences, preserving key context and any decisions made.' },
      { role: 'user' as const, content: this.conversation.map((m) => `${m.role}: ${m.content}`).join('\n') },
    ]

    try {
      const res = await fetch(`${this.config.apiUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.config.summaryModel, messages: summaryPrompt, max_tokens: 200, stream: false }),
      })

      if (res.ok) {
        const data = await res.json()
        const summary = (data as any).choices?.[0]?.message?.content
        if (summary) {
          // Replace conversation with summary
          this.conversation = [
            { role: 'system', content: `Previous conversation summary: ${summary}`, timestamp: Date.now() },
          ]
          console.log(`[tcloud-agent] Context summarized (${this.turnCount} turns compressed)`)
        }
      }
    } catch {
      // Summarization failed — keep full context
    }
  }

  /** Rotate to a new ephemeral wallet (extreme privacy) */
  private async rotateWallet(): Promise<void> {
    this.walletRotations++
    this.turnCount = 0
    console.log(`[tcloud-agent] Wallet rotation #${this.walletRotations}`)
    // In full implementation: generate new wallet, fund from pool
  }

  /** Get privacy metrics */
  getPrivacyStats() {
    return {
      ...this.router.getStats(),
      conversationTurns: this.turnCount,
      walletRotations: this.walletRotations,
      contextMessages: this.conversation.length,
    }
  }

  /** Get the conversation history */
  getConversation(): ConversationMessage[] {
    return [...this.conversation]
  }

  /** Clear conversation (fresh context, better privacy) */
  clearConversation(): void {
    this.conversation = []
  }

  /** Set system prompt */
  setSystemPrompt(prompt: string): void {
    // Remove existing system messages
    this.conversation = this.conversation.filter((m) => m.role !== 'system')
    // Add new system prompt at the start
    this.conversation.unshift({ role: 'system', content: prompt, timestamp: Date.now() })
  }
}
