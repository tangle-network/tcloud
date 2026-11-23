import { defineService, TCloudError } from './client-service'
import type {
  ImageEditAttachment,
  ImageEditOptions,
  ImageGenerateOptions,
  ImageResponse,
  TranscriptionResponse,
  FineTuningJobOptions,
  FineTuningJob,
  BatchRequest,
  BatchJobResponse,
  VideoGenerateOptions,
  VideoResponse,
  AvatarGenerateRequest,
  AvatarGenerateResponse,
  AvatarJobStatus,
  JobEvent,
  WatchJobOptions,
} from './types'

export const mediaMethods = defineService({
  /** Generate images */
  async imageGenerate(options: ImageGenerateOptions): Promise<ImageResponse> {
    return this._request(`${this.baseURL}/images/generations`, {
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
  },

  /**
   * Edit / inpaint / variate an existing image with a text prompt.
   * Sibling to `imageGenerate`; routes to `/v1/images/edits` via
   * multipart/form-data per the OpenAI spec.
   *
   * Reference image attachments may be passed as `Blob`, `ArrayBuffer`,
   * or `{data: base64, mediaType, filename?}`. Multi-image composition
   * (e.g. gpt-image-2 with two reference frames + a prompt that fuses
   * them) is supported by passing an array; for legacy models only the
   * first image is honored upstream.
   */
  async imagesEdit(options: ImageEditOptions): Promise<ImageResponse> {
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

    return this._requestMultipart(`${this.baseURL}/images/edits`, formData)
  },

  /** Text-to-speech */
  async speech(options: { model?: string; input: string; voice?: string }): Promise<ArrayBuffer> {
    const res = await this._requestRaw(`${this.baseURL}/audio/speech`, {
      method: 'POST',
      body: JSON.stringify({
        model: options.model || 'tts-1',
        input: options.input,
        voice: options.voice || 'alloy',
      }),
    })
    return res.arrayBuffer()
  },

  /** Audio transcription (speech-to-text) */
  async transcribe(file: Blob, options?: { model?: string; language?: string; prompt?: string }): Promise<TranscriptionResponse> {
    const formData = new FormData()
    formData.append('file', file, 'audio.webm')
    formData.append('model', options?.model || 'whisper-1')
    if (options?.language) formData.append('language', options.language)
    if (options?.prompt) formData.append('prompt', options.prompt)

    return this._requestMultipart(`${this.baseURL}/audio/transcriptions`, formData)
  },

  /** Create a fine-tuning job */
  async fineTuneCreate(options: FineTuningJobOptions): Promise<FineTuningJob> {
    return this._request(`${this.baseURL}/fine_tuning/jobs`, {
      method: 'POST',
      body: JSON.stringify(options),
    })
  },

  /** List fine-tuning jobs */
  async fineTuneList(): Promise<{ data: FineTuningJob[] }> {
    return this._fetch(`${this.baseURL}/fine_tuning/jobs`)
  },

  /** Submit a batch of chat requests */
  async batch(requests: BatchRequest[]): Promise<BatchJobResponse> {
    return this._request(`${this.baseURL}/batch`, {
      method: 'POST',
      body: JSON.stringify({ requests }),
    })
  },

  /** Get batch job status */
  async batchStatus(jobId: string): Promise<BatchJobResponse> {
    return this._fetch(`${this.baseURL}/batch?id=${jobId}`)
  },

  /** Generate video */
  async videoGenerate(options: VideoGenerateOptions): Promise<VideoResponse> {
    return this._request(`${this.baseURL}/videos`, {
      method: 'POST',
      body: JSON.stringify(options),
    })
  },

  /** Get video generation status */
  async videoStatus(id: string): Promise<VideoResponse> {
    return this._fetch(`${this.baseURL}/videos/${encodeURIComponent(id)}`)
  },

  /** Generate an avatar video (lip-synced talking head from audio + face image).
   *  Returns 202 with a job_id for async polling via avatarJobStatus(). */
  async avatarGenerate(options: AvatarGenerateRequest): Promise<AvatarGenerateResponse> {
    return this._request(`${this.baseURL}/avatar/generate`, {
      method: 'POST',
      body: JSON.stringify(options),
    })
  },

  /** Poll an avatar generation job by ID. */
  async avatarJobStatus(jobId: string): Promise<AvatarJobStatus> {
    return this._fetch(`${this.baseURL}/avatar/jobs/${jobId}`)
  },

  /** Poll an avatar job until it reaches a terminal state (completed/failed).
   *  Returns the final job status. Throws on failure. */
  async pollAvatarJob(jobId: string, options?: { intervalMs?: number; timeoutMs?: number }): Promise<AvatarJobStatus> {
    const interval = options?.intervalMs ?? 5000
    const timeout = options?.timeoutMs ?? 300_000
    const deadline = Date.now() + timeout

    while (Date.now() < deadline) {
      const job = await this.avatarJobStatus(jobId)
      if (job.status === 'completed') return job
      if (job.status === 'failed') {
        throw new TCloudError(500, job.error || `Avatar job ${jobId} failed`)
      }
      await new Promise(r => setTimeout(r, interval))
    }
    throw new TCloudError(408, `Avatar job ${jobId} timed out after ${timeout}ms`)
  },

  /**
   * Watch an async job via SSE until it reaches a terminal state.
   * Works with avatar, video, and training blueprint operators.
   *
   * @param jobId - The job ID returned by the creation endpoint
   * @param options - Optional: operatorUrl override, onEvent callback
   * @returns The final JobEvent (completed/failed/cancelled)
   */
  async watchJob(jobId: string, options?: WatchJobOptions): Promise<JobEvent> {
    const base = options?.operatorUrl?.replace(/\/$/, '') || this.baseURL
    const url = `${base}/v1/jobs/${encodeURIComponent(jobId)}/events`
    const timeout = options?.timeout ?? 300_000

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)

    try {
      const watchHeaders: Record<string, string> = {
        ...this.headers,
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

      const res = await this._proxiedFetch(url, {
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
  },
})

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
