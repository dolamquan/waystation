/** Isolated browser-test server: real API, SQLite, Git and checks; deterministic agent completions. */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Agent, AgentEvent } from '../daemon/domain/types.ts';
import type { FactoryHost } from '../daemon/factory/engine.ts';

const root = mkdtempSync(join(tmpdir(), 'waystation-factory-browser-'));
process.env.AGENT_TOWER_HOME = root; process.env.CLAUDE_HOME = join(root, 'claude');
const repository = join(root, 'repository');
const { mkdirSync } = await import('node:fs'); mkdirSync(repository);
const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' });
git('init', '-b', 'main');
writeFileSync(join(repository, 'verify.cjs'), 'const fs = require("node:fs"); if (fs.readFileSync("feature.txt", "utf8").trim() !== "implemented") { console.error("Unexpected behavior"); process.exit(1); } console.log("Factory behavior verified");');
writeFileSync(join(repository, 'verify-delay.cjs'), 'setTimeout(() => console.log("Delayed required check passed"), 6000);');
writeFileSync(join(repository, 'verify-failure.cjs'), 'console.error("Regression intentionally failed in the test fixture"); process.exit(1);');
writeFileSync(join(repository, 'README.md'), '# Factory browser fixture\n'); git('add', '-A'); git('-c', 'user.name=Factory test', '-c', 'user.email=factory@example.com', 'commit', '-m', 'Fixture');
const agents = new Map<string, Agent>(); const events = new Map<string, AgentEvent[]>(); const timers = new Set<NodeJS.Timeout>(); let sequence = 0;
let tower: import('../daemon/tower.ts').Tower;
const assignments = new Map<string, { role: string; cwd: string }>();
const publish = (agent: Agent) => { agents.set(agent.id, agent); tower?.registry.upsert('factory-test', agent); };
function finishAgent(id: string) {
  const agent = agents.get(id); const assignment = assignments.get(id);
  if (!agent || !assignment || !['busy', 'waiting'].includes(agent.status)) return;
  const { role, cwd } = assignment;
  if (role === 'builder') writeFileSync(join(cwd, 'feature.txt'), 'implemented\n');
  const summary = role === 'planner' ? 'Plan: implement feature.txt, preserve existing behavior, and run the configured behavior check.' : role === 'builder' ? 'Implemented the requested behavior with a scoped change.' : 'Reviewed the candidate against the acceptance criteria. No blocking findings in this fixture.';
  const event: AgentEvent = { agentId: id, kind: 'assistant', ts: Date.now(), summary };
  events.set(id, [event]); tower.registry.pushEvent(event);
  publish({ ...agent, status: 'idle', currentActivity: 'Stage result submitted', lastEventAt: Date.now() });
}
const host: FactoryHost = {
  launch: input => {
    const id = `managed:fixture-${++sequence}`; const role = input.name!.split(':')[0];
    const agent: Agent = { id, vendor: input.vendor, name: input.name!, cwd: input.cwd, tier: 'A', status: 'busy', project: 'Factory fixture', source: 'factory-test', canInstruct: false, hooked: false, intercepting: false,
      model: input.model || 'fixture-model', startedAt: Date.now(), lastEventAt: Date.now(), currentActivity: role === 'planner' ? 'Investigating the request and repository' : role === 'builder' ? 'Implementing the scoped change' : 'Reviewing the candidate and acceptance criteria' };
    assignments.set(id, { role, cwd: input.cwd }); publish(agent);
    if (process.env.FACTORY_TEST_HOLD_AGENTS === '1') return agent;
    const timer = setTimeout(() => {
      timers.delete(timer); finishAgent(id);
    }, 700); timers.add(timer); return agent;
  }, agent: id => agents.get(id), events: id => events.get(id) ?? [], stop: async id => { const agent = agents.get(id); if (agent) publish({ ...agent, status: 'stopped' }); },
};
const { Tower } = await import('../daemon/tower.ts'); const { startServer } = await import('../daemon/api/server.ts');
tower = new Tower(join(root, 'factory.db'), { factoryHost: host, factoryRoot: join(root, 'workspaces') });
const port = Number(process.env.FACTORY_TEST_PORT ?? 47349); const token = '0123456789abcdef0123456789abcdef';
const server = await startServer({ tower, port, host: '127.0.0.1', token, webDist: resolve(process.env.FACTORY_TEST_DIST ?? 'web/dist') });
tower.factory.start();
console.log(JSON.stringify({ ready: true, repository, root, port, token }));
let closing = false;
async function shutdown() {
  if (closing) return; closing = true; for (const timer of timers) clearTimeout(timer);
  await new Promise<void>(resolve => server.close(() => resolve())); await tower.shutdown(); process.exit(0);
}
process.on('message', (raw: unknown) => {
  const message = raw as { type?: string; agentId?: string; status?: Agent['status']; activity?: string; shutdown?: boolean };
  if (message.shutdown) { void shutdown(); return; }
  if (!message.agentId) return;
  if (message.type === 'finish') finishAgent(message.agentId);
  if (message.type === 'hide-agent') tower.registry.drop('factory-test', message.agentId);
  if (message.type === 'agent-state') { const agent = agents.get(message.agentId); if (agent) publish({ ...agent, status: message.status ?? agent.status, currentActivity: message.activity ?? agent.currentActivity, lastEventAt: Date.now() }); }
});
process.on('SIGTERM', () => void shutdown()); process.on('SIGINT', () => void shutdown());
// Keep fixture data for inspection; this helper never touches the operator's real repository or sessions.
