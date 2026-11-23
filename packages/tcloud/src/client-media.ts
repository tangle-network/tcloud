/**
 * Media service group for {@link TCloudClient}: embeddings, images,
 * audio, fine-tuning, batch, video/avatar jobs and job event streams.
 * Internal module — the public surface is the client's methods.
 */

import type {
  AvatarGenerateRequest,
  AvatarGenerateResponse,
  AvatarJobStatus,
  BatchJobResponse,
  BatchRequest,
  EmbeddingOptions,
  EmbeddingResponse,
  FineTuningJob,
  FineTuningJobOptions,
  ImageEditAttachment,
  ImageEditOptions,
  ImageGenerateOptions,
  ImageResponse,
  JobEvent,
  TranscriptionResponse,
  VideoGenerateOptions,
  VideoResponse,
  WatchJobOptions,
} from './types'
import { TCloudError, proxiedFetch, type ClientContext } from './client-core'

export async function embeddings(ctx: ClientContext, options: EmbeddingOptions): Promise<EmbeddingResponse> {
  return ctx.request(`${ctx.baseURL}/embeddings`, {
    method: 'POST',
    body: JSON.stringify({
      model: options.model || 'text-embedding-3-small',
      input: options.input,
    }),
  })
}

export async function imageGenerate(ctx: ClientContext, options: ImageGenerateOptions): Promise<ImageResponse> {
  return ctx.request(`${ctx.baseURL}/images/generations`, {
    method: 'POST',
    body: JSON.stringify({
      model: options.model || 'dall-e-3',
      prompt: options.prompt,
      n: options.n,
      size: options.size,
      quality: options.quality,
      response_format: options.response_format,
    }),
  })
}

export async function imagesEdit(ctx: ClientContext, options: ImageEditOptions): Promise<ImageResponse> {
  const formData = new FormData()
  formData.append('prompt', options.prompt)
  formData.append('model', options.model || 'gpt-image-2')
  if (options.n != null) formData.append('n', String(options.n))
  if (options.size) formData.append('size', options.size)
  if (options.quality) formData.append('quality', options.quality)
  if (options.response_format) formData.append('response_format', options.response_format)
  if (options.mask) formData.append('mask', toEditBlob(options.mask, 'mask.png'), 'mask.png')

  const images = Array.isArray(options.image) ? options.image : [options.image]
  if (images.length === 0) {
    throw new TCloudError(400, 'imagesEdit requires at least one image attachment')
  }
  // Each upstream takes the field name differently — `image` for a
  // single-image variant (dall-e-2) and `image[]` for multi-image
  // composition (gpt-image-2). We always send `image[]`; upstream
  // implementations of the OpenAI shape accept both.
  images.forEach((img, idx) => {
    const blob = toEditBlob(img, `image-${idx + 1}.png`)
    formData.append('image[]', blob, blobFilename(img, `image-${idx + 1}.png`))
  })

  const headers = { ...ctx.headers }
  delete headers['Content-Type'] // let FormData set the boundary

  ctx.checkLimits()
  const res = await proxiedFetch(ctx.privacy, `${ctx.baseURL}/images/edits`, {
    method: 'POST',
    headers,
    body: formData as unknown as BodyInit,
  }, false)
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new TCloudError(res.status, err.error?.message || err.error || err.message || res.statusText)
  }
  ctx.countRequest()
  return res.json()
}

export async function speech(ctx: ClientContext, options: { model?: string; input: string; voice?: string }): Promise<ArrayBuffer> {
  const res = await ctx.requestRaw(`${ctx.baseURL}/audio/speech`, {
    method: 'POST',
    body: JSON.stringify({
      model: options.model || 'tts-1',
      input: options.input,
      voice: options.voice || 'alloy',
    }),
  })
  return res.arrayBuffer()
}

export async function transcribe(ctx: ClientContext, file: Blob, options?: { model?: string; language?: string; prompt?: string }): Promise<TranscriptionResponse> {
  const formData = new FormData()
  formData.append('file', file, 'audio.webm')
  formData.append('model', options?.model || 'whisper-1')
  if (options?.language) formData.append('language', options.language)
  if (options?.prompt) formData.append('prompt', options.prompt)

  const headers = { ...ctx.headers }
  delete headers['Content-Type'] // let FormData set it

  ctx.checkLimits()
  const res = await proxiedFetch(ctx.privacy, `${ctx.baseURL}/audio/transcriptions`, {
    method: 'POST',
    headers,
    body: formData as any,
  }, false)
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new TCloudError(res.status, err.error?.message || err.error || err.message || res.statusText)
  }
  ctx.countRequest()
  return res.json()
}

export async function fineTuneCreate(ctx: ClientContext, options: FineTuningJobOptions): Promise<FineTuningJob> {
  return ctx.request(`${ctx.baseURL}/fine_tuning/jobs`, {
    method: 'POST',
    body: JSON.stringify(options),
  })
}

export async function fineTuneList(ctx: ClientContext): Promise<{ data: FineTuningJob[] }> {
  return ctx.fetch(`${ctx.baseURL}/fine_tuning/jobs`)
}

export async function batch(ctx: ClientContext, requests: BatchRequest[]): Promise<BatchJobResponse> {
  return ctx.request(`${ctx.baseURL}/batch`, {
    method: 'POST',
    body: JSON.stringify({ requests }),
  })
}

export async function batchStatus(ctx: ClientContext, jobId: string): Promise<BatchJobResponse> {
  return ctx.fetch(`${ctx.baseURL}/batch?id=${jobId}`)
}

export async function videoGenerate(ctx: ClientContext, options: VideoGenerateOptions): Promise<VideoResponse> {
  return ctx.request(`${ctx.baseURL}/videos`, {
    method: 'POST',
    body: JSON.stringify(options),
  })
}

export async function videoStatus(ctx: ClientContext, id: string): Promise<VideoResponse> {
  return ctx.fetch(`${ctx.baseURL}/videos/${encodeURIComponent(id)}`)
}

export async function avatarGenerate(ctx: ClientContext, options: AvatarGenerateRequest): Promise<AvatarGenerateResponse> {
  return ctx.request(`${ctx.baseURL}/avatar/generate`, {
    method: 'POST',
    body: JSON.stringify(options),
  })
}

export async function avatarJobStatus(ctx: ClientContext, jobId: string): Promise<AvatarJobStatus> {
  return ctx.fetch(`${ctx.baseURL}/avatar/jobs/${jobId}`)
}

export async function pollAvatarJob(ctx: ClientContext, jobId: string, options?: { intervalMs?: number; timeoutMs?: number }): Promise<AvatarJobStatus> {
  const interval = options?.intervalMs ?? 5000
  const timeout = options?.timeoutMs ?? 300_000
  const deadline = Date.now() + timeout

  while (Date.now() < deadline) {
    const job = await avatarJobStatus(ctx, jobId)
    if (job.status === 'completed') return job
    if (job.status === 'failed') {
      throw new TCloudError(500, job.error || `Avatar job ${jobId} failed`)
    }
    await new Promise(r => setTimeout(r, interval))
  }
  throw new TCloudError(408, `Avatar job ${jobId} timed out after ${timeout}ms`)
}

export async function watchJob(ctx: ClientContext, jobId: string, options?: WatchJobOptions): Promise<JobEvent> {
  const base = options?.operatorUrl?.replace(/\/$/, '') || ctx.baseURL
  const url = `${base}/v1/jobs/${encodeURIComponent(jobId)}/events`
  const timeout = options?.timeout ?? 300_000

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)

  try {
    const watchHeaders: Record<string, string> = {
      ...ctx.headers,
      Accept: 'text/event-stream',
    }
    // When connecting to an operator URL, don't leak the API key.
    // The job ID itself is the capability token for operator auth.
    if (options?.operatorUrl) {
      delete watchHeaders['Authorization']
    }
    // SSE token overrides any existing Authorization header
    if (options?.sseToken) {
      watchHeaders['Authorization'] = `Bearer ${options.sseToken}`
    }

    const res = await proxiedFetch(ctx.privacy, url, {
      headers: watchHeaders,
      signal: controller.signal,
    }, true)

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }))
      throw new TCloudError(res.status, err.error?.message || err.error || res.statusText)
    }

    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    const terminalStatuses = new Set(['completed', 'failed', 'cancelled'])

    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        throw new TCloudError(502, `SSE stream ended without terminal event for job ${jobId}`)
      }
      buf += decoder.decode(value, { stream: true })
      if (buf.length > 1_048_576) throw new TCloudError(502, 'SSE buffer overflow — server sent >1MB without newline')

      const lines = buf.split('\n')
      buf = lines.pop() || ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6).trim()
        if (!data || data === '[DONE]') continue

        let event: JobEvent
        try {
          event = JSON.parse(data) as JobEvent
        } catch {
          continue
        }

        try {
          options?.onEvent?.(event)
        } catch (cbErr) {
          console.error('watchJob onEvent callback error:', cbErr)
        }

        if (terminalStatuses.has(event.status)) {
          return event
        }
      }
    }
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new TCloudError(408, `Job ${jobId} timed out after ${timeout}ms`)
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Normalize the polymorphic `ImageEditAttachment` to a `Blob` for
 * multipart FormData submission. Base64 inputs are decoded; raw
 * ArrayBuffers are wrapped with a sensible default media type (PNG).
 */
function toEditBlob(input: ImageEditAttachment, defaultFilename: string): Blob {
  if (input instanceof Blob) return input
  if (input instanceof ArrayBuffer) return new Blob([input], { type: 'image/png' })
  // {data: base64, mediaType, filename?}
  const binary = base64ToUint8Array(input.data)
  // `Uint8Array` is a valid BlobPart at the JS level. TS's narrower
  // `BodyInit` shape complains about the `ArrayBufferLike` generic in
  // some lib targets — copy to a fresh ArrayBuffer-backed view so the
  // type is unambiguous.
  const copy = new Uint8Array(binary.byteLength)
  copy.set(binary)
  return new Blob([copy.buffer], { type: input.mediaType || 'image/png' })
  void defaultFilename // referenced by blobFilename
}

/** Extract a stable filename for the upload (multipart needs one;
 *  upstream sometimes uses extension to sniff the format). */
function blobFilename(input: ImageEditAttachment, fallback: string): string {
  if (typeof input === 'object' && !(input instanceof Blob) && !(input instanceof ArrayBuffer)) {
    if (input.filename) return input.filename
  }
  return fallback
}

function base64ToUint8Array(b64: string): Uint8Array {
  // Strip data:URL prefix if present.
  const m = /^data:[^;,]*(?:;[^,]*)?,(.+)$/.exec(b64)
  const raw = m ? m[1] : b64
  // Node 18+ and modern browsers expose `atob`; on older Node `Buffer.from`
  // is the canonical decoder.
  const bin =
    typeof atob === 'function'
      ? atob(raw)
      : // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (globalThis as any).Buffer.from(raw, 'base64').toString('binary')
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
