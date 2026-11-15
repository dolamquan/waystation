import type { CopilotClient, CopilotSession } from '@github/copilot-sdk';
import type { PlanLimit } from '../usage/windowTypes.ts';

/** Account/model calls never send a prompt. Credential material stays inside the SDK's auth store. */
export class CopilotAccount {
  private client?: CopilotClient;
  private starting?: Promise<CopilotClient>;
  private cached?: { at: number; value: CopilotAccountView };
  private reading?: Promise<CopilotAccountView>;
  private flowId?: string;
  private authSession?: CopilotSession;
  private async connection(): Promise<CopilotClient> {
    if (this.client) return this.client;
    return this.starting ??= (async () => {
      const { CopilotClient } = await import('@github/copilot-sdk');
      const client = new CopilotClient({ logLevel: 'error' });
      try { await client.start(); this.client = client; return client; }
      catch (error) { await client.stop().catch(() => undefined); throw error; }
      finally { this.starting = undefined; }
    })();
  }
  async read(refresh = false): Promise<CopilotAccountView> {
    if (!refresh && this.cached && Date.now() - this.cached.at < 60_000) return this.cached.value;
    return this.reading ??= this.load().finally(() => { this.reading = undefined; });
  }
  private async load(): Promise<CopilotAccountView> {
    let value: CopilotAccountView;
    try {
      const client = await this.connection();
      const auth = await client.getAuthStatus();
      if (!auth.isAuthenticated) value = { authenticated: false, limits: [], models: [], message: 'Sign in to GitHub Copilot to launch agents and read account usage.' };
      else {
        const [quota, models] = await Promise.allSettled([client.rpc.account.getQuota({}), client.listModels()]);
        const limits: PlanLimit[] = quota.status === 'fulfilled' ? Object.entries(quota.value.quotaSnapshots).flatMap(([key, snapshot]) => {
          if (!snapshot || snapshot.isUnlimitedEntitlement) return [];
          const reset = snapshot.resetDate ? Date.parse(snapshot.resetDate) : NaN;
          return [{ window: key, label: key.replaceAll('_', ' '), usedPercent: Number.isFinite(snapshot.remainingPercentage) ? Math.min(100, Math.max(0, 100 - snapshot.remainingPercentage)) : undefined,
            resetsAt: Number.isFinite(reset) ? reset : undefined, observedAt: Date.now(), source: 'copilot' as const }];
        }) : [];
        value = { authenticated: true, limits,
          models: models.status === 'fulfilled' ? models.value.filter(model => model.policy?.state !== 'disabled').map(model => ({ id: model.id, label: model.name })) : [],
          message: quota.status === 'rejected' ? 'Signed in. Account allowance could not be read; session token usage is still recorded.' : limits.length ? undefined : 'Signed in. No limited account allowance was reported.' };
      }
    } catch (error) { value = { authenticated: false, limits: [], models: [], message: `Copilot could not connect: ${(error as Error).message}` }; }
    this.cached = { at: Date.now(), value }; return value;
  }
  async beginLogin() {
    const client = await this.connection();
    if (this.flowId && this.authSession) await this.authSession.rpc.accounts.login.cancel({ flowId: this.flowId });
    // The SDK exposes browser sign-in through a session RPC. No prompt is sent and all tools are disabled.
    this.authSession ??= await client.createSession({ availableTools: [], onPermissionRequest: () => ({ kind: 'reject' }) });
    const result = await this.authSession.rpc.accounts.login.begin({ kind: 'githubDotCom' });
    this.flowId = result.flowId;
    return result;
  }
  async advanceLogin(flowId: string, input?: string) {
    if (flowId !== this.flowId) throw new Error('This sign-in flow is no longer active.');
    if (!this.authSession) throw new Error('Start Copilot sign-in again.');
    const result = await this.authSession.rpc.accounts.login.advance({ flowId, input });
    if (result.kind === 'completed' || result.kind === 'error') { this.flowId = undefined; this.cached = undefined; }
    return result;
  }
  async cancelLogin(flowId: string) {
    if (flowId !== this.flowId) return;
    await this.authSession?.rpc.accounts.login.cancel({ flowId }); this.flowId = undefined;
  }
  async stop(): Promise<void> { if (this.starting) await this.starting.catch(() => undefined); await this.client?.stop(); this.client = undefined; }
}
export interface CopilotAccountView {
  readonly authenticated: boolean;
  readonly limits: readonly PlanLimit[];
  readonly models: readonly { readonly id: string; readonly label: string }[];
  readonly message?: string;
}
