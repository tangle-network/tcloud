/**
 * tcloud-agent — Private AI Agent with operator rotation
 *
 * ```ts
 * import { PrivateAgent } from 'tcloud-agent'
 *
 * const agent = new PrivateAgent({
 *   apiUrl: 'https://router.tangle.tools/v1',
 *   routing: { strategy: 'min-exposure' },
 * })
 * await agent.init()
 *
 * const response = await agent.chat('Hello privately')
 * console.log(agent.getPrivacyStats())
 * ```
 */

export { PrivateAgent, type PrivateAgentConfig, type ConversationMessage } from './agent'
export { PrivateRouter, type PrivateRouterConfig, type OperatorInfo, type RoutingStrategy } from './private-router'
export { TangleToolProvider, type CapabilityHandler, type ToolResult } from './tool-provider'
