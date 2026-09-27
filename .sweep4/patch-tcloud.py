from pathlib import Path
import json

def replace(text, old, new, count=1):
    actual = text.count(old)
    if actual != count:
        raise RuntimeError(f'Expected {count} occurrences, got {actual}: {old[:100]}')
    return text.replace(old, new)

path = Path('packages/tcloud/src/client.ts')
s = path.read_text()
s = replace(s, "    headers: { 'Content-Type': 'application/json' },\n    body: JSON.stringify({\n      target: url,", "    headers: { 'Content-Type': 'application/json' },\n    signal: init.signal,\n    body: JSON.stringify({\n      target: url,")
helper = '''/** A retry wait owned by the SDK, cancellable without leaving a timer behind. */
function retryDelay(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
}

/** Absent, malformed, negative and infinite amounts are not a zero-cost receipt. */
function nonnegativeAmount(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined
  if (typeof value !== 'number' && typeof value !== 'string') return undefined
  if (typeof value === 'string' && value.trim() === '') return undefined
  const amount = Number(value)
  return Number.isFinite(amount) && amount >= 0 ? amount : undefined
}

'''
s = replace(s, 'const DEFAULT_RETRY: Required<RetryConfig> = {', helper + 'const DEFAULT_RETRY: Required<RetryConfig> = {')
s = replace(s, '    for (let attempt = 0; attempt < maxAttempts; attempt++) {\n      const controller', '    for (let attempt = 0; attempt < maxAttempts; attempt++) {\n      init.signal?.throwIfAborted()\n      const controller')
s = replace(s, '          signal: controller.signal,', '          signal: init.signal\n            ? AbortSignal.any([init.signal, controller.signal])\n            : controller.signal,')
s = replace(s, '          await new Promise(r => setTimeout(r, backoff + jitter))', '          await res.body?.cancel().catch(() => {})\n          await retryDelay(backoff + jitter, init.signal)')
s = replace(s, '      } catch (e: any) {\n        if (e instanceof TCloudError) throw e', '      } catch (e: any) {\n        // Caller cancellation is not a timeout and must never start another attempt.\n        init.signal?.throwIfAborted()\n        if (e instanceof TCloudError) throw e')
s = replace(s, '          await new Promise(r => setTimeout(r, backoff))', '          await retryDelay(backoff, init.signal)')
s = replace(s, '  async chat(options: ChatOptions): Promise<ChatCompletion> {\n    this.checkLimits()', '  async chat(options: ChatOptions): Promise<ChatCompletion> {\n    options.signal?.throwIfAborted()\n    this.checkLimits()')
s = replace(s, '      body: this._chatBody(options, false),', '      body: this._chatBody(options, false),\n      signal: options.signal,')
s = replace(s, '      body: this._chatBody(options, true),', '      body: this._chatBody(options, true),\n      signal: options.signal,')
search_start = s.index('  async search(options: SearchOptions)')
search_end = s.index('\n  }', search_start)
section = s[search_start:search_end]
section = replace(section, "      method: 'POST',", "      method: 'POST',\n      signal: options.signal,")
s = s[:search_start] + section + s[search_end:]
old = '''      const inputPrice = res ? parseFloat(res.headers.get('x-tangle-price-input') || '0') : 0
      const outputPrice = res ? parseFloat(res.headers.get('x-tangle-price-output') || '0') : 0

      if (inputPrice > 0 || outputPrice > 0) {
        estimatedCost = (completion.usage.prompt_tokens || 0) * inputPrice
          + (completion.usage.completion_tokens || 0) * outputPrice
      } else {'''
new = '''      const inputPrice = nonnegativeAmount(res?.headers.get('x-tangle-price-input'))
      const outputPrice = nonnegativeAmount(res?.headers.get('x-tangle-price-output'))
      const billed = nonnegativeAmount(res?.headers.get('x-tangle-cost-usd'))
        ?? nonnegativeAmount(completion.usage.billed_cost)
        ?? nonnegativeAmount(completion.usage.cost)
      const inputTokens = nonnegativeAmount(completion.usage.prompt_tokens)
      const outputTokens = nonnegativeAmount(completion.usage.completion_tokens)

      if (billed !== undefined) {
        estimatedCost = billed
        completion.tangle = { costUsd: billed, costSource: 'receipt' }
      } else if (inputPrice !== undefined && outputPrice !== undefined
        && inputTokens !== undefined && outputTokens !== undefined) {
        estimatedCost = inputTokens * inputPrice + outputTokens * outputPrice
        completion.tangle = { costUsd: estimatedCost, costSource: 'rates' }
      } else {'''
s = replace(s, old, new)
path.write_text(s)
path = Path('packages/tcloud/src/types.ts')
s = path.read_text()
s = replace(s, 'export interface SearchOptions {\n', 'export interface SearchOptions {\n  /** Cancel transport, response-body reads and retry waits. Never serialized. */\n  signal?: AbortSignal\n')
s = replace(s, 'export interface ChatOptions {\n', 'export interface ChatOptions {\n  /** Cancel transport, response-body reads and retry waits. Never serialized. */\n  signal?: AbortSignal\n')
s = replace(s, 'export interface ChatCompletion {\n', "export interface ChatCompletion {\n  /** SDK receipt for this response only. Absent when cost is only guessed. */\n  tangle?: { costUsd: number; costSource: 'receipt' | 'rates' }\n")
a = s.index('export interface ChatCompletion {')
b = s.index('export interface ChatCompletionChunk', a)
section = s[a:b]
section = replace(section, '    total_tokens: number\n', '    total_tokens: number\n    billed_cost?: number\n    cost?: number\n')
s = s[:a] + section + s[b:]
path.write_text(s)
for directory, version in [('tcloud', '0.6.0'), ('tcloud-agent', '0.5.0')]:
    path = Path('packages') / directory / 'package.json'
    p = json.loads(path.read_text())
    p['version'] = version
    p['dependencies']['@tangle-network/sandbox'] = '>=0.54.2 <0.55.0'
    path.write_text(json.dumps(p, indent=2) + '\n')
Path('packages/tcloud/CHANGELOG.md').write_text('''# Changelog

## 0.6.0

- Forward chat, streaming-chat and search cancellation to the actual HTTP transport and response body. Abort retry waits without another attempt. Preserve cancellation through the relayer.
- Expose per-response `tangle.costUsd` with a receipt/rates source. Never label the legacy aggregate fallback estimate as a reported cost. This avoids concurrent-call accounting races in consumers.
- Move the SDK and Pi package to the published Sandbox 0.54 line. No Sandbox REST facade or agent-runner consolidation is included.
- Retain the Pi raw-HTTP deletion already merged in #58.

Knowledge's transport migration must install this published release before it can use these APIs. A packed candidate is only a pre-release build check, not a registry publication.
''')
