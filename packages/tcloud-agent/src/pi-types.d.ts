declare module '@mariozechner/pi-coding-agent' {
  interface ExtensionContext {
    hasUI: boolean
    sessionManager: {
      getSessionId(): string
    }
    ui: {
      setWidget(id: string, widget: ExtensionWidget | undefined): void
    }
  }

  interface ExtensionWidget {
    title: string
    content: string | string[]
    style?: string
  }

  type ExtensionHandler<Event, Result = void> = (
    event: Event,
    context: ExtensionContext,
  ) => Result | Promise<Result>

  interface ToolResult {
    details: unknown
    content: Array<{ type: 'text'; text: string }>
    isError?: boolean
  }

  interface ToolDefinition<TParams extends import('@sinclair/typebox').TSchema> {
    name: string
    label: string
    description: string
    parameters: TParams
    execute(
      toolCallId: string,
      params: import('@sinclair/typebox').Static<TParams>,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      context: ExtensionContext,
    ): Promise<ToolResult>
  }

  interface ExtensionAPI {
    on(
      event: 'session_start' | 'session_shutdown',
      handler: ExtensionHandler<Record<string, never>>,
    ): void
    on(
      event: 'before_agent_start',
      handler: ExtensionHandler<{ systemPrompt: string }, { systemPrompt: string } | void>,
    ): void
    registerTool<TParams extends import('@sinclair/typebox').TSchema>(tool: ToolDefinition<TParams>): void
  }
}
