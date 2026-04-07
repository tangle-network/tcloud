# Design: Multimodal Agent Tools for Tangle

## Problem

The `tcloud-agent` currently only does chat (text in → text out). Agents need to generate images, synthesize speech, transcribe audio, create avatars, generate video, run embeddings, fine-tune models — all paid via shielded credits through the Tangle router. And as new blueprints are added (music gen, RAG, code gen, etc.), the tool interface shouldn't need to change.

## Design: Capability-Based Tool Registry

Instead of one tool per service, expose a **single `tangle` tool** with a `capability` parameter. The tool discovers available capabilities from the router at init time, so new blueprints are automatically available without code changes.

```typescript
// The agent sees ONE tool with dynamic capabilities:
{
  name: "tangle",
  description: "Execute AI services on Tangle Network (paid via shielded credits)",
  parameters: {
    capability: {
      type: "string",
      enum: ["chat", "embed", "speech", "transcribe", "image", "video", "avatar", "rerank", "fine_tune", "rag"],
      description: "Which AI capability to invoke"
    },
    input: {
      type: "object",
      description: "Capability-specific input (varies by capability)"
    }
  }
}
```

### Why one tool, not many

1. **LLM context efficiency** — one tool definition vs 10+ separate tool schemas
2. **Extensible** — new capabilities added at runtime from the router's model catalog, not hardcoded
3. **Unified billing** — same SpendAuth flow for all capabilities
4. **Composable** — agent can chain: transcribe audio → summarize text → generate image → synthesize narration

### Capability Schemas (the `input` parameter)

```typescript
// Discovered from router at init, not hardcoded
const CAPABILITY_SCHEMAS = {
  chat: { messages: Message[], model?: string, max_tokens?: number },
  embed: { input: string[], model?: string },
  speech: { input: string, voice?: string, model?: string },
  transcribe: { audio: string /* base64 or URL */, language?: string },
  image: { prompt: string, size?: string, n?: number, model?: string },
  video: { prompt?: string, image_url?: string, duration?: number },
  avatar: { audio_url: string, image_url?: string, avatar_id?: string, duration?: number },
  rerank: { query: string, documents: string[], model?: string },
  fine_tune: { training_file: string, model: string, hyperparams?: object },
  rag: { query: string, collection: string, top_k?: number },
}
```

### The Runtime Flow

```
Agent decides "I need an image" →
  calls tangle({ capability: "image", input: { prompt: "...", size: "1024x1024" } }) →
    TangleToolProvider:
      1. Looks up "image" in capability registry
      2. Finds operators serving image-gen via router
      3. Signs SpendAuth with shielded wallet
      4. POST /v1/images/generations to selected operator
      5. Returns result to agent
```

## Implementation

### `TangleToolProvider` — the core abstraction

```typescript
export class TangleToolProvider {
  private client: TCloudClient
  private wallet: ShieldedWallet
  private capabilities: Map<string, CapabilityHandler>

  constructor(config: { apiUrl: string, wallet: ShieldedWallet }) {
    this.client = new TCloudClient(config)
    this.wallet = config.wallet
    this.capabilities = new Map()
    
    // Register built-in capabilities
    this.register('chat', new ChatCapability(this.client))
    this.register('embed', new EmbedCapability(this.client))
    this.register('speech', new SpeechCapability(this.client))
    this.register('transcribe', new TranscribeCapability(this.client))
    this.register('image', new ImageCapability(this.client))
    this.register('video', new VideoCapability(this.client))
    this.register('avatar', new AvatarCapability(this.client))
    this.register('rerank', new RerankCapability(this.client))
    this.register('fine_tune', new FineTuneCapability(this.client))
  }

  /** Discover capabilities from router (for dynamic registration) */
  async discover(): Promise<string[]> {
    const models = await this.client.models()
    // Group models by capability type
    // Auto-register any new capabilities found
    return [...this.capabilities.keys()]
  }

  /** Execute a capability */
  async execute(capability: string, input: any): Promise<ToolResult> {
    const handler = this.capabilities.get(capability)
    if (!handler) throw new Error(`Unknown capability: ${capability}`)
    return handler.execute(input, this.wallet)
  }

  /** Get tool definition for LLM */
  getToolDefinition(): ToolDefinition {
    return {
      name: 'tangle',
      description: `Execute AI services on Tangle Network. Available: ${[...this.capabilities.keys()].join(', ')}`,
      parameters: {
        type: 'object',
        properties: {
          capability: {
            type: 'string',
            enum: [...this.capabilities.keys()],
          },
          input: {
            type: 'object',
            description: 'Capability-specific parameters',
          },
        },
        required: ['capability', 'input'],
      },
    }
  }
}
```

### Each capability is a handler

```typescript
interface CapabilityHandler {
  execute(input: any, wallet: ShieldedWallet): Promise<ToolResult>
  schema(): object  // JSON Schema for the input parameter
}

class ImageCapability implements CapabilityHandler {
  constructor(private client: TCloudClient) {}

  async execute(input: { prompt: string, size?: string, n?: number }, wallet: ShieldedWallet) {
    const result = await this.client.imageGenerate({
      prompt: input.prompt,
      size: input.size || '1024x1024',
      n: input.n || 1,
    })
    return {
      type: 'image' as const,
      urls: result.data.map(d => d.url),
      model: result.model,
      cost: result.usage?.total_cost,
    }
  }

  schema() {
    return {
      prompt: { type: 'string', description: 'Image description' },
      size: { type: 'string', enum: ['256x256', '512x512', '1024x1024'] },
      n: { type: 'number', description: 'Number of images (1-4)' },
    }
  }
}
```

### Pi Agent Extension

```typescript
// pi-tangle-tools extension
export default function tangleToolsExtension(pi: ExtensionAPI) {
  let provider: TangleToolProvider | null = null

  pi.on('session_start', async (_event, ctx) => {
    provider = new TangleToolProvider({
      apiUrl: process.env.TANGLE_API_URL || 'https://router.tangle.tools/v1',
      wallet: await loadOrCreateWallet(),
    })
    await provider.discover()
  })

  // Register as a tool the agent can call
  pi.registerTool({
    ...provider.getToolDefinition(),
    handler: async (args: { capability: string, input: any }) => {
      return provider.execute(args.capability, args.input)
    },
  })
}
```

### Claude Code Skill (alternative integration point)

```markdown
# Tangle AI Services

When the agent needs non-text AI (images, speech, video, avatars, embeddings):

1. Use the `tangle` tool with the appropriate capability
2. Available capabilities: chat, embed, speech, transcribe, image, video, avatar, rerank
3. Each capability has its own input schema (see tool definition)
4. All services are paid via shielded credits — the tool handles billing automatically
```

## On LiteLLM / RAG

### Should we build a RAG blueprint?

**Yes, but not as a monolithic "RAG service".** RAG is a composition of existing capabilities:
1. **Embed** (embedding-inference-blueprint) — vectorize documents
2. **Store** (new: vector-store-blueprint) — persist + search vectors
3. **Chat** (llm-inference-blueprint) — generate answers with retrieved context

The missing piece is the **vector store** — ChromaDB, Qdrant, Weaviate, or pgvector as a blueprint service. The RAG orchestration happens client-side (in tcloud SDK or the agent), not server-side.

```
Agent: "What does our API doc say about rate limits?"
  → tangle({ capability: "rag", input: { query: "rate limits", collection: "api-docs" } })
    → SDK orchestrates:
      1. embed(query) → vector
      2. vector_store.search(vector, collection, top_k=5) → chunks
      3. chat(messages=[{system: "Answer using these chunks: ...", user: query}]) → answer
```

### What about LiteLLM features?

LiteLLM is a proxy that normalizes 100+ LLM providers into the OpenAI API. The Tangle router already does this — every inference blueprint exposes OpenAI-compatible endpoints. Adding LiteLLM-specific features (caching, budget tracking, fallbacks) would make sense as **router-level middleware**, not as a new blueprint.

Features worth adding to the Tangle router (not as blueprints):
- **Semantic caching** — cache embeddings of queries, serve cached results for similar queries
- **Budget enforcement** — per-API-key spending limits (already partially exists)
- **Fallback chains** — if operator A fails, try operator B (already in tcloud SDK routing)
- **Usage analytics** — track tokens/cost per user/key (router-level concern)

### What WOULD be new blueprints

| Blueprint | What it does | Why it's a service, not middleware |
|---|---|---|
| **vector-store-blueprint** | Hosted Qdrant/ChromaDB — CRUD vectors, similarity search | Stateful, needs persistent storage, GPU for large-scale ANN |
| **code-gen-blueprint** | Sandboxed code execution (like Code Interpreter) | Needs isolation, filesystem, package management |
| **music-gen-blueprint** | Text-to-music via MusicGen/Stable Audio | Different pricing model (per-second), GPU-heavy |
| **stt-blueprint** (standalone) | Dedicated Whisper service (already in voice as optional) | Only if demand for standalone STT without TTS |

## Extensibility: How New Blueprints Become Tools Automatically

The key design: **the router's model catalog is the source of truth for available capabilities.** When a new blueprint registers operators, the router lists their models. The `TangleToolProvider.discover()` method queries the router, maps models to capabilities, and registers handlers dynamically.

New blueprint deployed → operators register → router lists models → agent's next `discover()` picks them up → agent can use them. Zero code changes in the tool provider.

The only thing that requires a code change is adding a new `CapabilityHandler` class for a genuinely new modality (e.g., 3D model generation). But for new models within existing modalities (new LLM, new TTS voice, new image model), it's automatic.
