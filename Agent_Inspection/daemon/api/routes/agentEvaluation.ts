import type { Tower } from '../../tower.ts';
import { bodyOf, r, type Route } from './route.ts';

export function agentEvaluationRoutes(tower: Tower): Route[] {
  const evaluations = tower.library.agentEvaluations; const sandboxes = tower.library.agentSandboxes; evaluations.start(); sandboxes.recover();
  const projectOf = (url: string) => new URL(url, 'http://localhost').searchParams.get('project') ?? '';
  return [
    r('GET', '/api/agent-evaluation', ({ req }) => { const project = projectOf(req.url!); return { datasets: evaluations.datasets(project), evaluators: evaluations.evaluators(project), experiments: evaluations.list(project).map(e => evaluations.summary(e)) }; }),
    r('POST', '/api/agent-datasets', ({ body }) => ({ dataset: evaluations.saveDataset(bodyOf(body)) })),
    r('GET', '/api/agent-datasets/:id', ({ params, req }) => ({ dataset: evaluations.dataset(params[0], Number(new URL(req.url!, 'http://localhost').searchParams.get('revision')) || undefined) })),
    r('POST', '/api/agent-datasets/:id', ({ params, body }) => ({ dataset: evaluations.saveDataset(bodyOf(body), params[0]) })),
    r('POST', '/api/agent-datasets/:id/from-run', ({ params, body }) => { const b = bodyOf(body); return { dataset: evaluations.addRunToDataset(params[0], String(b.runId), b.expectedRevision, b.reference) }; }),
    r('POST', '/api/agent-evaluators', ({ body }) => ({ evaluator: evaluations.saveEvaluator(bodyOf(body)) })),
    r('POST', '/api/agent-evaluators/:id', ({ params, body }) => ({ evaluator: evaluations.saveEvaluator(bodyOf(body), params[0]) })),
    r('POST', '/api/agent-evaluators/:id/test', async ({ params, body }) => { const b = bodyOf(body); const e = evaluations.evaluator(params[0], typeof b.expectedVersion === 'number' ? b.expectedVersion : undefined); return { score: await evaluations.score(e, String(b.input ?? ''), String(b.output ?? ''), String(b.reference ?? '')) }; }),
    r('POST', '/api/agent-runs/:id/evaluate', async ({ params, body }) => { const b = bodyOf(body); return { score: await evaluations.scoreRun(params[0], String(b.evaluatorId), b.reference) }; }),
    r('POST', '/api/agent-experiments', ({ body }) => ({ experiment: evaluations.create(bodyOf(body)) })),
    r('GET', '/api/agent-experiments/:id', ({ params }) => ({ experiment: evaluations.get(params[0]) })),
    r('POST', '/api/agent-experiments/:id/cancel', async ({ params }) => ({ experiment: await evaluations.cancel(params[0]) })),
    r('POST', '/api/agent-experiments/:id/retry', ({ params }) => ({ experiment: evaluations.create({}, params[0]) })),
    r('GET', '/api/agent-experiments/:id/compare/:candidate', ({ params }) => evaluations.compare(params[0], params[1])),
    r('GET', '/api/agent-sandboxes', ({ req }) => ({ executions: sandboxes.list(projectOf(req.url!)) })),
    r('GET', '/api/agent-sandboxes/availability', () => sandboxes.availability()),
    r('GET', '/api/agent-sandboxes/:id', ({ params }) => ({ execution: sandboxes.get(params[0]) })),
    r('POST', '/api/agent-sandboxes', ({ body }) => { const b = bodyOf(body); return { execution: sandboxes.start(String(b.project ?? ''), b) }; }),
    r('POST', '/api/agent-sandboxes/:id/cancel', ({ params }) => ({ execution: sandboxes.cancel(params[0]) })),
  ];
}
