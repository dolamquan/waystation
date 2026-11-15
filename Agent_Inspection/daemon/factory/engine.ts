import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import type { Agent, AgentEvent } from '../domain/types.ts';
import type { ManagedLaunch } from '../managed/types.ts';
import type { TowerStore } from '../store/db.ts';
import { UserError } from '../userError.ts';
import { FACTORY_ACTIVE, type FactoryDefinition, type FactoryItem, type FactoryRoleName, type FactoryStage, type FactoryStatus } from '../../shared/factory.ts';
import { bridgeInstructions, bridgeLaunch, FactoryBridgeAuthError, FactoryGrants, parseSubmission, renderSubmission, toolsFor, type McpTool } from './bridge.ts';
import { runFactoryCheck } from './checks.ts';
import { fields, parseFactoryDefinition, string } from './definition.ts';
import { guardsCandidate, nextStep, pipelineOf, stageForRole, stageRole, stageStatus, type FactoryEvent, type FactoryStep } from './pipeline.ts';
import { deliverFactoryWorkspace, diffWorktree, factoryWorkspaceMatches, prepareFactoryWorkspace, snapshotFactoryWorkspace } from './workspace.ts';

export { factoryDefaults } from './definition.ts';

export interface FactoryHost {
  launch(input: ManagedLaunch): Agent;
  agent(id: string): Agent | undefined;
  events(id: string): readonly AgentEvent[];
  stop(id: string): Promise<unknown>;
  /** Why a stage for this vendor and folder must wait (spend cap, plan window), or undefined to launch now. */
  gate?(vendor: string, cwd: string): Promise<string | undefined>;
}
/** How often a waiting stage asks the gate again. */
const GATE_RECHECK_MS = 30_000;
type FactoryStore = Pick<TowerStore, 'loadRecords' | 'saveRecord' | 'audit'>;
type FactoryCheckRunner = typeof runFactoryCheck;
const clone = <T>(value: T): T => structuredClone(value);
const capitalize = (text: string) => text[0].toUpperCase() + text.slice(1);

/** Owns the lifecycle. Agent completion cannot grant approval or produce check evidence. */
export class FactoryEngine {
  private factories = new Map<string, FactoryDefinition>();
  private items = new Map<string, FactoryItem>();
  private locked = new Set<string>();
  private operations = new Set<Promise<unknown>>();
  private checks = new Map<string, { controller: AbortController; task: Promise<void> }>();
  private timer?: NodeJS.Timeout;
  private closing = false;
  /** Daemon URL for the factory bridge; without it agents launch without structured submission. */
  private endpoint?: string;
  private readonly grants = new FactoryGrants();
  private readonly gateCheckedAt = new Map<string, number>();
  constructor(private readonly store: FactoryStore, private readonly host: FactoryHost, private readonly root: string, private readonly check: FactoryCheckRunner = runFactoryCheck) {
    for (const factory of store.loadRecords<FactoryDefinition>('factory_definitions')) this.factories.set(factory.id, factory);
    for (const saved of store.loadRecords<FactoryItem>('factory_items')) {
      this.items.set(saved.id, saved);
      if (FACTORY_ACTIVE.includes(saved.status)) {
        for (const attempt of saved.attempts) if (attempt.outcome === 'running') { attempt.outcome = 'interrupted'; attempt.finishedAt = Date.now(); }
        this.transition(saved, 'paused', 'Waystation restarted. Review the workspace, then resume explicitly.');
      }
    }
  }
  start() { if (!this.timer) this.timer = setInterval(() => { void this.tick(); }, 1000); }
  setEndpoint(endpoint: string | undefined) { this.endpoint = endpoint; }
  /** The running attempt a bridge token belongs to. Anything else is refused and its token revoked. */
  private grantedAttempt(token: string | undefined) {
    const grant = this.grants.find(token);
    if (!grant) throw new FactoryBridgeAuthError();
    const item = this.items.get(grant.itemId); const attempt = item?.attempts.at(-1);
    if (!item || !attempt || attempt.id !== grant.attemptId || attempt.outcome !== 'running') { this.grants.revoke(grant.attemptId); throw new FactoryBridgeAuthError(); }
    return { grant, item, attempt };
  }
  bridgeTools(token: string | undefined): McpTool[] { return toolsFor(this.grantedAttempt(token).grant.role); }
  /** Records an agent's structured stage result. Validation errors go back to the agent to correct. */
  bridgeCall(token: string | undefined, raw: unknown): { text: string; isError: boolean } {
    const { grant, item, attempt } = this.grantedAttempt(token); const body = fields(raw);
    try {
      attempt.submission = parseSubmission(grant.role, body.name, body.arguments); this.save(item);
      this.store.audit('factory_submission', item.id, { attemptId: attempt.id, tool: attempt.submission.tool });
      return { text: 'Recorded. The factory takes it from here: end your turn now.', isError: false };
    } catch (error) {
      if (error instanceof UserError) return { text: error.message, isError: true };
      throw error;
    }
  }
  private endAttempt(attempt: FactoryItem['attempts'][number]) { this.grants.revoke(attempt.id); }
  snapshot() { return clone({ factories: [...this.factories.values()], items: [...this.items.values()].sort((a, b) => b.createdAt - a.createdAt) }); }
  private item(id: string) { const item = this.items.get(id); if (!item) throw new UserError('Work item not found.'); return item; }
  private save(item: FactoryItem) { item.updatedAt = Date.now(); this.store.saveRecord('factory_items', item); }
  private transition(item: FactoryItem, status: FactoryStatus, message: string) {
    if (['paused', 'blocked', 'cancelled'].includes(status)) {
      if (!['paused', 'blocked', 'cancelled'].includes(item.status)) item.suspendedStage = item.status;
      if (item.validation?.outcome === 'running') {
        item.validation.outcome = 'interrupted'; item.validation.finishedAt = Date.now();
      }
    } else item.suspendedStage = undefined;
    item.status = status; item.reason = message;
    item.activity.push({ id: randomUUID(), at: Date.now(), message }); this.save(item);
    this.store.audit('factory_transition', item.id, { status, message });
  }
  private async exclusive<T>(id: string, action: () => Promise<T>): Promise<T> {
    if (this.locked.has(id)) throw new UserError('This work item is updating. Try again in a moment.');
    this.locked.add(id);
    const operation = action(); this.operations.add(operation);
    try { return await operation; } finally { this.locked.delete(id); this.operations.delete(operation); }
  }
  saveDefinition(raw: unknown, id?: string): FactoryDefinition {
    const previous = id ? this.factories.get(id) : undefined;
    if (id && !previous) throw new UserError('Factory not found.');
    const definition = parseFactoryDefinition(raw, previous);
    this.factories.set(definition.id, definition); this.store.saveRecord('factory_definitions', definition);
    this.store.audit('factory_configure', definition.id, { revision: definition.revision }); return clone(definition);
  }
  createItem(raw: unknown): FactoryItem {
    const body = fields(raw); const factory = this.factories.get(String(body.factoryId));
    if (!factory) throw new UserError('Choose a factory first.');
    const item: FactoryItem = { id: randomUUID(), factoryId: factory.id, title: string(body.title, 'Title', 160), request: string(body.request, 'Request', 6000),
      criteria: string(body.criteria, 'Acceptance criteria', 4000), status: 'queued', definition: clone(factory), createdAt: Date.now(), updatedAt: Date.now(), repairs: 0, attempts: [], evidence: [], activity: [] };
    this.items.set(item.id, item); this.transition(item, 'queued', `Queued with ${factory.workflow.name}, configuration v${factory.revision}.`); return clone(item);
  }
  private briefing(item: FactoryItem, role: FactoryRoleName, feedback = '') {
    return [`Factory work item: ${item.title}`, `Request:\n${item.request}`, `Acceptance criteria:\n${item.criteria}`, `Project context:\n${item.definition.context}`,
      item.plan && role !== 'planner' ? `Approved plan:\n${item.plan.slice(0, 5000)}` : '',
      role === 'builder' ? 'Work only in the supplied worktree. Do not merge into the project checkout. The factory runs its own configured checks after your turn.' : 'Return your findings as a clear final response. Do not modify the worktree.',
      feedback ? `Findings to address:\n${feedback.slice(0, 3000)}` : ''].filter(Boolean).join('\n\n').slice(0, 19500);
  }
  /** Carries out a lifecycle step decided by the pure pipeline rules. */
  private async apply(item: FactoryItem, step: FactoryStep) {
    if (step.type === 'launch') {
      if (step.repair) item.repairs++;
      await this.launchStage(item, step.stage, step.feedback);
    } else if (step.type === 'validate') await this.beginValidation(item);
    else if (step.type === 'gate') {
      if (step.plan !== undefined) item.plan = step.plan;
      this.transition(item, step.status, step.message);
    } else {
      if (step.invalidate && item.validation) { item.validation.outcome = 'invalidated'; item.validation.finishedAt = Date.now(); }
      this.transition(item, 'blocked', step.message);
    }
  }
  private advance(item: FactoryItem, event: FactoryEvent) { return this.apply(item, nextStep(pipelineOf(item.definition), event)); }
  /** `gated`: the caller already asked the gate and it was open. */
  private async launchStage(item: FactoryItem, stage: FactoryStage, feedback = '', gated = false) {
    if (this.closing) return;
    const role = stageRole(stage);
    const held = gated ? undefined : await this.gateReason(item, stage);
    if (held) {
      item.waiting = { stageId: stage.id, feedback, reason: held, since: item.waiting?.since ?? Date.now() };
      this.transition(item, 'paused', `Waiting to start the ${role}: ${held} It starts automatically when this clears.`);
      return;
    }
    item.waiting = undefined;
    const attempt = { id: randomUUID(), stage: role, startedAt: Date.now(), outcome: 'running' as const };
    item.attempts.push(attempt); this.transition(item, stageStatus(stage), `${capitalize(role)} assigned. Waiting for the managed agent.`);
    try {
      const config = stage.agents[0];
      const bridge = this.endpoint ? bridgeLaunch(this.endpoint, this.grants.issue({ itemId: item.id, attemptId: attempt.id, role })) : {};
      const appendSystemPrompt = [config.instructions, this.endpoint ? bridgeInstructions(role) : ''].filter(Boolean).join('\n\n');
      const agent = this.host.launch({ vendor: config.vendor, model: config.model || undefined, cwd: item.workspace!, name: `${role}: ${item.title}`.slice(0, 80), prompt: this.briefing(item, role, feedback), appendSystemPrompt, writeRoot: item.workspace, ...bridge });
      Object.assign(attempt, { agentId: agent.id }); this.save(item);
    } catch (error) {
      this.endAttempt(attempt);
      Object.assign(attempt, { outcome: 'failed', finishedAt: Date.now(), output: (error as Error).message });
      this.transition(item, 'blocked', `Could not launch ${role}: ${(error as Error).message}`);
    }
  }
  async action(id: string, action: string): Promise<FactoryItem> {
    return this.exclusive(id, async () => {
      const item = this.item(id);
      if (this.closing) throw new UserError('Waystation is shutting down.');
      if (action === 'start') {
        if (item.status !== 'queued') throw new UserError('Only queued work can be started.');
        if (!item.definition.workflow.checks.length) throw new UserError('Configure at least one required check, then create a new work item using that configuration.');
        mkdirSync(this.root, { recursive: true });
        Object.assign(item, await prepareFactoryWorkspace(item.definition.repository, this.root, item.id)); this.save(item);
        await this.advance(item, { kind: 'start' });
      } else if (action === 'approve-plan') {
        if (item.status !== 'plan_review' || !item.plan) throw new UserError('There is no plan awaiting approval.');
        item.planApprovedAt = Date.now(); this.save(item); await this.advance(item, { kind: 'plan_approved' });
      } else if (action === 'pause' || action === 'cancel') {
        if (['accepted', 'delivered', 'cancelled'].includes(item.status)) throw new UserError('This work item is already closed.');
        item.waiting = undefined;
        this.checks.get(id)?.controller.abort();
        this.transition(item, action === 'pause' ? 'paused' : 'cancelled', action === 'pause' ? 'Paused by you. Resume when ready.' : 'Cancelled by you. The branch and evidence are preserved.');
        const attempt = item.attempts.at(-1);
        if (attempt?.outcome === 'running') {
          this.endAttempt(attempt); attempt.outcome = 'interrupted'; attempt.finishedAt = Date.now(); this.save(item);
          if (attempt.agentId) await this.host.stop(attempt.agentId);
        }
      } else if (action === 'resume') {
        if (!['paused', 'blocked'].includes(item.status)) throw new UserError('Only paused or blocked work can be resumed.');
        if (this.checks.has(id)) throw new UserError('The previous check is still stopping. Try again in a moment.');
        if (!item.workspace) throw new UserError('No workspace exists. Create a new work item.');
        await this.advance(item, { kind: 'resume', hasPlan: Boolean(item.plan), planApproved: Boolean(item.planApprovedAt), reason: item.reason ?? '' });
      } else if (action === 'validate') {
        if (!['blocked', 'paused', 'acceptance', 'accepted'].includes(item.status)) throw new UserError('Pause work before requesting validation.');
        if (!item.workspace || !item.definition.workflow.checks.length) throw new UserError('A workspace and required checks are needed.');
        if (item.definition.workflow.requirePlan && !item.planApprovedAt) throw new UserError('Approve the plan before validation.');
        if (this.checks.has(id)) throw new UserError('Validation is already running.');
        item.acceptedRevision = undefined; item.acceptedAt = undefined;
        await this.beginValidation(item);
      } else if (action === 'accept') {
        if (item.status !== 'acceptance') throw new UserError('This work item is not ready for acceptance.');
        await this.requireEvidence(item); item.acceptedRevision = item.candidate; item.acceptedAt = Date.now();
        this.transition(item, 'accepted', 'You accepted this candidate. Its branch is ready for delivery.');
      } else if (action === 'merge') {
        if (item.status !== 'accepted' || item.acceptedRevision !== item.candidate) throw new UserError('Accept the validated candidate before merging.');
        await this.requireEvidence(item);
        await deliverFactoryWorkspace(item.definition.repository, item.branch!, item.baseBranch!, item.baseCommit!, item.candidate!);
        this.transition(item, 'delivered', `Merged the accepted candidate into ${item.baseBranch}.`);
      } else throw new UserError('Unknown factory action.');
      return clone(item);
    });
  }
  private async requireEvidence(item: FactoryItem) {
    const checks = item.definition.workflow.checks;
    if (!item.candidate || !checks.length || checks.some(check => !item.evidence.some(result => result.revision === item.candidate && result.name === check.name && result.command === check.command && result.outcome === 'passed'))) throw new UserError('All required checks must pass on this candidate.');
    if (!(await factoryWorkspaceMatches(item.workspace!, item.candidate))) {
      item.acceptedRevision = undefined; item.acceptedAt = undefined;
      if (item.validation) { item.validation.outcome = 'invalidated'; item.validation.finishedAt = Date.now(); }
      this.transition(item, 'blocked', 'The workspace changed after validation. Run checks again before accepting or merging.');
      throw new UserError(item.reason!);
    }
  }
  private async beginValidation(item: FactoryItem) {
    if (this.closing) return;
    item.candidate = await snapshotFactoryWorkspace(item.workspace!);
    if (this.closing) return;
    item.validation = { revision: item.candidate, startedAt: Date.now(), outcome: 'running' };
    this.transition(item, 'validating', 'Running required checks against the candidate revision.');
    const controller = new AbortController();
    const task = this.validate(item.id, item.candidate, controller).catch(error => {
      if (this.item(item.id).status === 'validating') {
        if (item.validation) { item.validation.outcome = 'failed'; item.validation.finishedAt = Date.now(); }
        this.transition(item, 'blocked', `Validation could not finish: ${(error as Error).message}`);
      }
    }).finally(() => { this.checks.delete(item.id); });
    this.checks.set(item.id, { controller, task });
  }
  private async validate(id: string, revision: string, controller: AbortController) {
    const item = this.item(id);
    if (item.evidence.length) (item.validationHistory ??= []).push(clone(item.evidence));
    item.evidence = []; this.save(item);
    for (const check of item.definition.workflow.checks) {
      if (controller.signal.aborted || this.closing) return;
      if (item.validation) item.validation.currentCheck = { id: check.id, name: check.name, startedAt: Date.now() };
      this.save(item);
      const evidence = await this.check(check, item.workspace!, revision, item.definition.workflow.maxMinutes * 60_000, controller.signal);
      if (controller.signal.aborted || item.status !== 'validating' || this.closing) return;
      item.evidence.push(evidence); this.save(item);
    }
    if (controller.signal.aborted || item.status !== 'validating') return;
    const matches = await factoryWorkspaceMatches(item.workspace!, revision);
    if (controller.signal.aborted || item.status !== 'validating' || this.closing) return;
    if (item.validation) {
      item.validation.currentCheck = undefined; item.validation.finishedAt = Date.now();
      item.validation.outcome = matches && item.evidence.every(check => check.outcome === 'passed') ? 'passed' : 'failed';
      this.save(item);
    }
    if (!matches) { this.transition(item, 'blocked', 'Checks or another process changed the candidate. Review the changes and run validation again.'); return; }
    const failed = item.evidence.filter(check => check.outcome !== 'passed');
    await this.advance(item, { kind: 'checks_finished', failed, repairs: item.repairs });
  }
  async tick(now = Date.now()) {
    if (this.closing) return;
    await this.retryWaiting(now);
    await Promise.all([...this.items.values()].filter(item => ['planning', 'building', 'reviewing'].includes(item.status) && !this.locked.has(item.id)).map(item => this.exclusive(item.id, async () => {
      const attempt = item.attempts.at(-1); if (!attempt?.agentId || attempt.outcome !== 'running') return;
      const pipeline = pipelineOf(item.definition); const stage = stageForRole(pipeline, attempt.stage);
      const agent = this.host.agent(attempt.agentId);
      const timedOut = Date.now() - attempt.startedAt > stage.maxMinutes * 60_000;
      if (!timedOut && agent && !agent.lastError && !['idle', 'stopped'].includes(agent.status)) return;
      // Finish the attempt synchronously: a submission arriving after this point is refused.
      this.endAttempt(attempt); attempt.finishedAt = Date.now();
      attempt.output = attempt.submission ? renderSubmission(attempt.submission)
        : this.host.events(attempt.agentId).filter(event => event.kind === 'assistant').map(event => event.summary).join('\n\n').slice(-20_000);
      const failure = timedOut ? 'Stage time limit reached.' : agent?.lastError ?? (!agent || agent.status === 'stopped' ? 'The agent stopped before a successful completion.' : undefined);
      attempt.outcome = failure ? 'failed' : 'finished'; this.save(item);
      await this.host.stop(attempt.agentId);
      if (this.closing) return;
      if (failure) { this.transition(item, 'blocked', failure); return; }
      const candidateUnchanged = guardsCandidate(pipeline, stage) ? await factoryWorkspaceMatches(item.workspace!, item.candidate!) : true;
      await this.apply(item, nextStep(pipeline, { kind: 'agent_finished', stage, output: attempt.output ?? '', candidateUnchanged }));
    }).catch(error => { if (!this.closing) this.transition(item, 'blocked', (error as Error).message); })));
  }
  private async gateReason(item: FactoryItem, stage: FactoryStage): Promise<string | undefined> {
    const vendor = stage.agents[0]?.vendor;
    this.gateCheckedAt.set(item.id, Date.now());
    if (!this.host.gate || !vendor) return undefined;
    try {
      return await this.host.gate(vendor, item.definition.repository);
    } catch (error) {
      // A broken gate must not strand work: launch, and let the operator see why the check failed.
      item.activity.push({ id: randomUUID(), at: Date.now(), message: `Could not check the spend cap: ${(error as Error).message}` });
      return undefined;
    }
  }
  /** Launches stages that were waiting on the spend cap or a plan window, once the gate opens. */
  private async retryWaiting(now: number) {
    const due = [...this.items.values()].filter(item => item.status === 'paused' && item.waiting && !this.locked.has(item.id)
      && now - (this.gateCheckedAt.get(item.id) ?? 0) >= GATE_RECHECK_MS);
    await Promise.all(due.map(item => this.exclusive(item.id, async () => {
      const waiting = item.waiting; if (!waiting || item.status !== 'paused') return;
      const stage = pipelineOf(item.definition).stages.find(candidate => candidate.id === waiting.stageId);
      if (!stage) { item.waiting = undefined; this.transition(item, 'blocked', 'The waiting stage no longer exists in this configuration.'); return; }
      // Still closed: stay quiet (no activity entry every 30 seconds).
      if (await this.gateReason(item, stage)) return;
      await this.launchStage(item, stage, waiting.feedback, true);
    }).catch(error => { if (!this.closing) this.transition(item, 'blocked', (error as Error).message); })));
  }
  async diff(id: string) { const item = this.item(id); if (!item.workspace || !item.baseCommit) throw new UserError('Start this work item to create a branch.'); return diffWorktree(item.workspace, item.baseCommit); }
  async shutdown() {
    this.closing = true; if (this.timer) clearInterval(this.timer);
    for (const check of this.checks.values()) check.controller.abort();
    await Promise.allSettled([...this.operations]);
    for (const item of this.items.values()) if (FACTORY_ACTIVE.includes(item.status)) {
      this.checks.get(item.id)?.controller.abort(); this.transition(item, 'paused', 'Waystation stopped. Resume explicitly to continue.');
      const attempt = item.attempts.at(-1);
      if (attempt?.outcome === 'running') {
        this.endAttempt(attempt); attempt.outcome = 'interrupted'; attempt.finishedAt = Date.now(); this.save(item);
        if (attempt.agentId) await this.host.stop(attempt.agentId);
      }
    }
    await Promise.all([...this.checks.values()].map(check => check.task));
  }
}
