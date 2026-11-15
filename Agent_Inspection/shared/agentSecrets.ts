export interface AgentSecret {
  id: string; name: string; kind: 'api-key' | 'authorization' | 'password'; scope: 'workspace' | 'project'; project?: string;
  hasValue: boolean; createdAt: number; usages: string[]; legacy?: boolean;
}
