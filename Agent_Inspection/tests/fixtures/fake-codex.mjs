// Stand-in for the Codex CLI: reads the prompt from stdin and prints `codex exec --json` style events.
const args = process.argv.slice(2);
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => {
  const resumed = args[1] === 'resume';
  const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
  if (!resumed) out({ type: 'thread.started', thread_id: 'thread-123' });
  out({ type: 'item.started', item: { type: 'command_execution', command: 'ls' } });
  out({ type: 'item.completed', item: { type: 'agent_message', text: `${resumed ? 'resumed' : 'fresh'}: ${prompt}` } });
  if (prompt.includes('FAIL')) {
    process.stderr.write('simulated failure');
    process.exit(2);
  }
  out({ type: 'turn.completed' });
  if (prompt.includes('SLOW')) setTimeout(() => {}, 30_000);
});
