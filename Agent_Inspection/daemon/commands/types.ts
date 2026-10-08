import type { SwitchableMode } from '../../shared/claudeCommands.ts';

export interface ControlModel { readonly value: string; readonly displayName: string; readonly description: string }
export interface ControlMcpServer { readonly name: string; readonly status: string; readonly scope?: string; readonly error?: string }
export interface ControlContext {
  readonly totalTokens: number;
  readonly maxTokens: number;
  readonly percentage: number;
  readonly categories: readonly { readonly name: string; readonly tokens: number }[];
}
export interface ControlAgentType { readonly name: string; readonly description: string }
export interface ControlAccount { readonly subscriptionType?: string; readonly organization?: string; readonly apiProvider?: string }

/** Live controls of a Claude agent launched from Waystation (Claude Agent SDK). Sessions elsewhere have none. */
export interface ClaudeControl {
  readonly mode?: string;
  readonly version?: string;
  readonly currentModel?: string;
  models(): Promise<ControlModel[]>;
  setModel(model: string): Promise<void>;
  mcpStatus(): Promise<ControlMcpServer[]>;
  mcpReconnect(name: string): Promise<void>;
  mcpToggle(name: string, enabled: boolean): Promise<void>;
  contextUsage(): Promise<ControlContext>;
  setPermissionMode(mode: SwitchableMode): Promise<void>;
  agentTypes(): Promise<ControlAgentType[]>;
  account(): Promise<ControlAccount>;
}

/** A command the operator can fix (bad argument, not possible for this agent). */
export class CommandError extends Error {}
