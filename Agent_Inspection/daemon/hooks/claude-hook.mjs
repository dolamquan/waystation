#!/usr/bin/env node
// Agent Control Tower hook for Claude Code. Registered for PreToolUse, PostToolUse,
// UserPromptSubmit, Stop, SessionStart and SessionEnd.
// Safety rules:
//  - Intercept OFF: never block; if the tower is down the agent behaves normally.
//  - Intercept ON: any failure (no decision in time, daemon down, bad response) => "ask",
//    i.e. Claude Code's own permission prompt. Never a silent allow, never a hard block.
import { request } from 'node:http';
import { join } from 'node:path';
import {
  buildContextOutput, buildPreToolUseOutput, buildStopOutput,
  claimInbox, isIntercepting, readDaemonInfo,
} from './hookLogic.mjs';

const TOWER_HOME = process.env.AGENT_TOWER_HOME
  ?? join(process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? '.', 'AppData', 'Local'), 'agent-tower');
const EVENT_POST_TIMEOUT_MS = 400;
// Must stay below the hook's configured `timeout` (600s). Overridable for tests.
const DECISION_TIMEOUT_MS = Number(process.env.AGENT_TOWER_HOOK_TIMEOUT_MS) || 570_000;

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
  });
}

/**
 * POST with an explicit overall timeout. Uses node:http rather than fetch because
 * fetch (undici) aborts responses that take longer than 300s, which would break
 * long approvals.
 */
function post(info, route, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = request({
      host: '127.0.0.1',
      port: info.port,
      path: route,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(data),
        'x-tower-token': info.token,
      },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        clearTimeout(timer);
        if (res.statusCode !== 200) return reject(new Error(`daemon responded ${res.statusCode}`));
        try {
          resolve(JSON.parse(text));
        } catch (error) {
          reject(error);
        }
      });
    });
    const timer = setTimeout(() => req.destroy(new Error('timed out')), timeoutMs);
    req.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    req.end(data);
  });
}

const emit = (output) => {
  if (output) process.stdout.write(JSON.stringify(output));
};

async function main() {
  if (process.env.AGENT_TOWER_MANAGED === '1') return;
  const input = JSON.parse((await readStdin()) || '{}');
  const event = input.hook_event_name;
  const sessionId = typeof input.session_id === 'string' ? input.session_id : '';
  const info = readDaemonInfo(TOWER_HOME);

  const notify = async (extra = {}) => {
    if (!info) return;
    await post(info, '/hook/event', { ...input, ...extra }, EVENT_POST_TIMEOUT_MS).catch(() => undefined);
  };

  if (event === 'PreToolUse') {
    if (!isIntercepting(TOWER_HOME, sessionId)) {
      await notify();
      return;
    }
    if (!info) {
      emit(buildPreToolUseOutput({ behavior: 'ask' }));
      return;
    }
    try {
      const decision = await post(info, '/hook/pretooluse', input, DECISION_TIMEOUT_MS);
      emit(buildPreToolUseOutput(decision));
    } catch {
      emit(buildPreToolUseOutput({ behavior: 'ask' }));
    }
    return;
  }

  if (event === 'Stop' || event === 'PostToolUse' || event === 'UserPromptSubmit') {
    const { instructions, commit } = claimInbox(TOWER_HOME, sessionId);
    emit(event === 'Stop' ? buildStopOutput(instructions) : buildContextOutput(event, instructions));
    commit();
    await notify({ delivered: instructions });
    return;
  }

  await notify();
}

main().catch(() => process.exit(0));
