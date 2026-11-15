#!/usr/bin/env node
// Waystation channel CLI: lets a coding agent (Claude Code, Codex, Gemini, Copilot…) message the other
// sessions its operator put on the same channel. Dependency-free; run it from the agent's own shell.
// The daemon works out which session is calling from this process's parent chain (or WAYSTATION_AGENT_ID
// for agents Waystation launched), so an agent can only speak as itself and only to its channels.

import { request } from 'node:http';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const TOWER_HOME = process.env.AGENT_TOWER_HOME
  ?? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'agent-tower');
const MAX_WAIT_PER_CALL_S = 240;
const MAX_WAIT_TOTAL_S = 600;
const DEFAULT_WAIT_S = 60;
const CALL_TIMEOUT_MS = 30_000;

const USAGE = `Usage: ws-channel <command> [options]

Commands:
  whoami                         Your channels, your name in each, and the other members
  send <name|all> <text...>      Message a member (or everyone); wakes the recipient
  send <name|all> -              Read the message text from stdin
  inbox [--all]                  Unread messages (--all: recent history)
  wait [--from <name>] [--timeout <seconds>]
                                 Wait for a message (default ${DEFAULT_WAIT_S}s, at most ${MAX_WAIT_TOTAL_S}s)

Options:
  --channel <name>    Needed when this session is in more than one channel
  --reply-to <id>     Mark a message as a reply (send)
  --no-wake           Leave the message in the inbox instead of waking the recipient (send)
  --json              Print the raw JSON response`;

class CliError extends Error {}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  const valued = new Set(['--channel', '--reply-to', '--from', '--timeout']);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (valued.has(arg)) {
      if (i + 1 >= argv.length) throw new CliError(`${arg} needs a value.`);
      flags[arg.slice(2)] = argv[++i];
    } else if (arg === '--no-wake' || arg === '--json' || arg === '--all' || arg === '--help' || arg === '-h') {
      flags[arg.replace(/^-+/, '')] = true;
    } else positional.push(arg);
  }
  return { command: positional[0], rest: positional.slice(1), flags };
}

function readConnection() {
  try {
    const info = JSON.parse(readFileSync(join(TOWER_HOME, 'channels.json'), 'utf8'));
    if (typeof info.port === 'number' && typeof info.token === 'string') return info;
  } catch { /* falls through */ }
  throw new CliError('Waystation is not running (no channels.json in its state folder). Ask your operator to start it.');
}

/** node:http rather than fetch: fetch (undici) gives up on responses slower than 300s. */
function call(connection, command, body, timeoutMs) {
  const data = JSON.stringify({
    ...body,
    caller: { pid: process.pid, ppid: process.ppid, agentId: process.env.WAYSTATION_AGENT_ID || undefined },
  });
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port: connection.port, path: `/agent/channel/${command}`, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), 'x-channel-token': connection.token },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        clearTimeout(timer);
        let parsed = {};
        try { parsed = JSON.parse(text); } catch { /* keep {} */ }
        if (res.statusCode !== 200) reject(new CliError(parsed.error ?? `Waystation answered ${res.statusCode}.`));
        else resolve(parsed);
      });
    });
    const timer = setTimeout(() => req.destroy(new CliError('Waystation did not answer in time.')), timeoutMs);
    req.on('error', (error) => {
      clearTimeout(timer);
      reject(error instanceof CliError ? error : new CliError(`Could not reach Waystation: ${error.message}`));
    });
    req.end(data);
  });
}

async function readStdin() {
  let text = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

const line = (message) => {
  const to = message.to === 'all' ? 'everyone' : message.to;
  const reply = message.replyTo ? ` (reply to ${message.replyTo})` : '';
  return `[${message.id}] ${message.from} → ${to}${reply} at ${message.at}\n${message.text}`;
};

const printMessages = (channel, messages, empty) =>
  console.log(messages.length === 0 ? empty : `#${channel}: ${messages.length} message(s)\n\n${messages.map(line).join('\n\n')}`);

function printWhoami(result) {
  if (result.channels.length === 0) {
    console.log(`This session (${result.agentName ?? result.agentId}) is not in any channel. Only the operator can add sessions, from the Waystation dashboard.`);
    return;
  }
  for (const channel of result.channels) {
    const peers = channel.peers.map((peer) => `${peer.name} (${peer.vendor}, ${peer.status})`).join(', ') || 'nobody else yet';
    console.log(`#${channel.name}: you are "${channel.you}"${channel.purpose ? `. Purpose: ${channel.purpose}` : ''}\n  Members: ${peers}`);
  }
}

function printSend(result) {
  console.log(`Sent ${result.message.id} in #${result.channel}.`);
  for (const delivery of result.deliveries) {
    const how = { waiting: 'received it (was waiting)', woken: 'woken', inbox: 'left in inbox' }[delivery.via] ?? delivery.via;
    console.log(`  ${delivery.to}: ${how}${delivery.note ? ` (${delivery.note})` : ''}`);
  }
}

async function waitFor(connection, flags) {
  const requested = flags.timeout === undefined ? DEFAULT_WAIT_S : Number(flags.timeout);
  if (!Number.isFinite(requested) || requested <= 0) throw new CliError('--timeout must be a positive number of seconds.');
  let remaining = Math.min(Math.round(requested), MAX_WAIT_TOTAL_S);
  for (;;) {
    const slice = Math.min(remaining, MAX_WAIT_PER_CALL_S);
    const result = await call(connection, 'wait', { channel: flags.channel, from: flags.from, timeoutSeconds: slice }, (slice + 30) * 1000);
    remaining -= slice;
    if (result.messages.length > 0 || result.removed || remaining <= 0) return result;
  }
}

async function main() {
  const { command, rest, flags } = parseArgs(process.argv.slice(2));
  if (!command || flags.help || command === 'help') {
    console.log(USAGE);
    return;
  }
  const connection = readConnection();
  const json = (result) => console.log(JSON.stringify(result, null, 2));
  switch (command) {
    case 'whoami':
    case 'peers': {
      const result = await call(connection, 'whoami', {}, CALL_TIMEOUT_MS);
      if (flags.json) json(result); else printWhoami(result);
      return;
    }
    case 'send': {
      const [to, ...words] = rest;
      if (!to || words.length === 0) throw new CliError('Usage: ws-channel send <name|all> <text...>  (or - to read stdin)');
      const text = words.length === 1 && words[0] === '-' ? await readStdin() : words.join(' ');
      const result = await call(connection, 'send', {
        channel: flags.channel, to, text, replyTo: flags['reply-to'], wake: flags['no-wake'] !== true,
      }, CALL_TIMEOUT_MS);
      if (flags.json) json(result); else printSend(result);
      return;
    }
    case 'inbox': {
      const result = await call(connection, 'inbox', { channel: flags.channel, all: flags.all === true }, CALL_TIMEOUT_MS);
      if (flags.json) json(result); else printMessages(result.channel, result.messages, `No unread messages in #${result.channel}.`);
      return;
    }
    case 'wait': {
      const result = await waitFor(connection, flags);
      if (flags.json) json(result);
      else if (result.removed) console.log('The operator removed this session from the channel.');
      else printMessages(result.channel, result.messages, `No message arrived in #${result.channel} before the timeout.`);
      return;
    }
    default:
      throw new CliError(`Unknown command "${command}".\n\n${USAGE}`);
  }
}

main().catch((error) => {
  process.stderr.write(`ws-channel: ${error instanceof CliError ? error.message : error?.message ?? error}\n`);
  process.exitCode = 1;
});
