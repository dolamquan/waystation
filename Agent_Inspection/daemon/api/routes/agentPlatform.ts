import type { Tower } from '../../tower.ts';
import { bodyOf, headerOf, r, type Route } from './route.ts';
import { LibraryInputError } from '../../library/types.ts';
import { METRICS_RANGES, METRICS_SOURCES, type MetricsRange } from '../../../shared/agentRunMetrics.ts';
import { metricsWindow } from '../../architecture/runMetrics.ts';

const MAX_TZ_OFFSET_MIN = 14 * 60;

/** GET /api/agent-runs/metrics. Registered ahead of /api/agent-runs/:id, which would otherwise capture "metrics" as a run id. */
export function agentRunMetricsRoutes(tower: Tower): Route[] {
  return [r('GET', '/api/agent-runs/metrics', ({ req }) => {
    const q = new URL(req.url!, 'http://localhost').searchParams;
    const range = (q.get('range') ?? '24h') as MetricsRange;
    if (!Object.hasOwn(METRICS_RANGES, range)) throw new LibraryInputError('Range must be 24h, 7d, or 30d.');
    const source = q.get('source') || undefined;
    if (source && !(METRICS_SOURCES as readonly string[]).includes(source)) throw new LibraryInputError('Unknown run source.');
    const agent = q.get('agent') || '';
    const split = agent.indexOf(':');
    if (agent && (split <= 0 || split === agent.length - 1)) throw new LibraryInputError('Agent must be architectureId:nodeId.');
    const tz = Number(q.get('tz') ?? 0);
    if (!Number.isInteger(tz) || Math.abs(tz) > MAX_TZ_OFFSET_MIN) throw new LibraryInputError('Time zone offset is out of range.');
    const { ms, bucketMs } = METRICS_RANGES[range]; const now = Date.now();
    return tower.library.agentRuns.metrics({ ...metricsWindow(now, ms, bucketMs, tz), bucketMs, now, project: q.get('project') ?? '', source,
      architectureId: agent ? agent.slice(0, split) : undefined, nodeId: agent ? agent.slice(split + 1) : undefined });
  })];
}

/** Uses the same operator authentication and origin checks as all other /api routes. */
export function agentPlatformRoutes(tower: Tower): Route[] {
  const platform = tower.library.agentPlatform;
  platform.start();
  return [
    r('GET', '/api/agent-platform', ({ req }) => platform.state(new URL(req.url!, 'http://localhost').searchParams.get('project') ?? '')),
    r('GET', '/api/agent-brain-connections', ({ req }) => ({ connections: tower.library.brains.list(new URL(req.url!, 'http://localhost').searchParams.get('project') ?? '') })),
    r('GET', '/api/agent-secrets', ({ req }) => ({ secrets: tower.library.agentSecrets.list(new URL(req.url!, 'http://localhost').searchParams.get('project') ?? undefined) })),
    r('POST', '/api/agent-secrets', ({ body }) => ({ secret: tower.library.agentSecrets.save(bodyOf(body)) })),
    r('POST', '/api/agent-secrets/:id/value', ({ params, body }) => ({ secret: tower.library.agentSecrets.save(bodyOf(body), params[0]) })),
    r('POST', '/api/agent-secrets/:id/revoke', ({ params }) => { tower.library.agentSecrets.revoke(params[0]); return { ok: true }; }),
    r('POST', '/api/agent-capabilities', async ({ body }) => { const b = bodyOf(body); return { capability: await platform.publishCapability(String(b.project ?? ''), b) }; }),
    r('POST', '/api/agent-capabilities/:id', async ({ params, body }) => { const b = bodyOf(body); return { capability: await platform.publishCapability(String(b.project ?? ''), b, params[0]) }; }),
    r('POST', '/api/agent-service-connections/:id/discover', async ({ params, body }) => platform.discoverMcp(String(bodyOf(body).project ?? ''), params[0])),
    r('POST', '/api/agent-capabilities/:id/test', async ({ params, body }) => { const b = bodyOf(body); return { result: await platform.testCapability(String(b.project ?? ''), params[0], b.input, b.expectedVersion, b.initialize === true) }; }),
    r('POST', '/api/agent-service-connections', ({ body }) => { const b = bodyOf(body); return { connection: platform.saveConnection(String(b.project ?? ''), b) }; }),
    r('POST', '/api/agent-service-connections/:id/key', ({ params, body }) => { const b = bodyOf(body); return { connection: platform.saveConnection(String(b.project ?? ''), b, params[0]) }; }),
    r('POST', '/api/agent-environments', ({ body }) => { const b = bodyOf(body); return { environment: platform.saveEnvironment(String(b.project ?? ''), b) }; }),
    r('POST', '/api/agent-environments/:id', ({ params, body }) => { const b = bodyOf(body); return { environment: platform.saveEnvironment(String(b.project ?? ''), b, params[0]) }; }),
    r('POST', '/api/architectures/:id/nodes/:node/deployment-preview', ({ params, body }) => platform.preview(params[0], params[1], bodyOf(body).environmentId)),
    r('POST', '/api/architectures/:id/nodes/:node/deploy', ({ params, body }) => ({ deployment: platform.deploy(params[0], params[1], bodyOf(body)) })),
    r('GET', '/api/agent-tools/catalog', ({ req }) => tower.library.agentTools.catalog(new URL(req.url!, 'http://localhost').searchParams.get('project') ?? '')),
    r('POST', '/api/agent-tools/mcp/probe', async ({ body }) => { const b = bodyOf(body); return tower.library.agentTools.probeMcp(b.project, b); }),
    r('POST', '/api/agent-tools/generate', async ({ body }) => { const b = bodyOf(body); return tower.library.agentTools.generate(b.project, b); }),
    r('POST', '/api/architectures/:id/nodes/:node/tools', async ({ params, body }) => tower.library.agentTools.addTool(params[0], params[1], bodyOf(body))),
    r('POST', '/api/architectures/:id/nodes/:node/tools/remove', ({ params, body }) => ({ snapshot: tower.library.agentTools.removeTool(params[0], params[1], bodyOf(body)) })),
    r('GET', '/api/architectures/:id/nodes/:node/releases', ({ params }) => platform.releases(params[0], params[1])),
    r('POST', '/api/architectures/:id/nodes/:node/release-policy', ({ params, body }) => ({ policy: platform.saveReleasePolicy(params[0], params[1], bodyOf(body)) })),
    r('GET', '/api/agent-deployments/:id/gate', ({ params }) => platform.gate(params[0])),
    r('POST', '/api/agent-deployments/:id/promote', ({ params, body }) => ({ deployment: platform.promote(params[0], bodyOf(body)) })),
    r('POST', '/api/agent-deployments/:id/rollback', ({ params }) => ({ deployment: platform.rollback(params[0]) })),
    r('GET', '/api/agent-deployments', () => ({ deployments: platform.deployments().map(({ definition: _, environment: __, ...d }) => d) })),
    r('GET', '/api/agent-deployments/:id', ({ params }) => platform.detail(params[0])),
    r('POST', '/api/agent-deployments/:id/status', ({ params, body }) => ({ deployment: platform.setStatus(params[0], bodyOf(body).status) })),
    r('POST', '/api/agent-deployments/:id/runs', ({ params, body }) => ({ run: platform.run(params[0], bodyOf(body).text) })),
    r('POST', '/api/agent-deployments/:id/conversations', ({ params, body }) => ({ conversation: platform.createConversation(params[0], bodyOf(body)) })),
    r('GET', '/api/agent-conversations/:id', ({ params }) => ({ conversation: platform.conversation(params[0]) })),
    r('POST', '/api/agent-conversations/:id/messages', ({ params, body }) => platform.message(params[0], bodyOf(body))),
    r('POST', '/api/agent-deployments/:id/triggers', ({ params, body }) => ({ trigger: platform.saveTrigger(params[0], bodyOf(body)) })),
    r('POST', '/api/agent-deployments/:id/triggers/:trigger', ({ params, body }) => ({ trigger: platform.saveTrigger(params[0], bodyOf(body), params[1]) })),
    r('POST', '/api/agent-triggers/:id/invoke', ({ params }) => ({ run: platform.fireTrigger(params[0]) })),
    r('POST', '/api/agent-triggers/:id/key', ({ params }) => platform.webhookKey(params[0])),
    r('GET', '/api/agent-runs/:id/trace', ({ params, req }) => ({ events: tower.library.agentRuns.trace(params[0], Number(new URL(req.url!, 'http://localhost').searchParams.get('after') ?? 0)) })),
    r('GET', '/api/agent-runs/:id/artifacts/:index', ({ params }) => tower.library.agentRuns.artifact(params[0], Number(params[1]))),
  ];
}

export function agentPlatformBridgeRoutes(tower: Tower): Route[] {
  return [r('POST', '/agent/agent-platform/:id/invoke', ({ req }) => {
    const id = new URL(req.url!, 'http://localhost').pathname.split('/')[3];
    return tower.library.agentPlatform.invokeWebhook(id, headerOf(req, 'authorization')?.replace(/^Bearer\s+/i, '') ?? '');
  })];
}
