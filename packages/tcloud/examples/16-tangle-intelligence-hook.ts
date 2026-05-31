/**
 * Hook your tcloud inference into Tangle Intelligence — one clean block.
 *
 * tcloud routes your inference; Tangle Intelligence turns the resulting
 * traces into insights (failure correlations with p-values, latency
 * percentiles, an agent-eval quality report). The integration is one
 * POST: shape each call as an OTel span and send it to the hosted
 * ingest with your sk-tan-* key. No sandbox required.
 *
 * Read insights back from the dashboard or `GET /v1/insights/outputs`
 * with the same key. Tenant resolves from the key, never the payload.
 *
 * Run: TANGLE_API_KEY=sk-tan-... npx tsx examples/16-tangle-intelligence-hook.ts
 */
import { TCloud } from 'tcloud'

const API_KEY = process.env.TANGLE_API_KEY ?? process.env.TCLOUD_API_KEY ?? 'sk-tan-...'
const INTELLIGENCE_OTLP_URL =
  process.env.INTELLIGENCE_OTLP_URL ??
  'https://intelligence.tangle.tools/v1/otlp/v1/traces'

// ── The universal one-block hook ─────────────────────────────────────
// Any OTel-shaped spans → your tenant's intelligence pipeline.
async function sendTracesToTangle(spans: OtlpSpan[], serviceName = 'tcloud-app') {
  const res = await fetch(INTELLIGENCE_OTLP_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      resourceSpans: [
        {
          resource: { attributes: [{ key: 'service.name', value: { stringValue: serviceName } }] },
          scopeSpans: [{ scope: { name: 'tcloud' }, spans }],
        },
      ],
    }),
  })
  if (!res.ok) throw new Error(`intelligence ingest failed: ${res.status} ${await res.text()}`)
}

// Run inference through tcloud, time it, and trace it to intelligence.
const client = new TCloud({ apiKey: API_KEY, model: 'gpt-4o-mini' })

const startNano = BigInt(Date.now()) * 1_000_000n
const t0 = performance.now()
let failed = false
let answer = ''
try {
  answer = await client.ask('Summarize the Tangle Network in one sentence.')
} catch (err) {
  failed = true
  answer = err instanceof Error ? err.message : String(err)
}
const durationMs = Math.round(performance.now() - t0)

await sendTracesToTangle([
  span('trace-tcloud-0001', 'llm.call', startNano, durationMs, [
    { key: 'llm.model', value: { stringValue: 'gpt-4o-mini' } },
    // Tokens/score are optional — add them when you have them. The engine
    // computes a quality report only when spans carry a `score` (0..1).
    ...(failed ? [{ key: 'error.type', value: { stringValue: 'InferenceError' } }] : []),
  ], failed ? 'ERROR' : 'OK'),
])

console.log(answer)
console.log('Traced to Tangle Intelligence. See GET /v1/insights/outputs?kind=report')

// ── Minimal OTLP span helper (self-contained) ────────────────────────
type OtlpAttr = { key: string; value: Record<string, unknown> }
interface OtlpSpan {
  traceId: string
  spanId: string
  name: string
  startTimeUnixNano: string
  endTimeUnixNano: string
  attributes: OtlpAttr[]
  status: { code: string }
}
let spanCounter = 0
function span(
  traceId: string,
  name: string,
  start: bigint,
  durationMs: number,
  attributes: OtlpAttr[],
  status: 'OK' | 'ERROR' = 'OK',
): OtlpSpan {
  spanCounter += 1
  return {
    traceId,
    spanId: `span${String(spanCounter).padStart(12, '0')}`,
    name,
    startTimeUnixNano: String(start),
    endTimeUnixNano: String(start + BigInt(durationMs) * 1_000_000n),
    attributes,
    status: { code: status === 'ERROR' ? 'STATUS_CODE_ERROR' : 'STATUS_CODE_OK' },
  }
}
