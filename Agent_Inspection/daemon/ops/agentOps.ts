import type { Agent, AgentEvent } from '../domain/types.ts';
import type { AgentRegistry } from '../domain/registry.ts';
import type { TowerStore, UsageSummary } from '../store/db.ts';
import { validateLaunch, type ManagedAgents } from '../managed/managedAgents.ts';
import { Breaker, DEFAULT_BREAKER, type BreakerConfig, type Trip } from '../guard/breaker.ts';
import { OpsInputError, optionalModel, optionalText, validateTemplate, type AgentTemplate } from './templates.ts';
import {
  dueSlot, newSchedule, nextRun, normalizeSchedule, validateMaxMinutes, validateScheduleFields, withRun,
  type Schedule, type ScheduledLaunch, type ScheduleOptions, type ScheduleRun,
} from './schedules.ts';
import {
  composeLaunch, MAX_RESOURCES, pruneUploads, removeScheduleResources, saveUpload, validateNotify, validateResources,
} from './scheduleResources.ts';
import { ScheduleRunWatcher } from './scheduleRuns.ts';
import { checkPrerequisites, type Prerequisite, type PrerequisiteProbes } from './prerequisites.ts';
import { LibraryInputError, type NotifySender } from '../library/types.ts';
import { parseLoadout } from '../library/loadout.ts';
import { paths } from '../config.ts';

export interface AgentOpsDeps {
  readonly registry: AgentRegistry;
  readonly store: TowerStore;
  readonly managed: ManagedAgents;
  readonly isTeamMember: (agentId: string) => boolean;
  /** Validates, audits and launches, exactly like New agent. */
  readonly launch: (raw: unknown) => Agent;
  readonly instruct: (agentId: string, text: string) => Promise<string>;
  readonly setIntercept: (agentId: string, on: boolean) => void;
  readonly interrupt: (agentId: string) => Promise<void>;
  readonly stopAgent: (agentId: string) => Promise<void>;
  readonly probes: Omit<PrerequisiteProbes, 'run'>;
  /** Delivers schedule run updates (inbox, Slack, Discord, email…). */
  readonly notifier?: NotifySender;
  readonly breaker?: BreakerConfig;
  /** Where files uploaded to schedules are kept (default: paths.resourcesDir). */
  readonly resourcesDir?: string;
  /** Clock for schedule run timing (tests). */
  readonly now?: () => number;
}

const LEDGER_EVERY_MS = 15_000;
const BREAKER_TICK_MS = 60_000;
const SCHEDULE_TICK_MS = 30_000;
const MAX_NAME_CHARS = 80;
/** Lets the old SDK process let go of the session file before it is resumed. */
const RESTART_SETTLE_MS = 500;
const DEFAULT_CONTINUE = 'You were restarted by the operator. Continue where you left off.';

const STEER: Record<Trip['level'], string> = {
  warned: 'The operator\'s runaway guard noticed: {reason}. Stop and reconsider your approach before continuing. If you are stuck, say what is blocking you instead of retrying the same step.',
  constrained: 'The operator\'s runaway guard stepped in again: {reason}. From now on each tool call needs the operator\'s approval.',
  stopped: '',
};

export interface ScheduleView extends Schedule {
  readonly nextRunAt?: number;
}

/**
 * Operator features layered on the tower: usage ledger, runaway guard, renaming,
 * restart & continue, templates, schedules and the prerequisites check.
 */
export class AgentOps {
  private readonly breaker: Breaker;
  private timers: NodeJS.Timeout[] = [];
  private names = new Map<string, string>();
  private readonly restarting = new Set<string>();
  readonly runs: ScheduleRunWatcher;

  constructor(private readonly deps: AgentOpsDeps) {
    this.breaker = new Breaker(deps.breaker ?? DEFAULT_BREAKER);
    this.runs = new ScheduleRunWatcher({
      agent: (agentId) => deps.registry.get(agentId),
      events: (agentId) => {
        const live = deps.registry.recentEvents(agentId);
        return live.length ? live : deps.store.eventsFor(agentId, 50);
      },
      onAgentsChanged: (listener) => {
        deps.registry.on('agents', listener);
        return () => deps.registry.off('agents', listener);
      },
      loadSchedule: (id) => this.findSchedule(id),
      saveSchedule: (schedule) => deps.store.saveRecord('schedules', schedule),
      stopAgent: (agentId) => deps.stopAgent(agentId),
      notifier: deps.notifier,
      now: deps.now,
    });
  }

  start(): void {
    this.names = this.deps.store.agentNames();
    for (const [agentId, name] of this.names) this.deps.registry.setOverride(agentId, { name });
    this.timers = [
      setInterval(() => this.flushUsage(), LEDGER_EVERY_MS),
      setInterval(() => this.calmBreakers(), BREAKER_TICK_MS),
      setInterval(() => void this.runDueSchedules(), SCHEDULE_TICK_MS),
    ];
    for (const timer of this.timers) timer.unref();
    this.runs.start(this.loadSchedules());
  }

  stop(): void {
    this.runs.stop();
    this.timers.forEach(clearInterval);
    this.timers = [];
    this.flushUsage();
  }

  // ---- runaway guard ----------------------------------------------------------------------------

  onEvent(event: AgentEvent): void {
    const trip = this.breaker.observe(event);
    if (trip) void this.enforce(trip);
  }

  resetBreaker(agentId: string): void {
    this.breaker.reset(agentId);
    this.deps.registry.setOverride(agentId, { breaker: undefined });
    this.deps.store.audit('breaker_reset', agentId, {});
    this.deps.registry.pushEvent({ agentId, ts: Date.now(), kind: 'system', summary: 'Runaway guard cleared by the operator' });
  }

  private async enforce(trip: Trip): Promise<void> {
    const agent = this.deps.registry.get(trip.agentId);
    if (!agent) return;
    this.deps.registry.setOverride(trip.agentId, { breaker: this.breaker.state(trip.agentId) });
    this.deps.store.audit('breaker', trip.agentId, trip);
    const label = { warned: 'warned the agent', constrained: 'constrained the agent', stopped: 'stopped the agent' }[trip.level];
    this.deps.registry.pushEvent({ agentId: trip.agentId, ts: Date.now(), kind: 'system', summary: `Runaway guard ${label}: ${trip.reason}` });
    const steer = STEER[trip.level].replace('{reason}', trip.reason);
    try {
      if (trip.level === 'stopped') {
        await this.deps.stopAgent(trip.agentId);
        return;
      }
      if (trip.level === 'constrained') {
        if (agent.vendor === 'claude') this.deps.setIntercept(trip.agentId, true);
        else if (agent.tier === 'A') await this.deps.interrupt(trip.agentId);
      }
      if (agent.canInstruct) await this.deps.instruct(trip.agentId, steer);
    } catch (error) {
      // Observe-only agents can't be steered; the flag on the card still tells the operator.
      this.deps.registry.pushEvent({
        agentId: trip.agentId, ts: Date.now(), kind: 'system', summary: `Runaway guard could not act: ${(error as Error).message}`,
      });
    }
  }

  private calmBreakers(): void {
    for (const agentId of this.breaker.tick()) this.deps.registry.setOverride(agentId, { breaker: undefined });
  }

  // ---- usage --------------------------------------------------------------------------------

  private flushUsage(): void {
    for (const agent of this.deps.registry.list()) {
      if (!agent.usage) continue;
      // A tower-launched parent's SDK stream already includes its subagents' spend.
      if (agent.parentId && this.deps.registry.get(agent.parentId)?.tier === 'A') continue;
      try {
        this.deps.store.recordUsage(agent);
      } catch (error) {
        console.error('[ops] recording usage failed:', (error as Error).message);
      }
      const trip = this.breaker.observeCost(agent.id, agent.usage.costUsd);
      if (trip) void this.enforce(trip);
    }
  }

  usage(rawDays: unknown): UsageSummary {
    const days = typeof rawDays === 'number' && Number.isInteger(rawDays) ? Math.min(Math.max(rawDays, 1), 90) : 7;
    this.flushUsage();
    return this.deps.store.usageSummary(days);
  }

  // ---- rename, restart ------------------------------------------------------------------------

  renameAgent(agentId: string, rawName: unknown): string | undefined {
    if (!this.deps.registry.get(agentId)) throw new OpsInputError('Agent not found (it may have exited).');
    const name = optionalText(rawName, 'name', MAX_NAME_CHARS);
    this.deps.store.setAgentName(agentId, name);
    this.names = new Map([...this.names].filter(([id]) => id !== agentId).concat(name ? [[agentId, name]] : []));
    this.deps.registry.setOverride(agentId, { name });
    this.deps.store.audit('rename', agentId, { name: name ?? '(default)' });
    return name;
  }

  async restartAgent(agentId: string, raw: unknown): Promise<Agent> {
    // Two restarts at once would both relaunch the same session, leaving one runner orphaned.
    if (this.restarting.has(agentId)) throw new OpsInputError('This agent is already restarting.');
    this.restarting.add(agentId);
    try {
      return await this.restartOnce(agentId, raw);
    } finally {
      this.restarting.delete(agentId);
    }
  }

  private async restartOnce(agentId: string, raw: unknown): Promise<Agent> {
    const body = (raw ?? {}) as Record<string, unknown>;
    const launch = this.deps.managed.launchOf(agentId);
    const runner = this.deps.managed.get(agentId);
    if (!launch || !runner) throw new OpsInputError('Restart & continue works for agents launched from the tower.');
    if (this.deps.isTeamMember(agentId)) throw new OpsInputError('Team members restart with their team: pause it, then resume.');
    const sessionId = runner.sessionId;
    if (!sessionId) throw new OpsInputError('This agent has no conversation to continue yet. Give it a moment, or stop it and launch a new one.');
    const model = optionalModel(body.model) ?? launch.model;
    const prompt = optionalText(body.message, 'message', 8000) ?? DEFAULT_CONTINUE;
    const current = this.deps.registry.get(agentId);
    this.deps.store.audit('restart', agentId, { sessionId, model, previousModel: launch.model });
    if (runner.snapshot().status !== 'stopped') {
      await runner.stop();
      await new Promise((resolve) => setTimeout(resolve, RESTART_SETTLE_MS));
    }
    this.breaker.reset(agentId);
    this.deps.registry.setOverride(agentId, { breaker: undefined });
    const relaunched = this.deps.managed.launch({
      ...launch,
      agentId,
      prompt,
      model,
      name: this.names.get(agentId) ?? launch.name,
      resumeSessionId: sessionId,
      fork: false,
      intercept: current?.intercepting ?? launch.intercept,
    });
    this.deps.registry.pushEvent({
      agentId, ts: Date.now(), kind: 'system',
      summary: `Restarted and continuing the same conversation${model && model !== launch.model ? ` on ${model}` : ''}`,
    });
    return relaunched.snapshot();
  }

  // ---- templates ------------------------------------------------------------------------------

  templates(): AgentTemplate[] {
    return this.deps.store.loadRecords<AgentTemplate>('templates');
  }

  createTemplate(raw: unknown): AgentTemplate {
    const template = validateTemplate(raw);
    this.deps.store.saveRecord('templates', template);
    this.deps.store.audit('template_create', template.id, { label: template.label, vendor: template.vendor, model: template.model });
    return template;
  }

  deleteTemplate(id: string): void {
    if (!this.deps.store.deleteRecord('templates', id)) throw new OpsInputError('Template not found.');
    this.deps.store.audit('template_delete', id, {});
  }

  // ---- schedules ------------------------------------------------------------------------------

  schedules(now = Date.now()): ScheduleView[] {
    return this.loadSchedules().map((schedule) => ({ ...schedule, nextRunAt: nextRun(schedule, now) }));
  }

  createSchedule(raw: unknown): ScheduleView {
    const { fields, launch, options } = this.parseSchedule(raw);
    const schedule = newSchedule(fields, launch, Date.now(), options);
    this.deps.store.saveRecord('schedules', schedule);
    this.deps.store.audit('schedule_create', schedule.id, {
      label: schedule.label, days: schedule.days, time: schedule.time, cwd: launch.cwd, resources: schedule.resources.length,
    });
    return { ...schedule, nextRunAt: nextRun(schedule) };
  }

  /** Full edit: the same body as create. Keeps id, createdAt and run history. */
  updateSchedule(id: string, raw: unknown): ScheduleView {
    const existing = this.requireSchedule(id);
    const { fields, launch, options } = this.parseSchedule(raw);
    const updated: Schedule = { ...existing, ...fields, launch, ...options };
    this.deps.store.saveRecord('schedules', updated);
    pruneUploads(this.resourcesDir, id, updated.resources);
    this.deps.store.audit('schedule_update', id, { label: updated.label, days: updated.days, time: updated.time, resources: updated.resources.length });
    return { ...updated, nextRunAt: nextRun(updated) };
  }

  /** Stores an uploaded file in the schedule's folder and adds it as a file resource. */
  uploadScheduleResource(id: string, raw: unknown): ScheduleView {
    const schedule = this.requireSchedule(id);
    if (schedule.resources.length >= MAX_RESOURCES) throw new OpsInputError(`a schedule can have at most ${MAX_RESOURCES} resources`);
    const body = (raw ?? {}) as Record<string, unknown>;
    const path = saveUpload(this.resourcesDir, id, body.filename, body.contentBase64);
    const [resource] = validateResources([{ kind: 'file', value: path, label: body.label }]);
    const updated: Schedule = { ...schedule, resources: [...schedule.resources, resource] };
    this.deps.store.saveRecord('schedules', updated);
    this.deps.store.audit('schedule_upload', id, { file: path });
    return { ...updated, nextRunAt: nextRun(updated) };
  }

  scheduleRuns(id: string): readonly ScheduleRun[] {
    return [...(this.requireSchedule(id).runs ?? [])].reverse();
  }

  setScheduleEnabled(id: string, enabled: boolean): ScheduleView {
    const schedule = this.requireSchedule(id);
    const updated: Schedule = { ...schedule, enabled };
    this.deps.store.saveRecord('schedules', updated);
    this.deps.store.audit(enabled ? 'schedule_enable' : 'schedule_disable', id, {});
    return { ...updated, nextRunAt: nextRun(updated) };
  }

  deleteSchedule(id: string): void {
    if (!this.deps.store.deleteRecord('schedules', id)) throw new OpsInputError('Schedule not found.');
    removeScheduleResources(this.resourcesDir, id);
    this.deps.store.audit('schedule_delete', id, {});
  }

  runScheduleNow(id: string): Agent {
    return this.fire(this.requireSchedule(id), Date.now(), true);
  }

  /** Exposed for tests; the timer calls it every 30 seconds. */
  async runDueSchedules(now = Date.now()): Promise<void> {
    for (const schedule of this.loadSchedules()) {
      if (dueSlot(schedule, now) === undefined) continue;
      try {
        this.fire(schedule, now, false);
      } catch {
        // fire() already recorded the failure on the schedule.
      }
    }
  }

  private get resourcesDir(): string {
    return this.deps.resourcesDir ?? paths.resourcesDir;
  }

  private parseSchedule(raw: unknown): { fields: ReturnType<typeof validateScheduleFields>; launch: ScheduledLaunch; options: ScheduleOptions } {
    const body = (raw ?? {}) as Record<string, unknown>;
    const fields = validateScheduleFields(body);
    const launch = this.parseScheduledLaunch((body.launch ?? {}) as Record<string, unknown>);
    const options: ScheduleOptions = {
      resources: validateResources(body.resources),
      notify: validateNotify(body.notify),
      stopWhenDone: body.stopWhenDone !== false,
      maxMinutes: validateMaxMinutes(body.maxMinutes),
    };
    return { fields, launch, options };
  }

  private parseScheduledLaunch(launchBody: Record<string, unknown>): ScheduledLaunch {
    let loadout;
    try {
      loadout = parseLoadout(launchBody.loadout);
    } catch (error) {
      if (error instanceof LibraryInputError) throw new OpsInputError(error.message);
      throw error;
    }
    const launch: ScheduledLaunch = {
      vendor: launchBody.vendor === 'codex' ? 'codex' : 'claude',
      cwd: typeof launchBody.cwd === 'string' ? launchBody.cwd.trim() : '',
      prompt: typeof launchBody.prompt === 'string' ? launchBody.prompt : '',
      name: optionalText(launchBody.name, 'name', MAX_NAME_CHARS),
      model: optionalModel(launchBody.model),
      appendSystemPrompt: optionalText(launchBody.appendSystemPrompt, 'instructions', 8000),
      intercept: launchBody.vendor !== 'codex' && launchBody.intercept === true,
      ...(loadout ? { loadout } : {}),
    };
    // The same checks as New agent, so a schedule can't be saved for a folder that doesn't exist.
    try {
      validateLaunch(launch);
    } catch (error) {
      throw new OpsInputError((error as Error).message);
    }
    return launch;
  }

  private fire(schedule: Schedule, now: number, manual: boolean): Agent {
    this.deps.store.audit('schedule_run', schedule.id, { label: schedule.label, manual });
    const record = (lastResult: string, extra: Partial<Schedule> = {}): Schedule => ({ ...schedule, lastRunAt: now, lastResult, ...extra });
    try {
      const agent = this.deps.launch(composeLaunch(schedule));
      const startedAt = this.deps.now?.() ?? now;
      const run: ScheduleRun = { agentId: agent.id, agentName: agent.name, startedAt };
      this.deps.store.saveRecord('schedules', withRun(record(`Launched ${agent.name}`, { lastRunAgentId: agent.id }), run));
      this.runs.track(schedule.id, agent.id, startedAt);
      return agent;
    } catch (error) {
      const message = (error as Error).message;
      this.deps.store.saveRecord('schedules', record(`Failed: ${message}`));
      void this.notifyLaunchFailure(schedule, message);
      throw new OpsInputError(message);
    }
  }

  private async notifyLaunchFailure(schedule: Schedule, message: string): Promise<void> {
    if (!this.deps.notifier || !schedule.notify || schedule.notify.when === 'never') return;
    await this.deps.notifier.send(schedule.notify.channelIds, {
      title: `${schedule.label}: failed`, body: `The agent could not be launched: ${message}`, level: 'error', source: `schedule:${schedule.label}`,
    });
  }

  private loadSchedules(): Schedule[] {
    return this.deps.store.loadRecords<Schedule>('schedules').map(normalizeSchedule);
  }

  private findSchedule(id: string): Schedule | undefined {
    return this.loadSchedules().find((candidate) => candidate.id === id);
  }

  private requireSchedule(id: string): Schedule {
    const schedule = this.findSchedule(id);
    if (!schedule) throw new OpsInputError('Schedule not found.');
    return schedule;
  }

  // ---- prerequisites --------------------------------------------------------------------------

  prerequisites(): Prerequisite[] {
    return checkPrerequisites(this.deps.probes);
  }
}
