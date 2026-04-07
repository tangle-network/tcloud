/**
 * TangleToolProvider — Capability-based tool registry for Tangle AI services.
 *
 * Single `tangle` tool with a `capability` parameter that dispatches to
 * the correct TCloudClient method. New capabilities are registered at
 * construction; the set is extensible via `register()`.
 */

import type { TCloudClient } from '@tangle-network/tcloud'
import type {
  ChatMessage,
  VideoResponse,
  AvatarJobStatus,
} from '@tangle-network/tcloud'

// ── Public types ──

export interface ToolResult {
  type: string
  data: unknown
  cost?: { estimated: number; actual?: number }
}

export interface CapabilityHandler {
  name: string
  description: string
  schema: Record<string, unknown>
  execute(input: any, client: TCloudClient): Promise<ToolResult>
}

// ── Capability handlers ──

const chatCapability: CapabilityHandler = {
  name: 'chat',
  description: 'Chat completion (text in, text out)',
  schema: {
    messages: { type: 'array', items: { type: 'object' }, required: true, description: 'Array of {role, content} messages' },
    model: { type: 'string' },
    max_tokens: { type: 'number' },
    temperature: { type: 'number' },
  },
  async execute(input, client) {
    const result = await client.chat({
      messages: input.messages as ChatMessage[],
      model: input.model,
      maxTokens: input.max_tokens,
      temperature: input.temperature,
    })
    const text = result.choices[0]?.message?.content || ''
    return { type: 'chat', data: { text, model: result.model, usage: result.usage } }
  },
}

const embedCapability: CapabilityHandler = {
  name: 'embed',
  description: 'Generate embedding vectors from text',
  schema: {
    input: { type: ['string', 'array'], required: true, description: 'Text or array of texts to embed' },
    model: { type: 'string' },
  },
  async execute(input, client) {
    const result = await client.embeddings({
      input: input.input,
      model: input.model,
    })
    return { type: 'embed', data: { embeddings: result.data.map(d => d.embedding), model: result.model, usage: result.usage } }
  },
}

const speechCapability: CapabilityHandler = {
  name: 'speech',
  description: 'Text-to-speech audio generation',
  schema: {
    input: { type: 'string', required: true, description: 'Text to synthesize' },
    voice: { type: 'string', description: 'Voice ID (default: alloy)' },
    model: { type: 'string' },
  },
  async execute(input, client) {
    const audioBuffer = await client.speech({
      input: input.input,
      voice: input.voice,
      model: input.model,
    })
    const base64 = Buffer.from(audioBuffer).toString('base64')
    return { type: 'speech', data: { audio_base64: base64, format: 'mp3' } }
  },
}

const transcribeCapability: CapabilityHandler = {
  name: 'transcribe',
  description: 'Speech-to-text transcription',
  schema: {
    audio_base64: { type: 'string', required: true, description: 'Base64-encoded audio data' },
    language: { type: 'string' },
    model: { type: 'string' },
  },
  async execute(input, client) {
    const audioBytes = Buffer.from(input.audio_base64, 'base64')
    const blob = new Blob([audioBytes], { type: 'audio/webm' })
    const result = await client.transcribe(blob, {
      language: input.language,
      model: input.model,
    })
    return { type: 'transcribe', data: { text: result.text } }
  },
}

const imageCapability: CapabilityHandler = {
  name: 'image',
  description: 'Generate images from text prompts',
  schema: {
    prompt: { type: 'string', required: true },
    size: { type: 'string', enum: ['256x256', '512x512', '1024x1024'] },
    n: { type: 'number', description: 'Number of images (1-4)' },
    model: { type: 'string' },
    quality: { type: 'string' },
  },
  async execute(input, client) {
    const result = await client.imageGenerate({
      prompt: input.prompt,
      size: input.size || '1024x1024',
      n: input.n || 1,
      model: input.model,
      quality: input.quality,
    })
    return { type: 'image', data: { images: result.data, created: result.created } }
  },
}

const videoCapability: CapabilityHandler = {
  name: 'video',
  description: 'Generate video from text or image prompts (async, polls until done)',
  schema: {
    prompt: { type: 'string', required: true },
    duration: { type: 'number' },
    resolution: { type: 'string' },
    model: { type: 'string' },
  },
  async execute(input, client) {
    const job = await client.videoGenerate({
      prompt: input.prompt,
      duration: input.duration,
      resolution: input.resolution,
      model: input.model,
    })
    if (job.status === 'completed' || job.url) {
      return { type: 'video', data: { url: job.url, id: job.id, status: job.status } }
    }
    // Poll until terminal state
    const result = await pollVideo(client, job.id)
    return { type: 'video', data: { url: result.url, id: result.id, status: result.status } }
  },
}

async function pollVideo(client: TCloudClient, id: string, timeoutMs = 300_000): Promise<VideoResponse> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const status = await client.videoStatus(id)
    if (status.status === 'completed') return status
    if (status.status === 'failed') throw new Error(status.error || `Video job ${id} failed`)
    await new Promise(r => setTimeout(r, 5000))
  }
  throw new Error(`Video job ${id} timed out after ${timeoutMs}ms`)
}

const avatarCapability: CapabilityHandler = {
  name: 'avatar',
  description: 'Generate lip-synced avatar video from audio and face image (async, polls until done)',
  schema: {
    audio_url: { type: 'string', required: true, description: 'URL to narration audio' },
    image_url: { type: 'string', description: 'URL to face image' },
    avatar_id: { type: 'string', description: 'Preset avatar identifier' },
    duration_seconds: { type: 'number' },
  },
  async execute(input, client) {
    const job = await client.avatarGenerate({
      audio_url: input.audio_url,
      image_url: input.image_url,
      avatar_id: input.avatar_id,
      duration_seconds: input.duration_seconds,
    })
    if (job.status === 'completed' && job.result) {
      return { type: 'avatar', data: { video_url: job.result.video_url, duration: job.result.duration_seconds, format: job.result.format } }
    }
    const result = await pollAvatar(client, job.job_id)
    return { type: 'avatar', data: { video_url: result.result!.video_url, duration: result.result!.duration_seconds, format: result.result!.format } }
  },
}

async function pollAvatar(client: TCloudClient, jobId: string, timeoutMs = 300_000): Promise<AvatarJobStatus> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const status = await client.avatarJobStatus(jobId)
    if (status.status === 'completed') return status
    if (status.status === 'failed') throw new Error(status.error || `Avatar job ${jobId} failed`)
    await new Promise(r => setTimeout(r, 5000))
  }
  throw new Error(`Avatar job ${jobId} timed out after ${timeoutMs}ms`)
}

const rerankCapability: CapabilityHandler = {
  name: 'rerank',
  description: 'Rerank documents by relevance to a query',
  schema: {
    query: { type: 'string', required: true },
    documents: { type: 'array', items: { type: 'string' }, required: true },
    top_n: { type: 'number' },
    model: { type: 'string' },
  },
  async execute(input, client) {
    const result = await client.rerank({
      query: input.query,
      documents: input.documents,
      top_n: input.top_n,
      model: input.model,
    })
    return { type: 'rerank', data: { results: result.results } }
  },
}

// ── Provider ──

export class TangleToolProvider {
  private capabilities = new Map<string, CapabilityHandler>()

  constructor(private client: TCloudClient) {
    this.register(chatCapability)
    this.register(embedCapability)
    this.register(speechCapability)
    this.register(transcribeCapability)
    this.register(imageCapability)
    this.register(videoCapability)
    this.register(avatarCapability)
    this.register(rerankCapability)
  }

  register(handler: CapabilityHandler) {
    this.capabilities.set(handler.name, handler)
  }

  async execute(capability: string, input: unknown): Promise<ToolResult> {
    const handler = this.capabilities.get(capability)
    if (!handler) {
      throw new Error(`Unknown capability: ${capability}. Available: ${this.listCapabilities().join(', ')}`)
    }
    return handler.execute(input, this.client)
  }

  listCapabilities(): string[] {
    return [...this.capabilities.keys()]
  }

  getToolDefinition() {
    const caps = [...this.capabilities.values()]
    return {
      name: 'tangle',
      description: `Execute AI services on Tangle Network (paid via shielded credits). Capabilities: ${caps.map(c => `${c.name} (${c.description})`).join(', ')}`,
      parameters: {
        capability: { type: 'string' as const, enum: this.listCapabilities() },
        input: { type: 'object' as const, description: 'Capability-specific parameters' },
      },
    }
  }
}
