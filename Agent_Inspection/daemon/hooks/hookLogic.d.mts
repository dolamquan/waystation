export declare const INSTRUCTION_PREFIX: string;
export declare const DENY_PREFIX: string;
export declare const SAFE_ID: RegExp;
export type HookDecision =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string }
  | { behavior: 'ask' };
export declare function buildPreToolUseOutput(decision: HookDecision): {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'allow' | 'deny' | 'ask';
    permissionDecisionReason: string;
    updatedInput?: Record<string, unknown>;
  };
};
export declare function formatInstructions(instructions: string[]): string;
export declare function buildStopOutput(instructions: string[]): { decision: 'block'; reason: string } | undefined;
export declare function buildContextOutput(
  eventName: string,
  instructions: string[],
): { hookSpecificOutput: { hookEventName: string; additionalContext: string } } | undefined;
export declare function inboxDir(towerHome: string, sessionId: string): string;
export declare function interceptFlagPath(towerHome: string, sessionId: string): string;
export declare function isIntercepting(towerHome: string, sessionId: string): boolean;
export declare function claimInbox(towerHome: string, sessionId: string): { instructions: string[]; commit: () => void };
export declare function takeInbox(towerHome: string, sessionId: string): string[];
export declare function readDaemonInfo(towerHome: string): { port: number; token: string } | undefined;
