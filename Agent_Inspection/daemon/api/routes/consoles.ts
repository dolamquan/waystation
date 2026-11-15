import { UserError, type Tower } from '../../tower.ts';
import { ConsoleInputError } from '../../pty/types.ts';
import { KEY_ACTIONS, handoffBrief, isKeyAction, keysFor, plainTail, validateHandoff } from '../../pty/consoleKeys.ts';
import { bodyOf, r, type Route } from './route.ts';

const SUBMIT_DELAY_MS = 250;

/** Operator routes for the console board: real terminals running Claude Code, Codex or a shell. */
export function consoleRoutes(tower: Tower): Route[] {
  const requireConsole = (id: string) => {
    const info = tower.consoles.get(id);
    if (!info) throw new UserError('Console not found (it may have been closed).');
    return info;
  };
  return [
    r('GET', '/api/consoles', () => tower.consoleBoardSnapshot()),
    r('POST', '/api/consoles/:id/idea', ({ params, body }) => {
      const info = requireConsole(params[0]);
      const text = bodyOf(body).text;
      if (typeof text !== 'string' || !text.trim() || text.length > 24_000) throw new UserError('Send an idea between 1 and 24,000 characters. Select fewer canvas objects for a shorter brief.');
      if (info.kind === 'shell') throw new UserError('Choose an agent console; a shell would execute the idea as a command.');
      if (info.state !== 'running') throw new UserError('That agent console is no longer running.');
      tower.consoles.write(info.id, handoffBrief({ from: 'your planning canvas', task: text.trim(), context: '' }));
      setTimeout(() => {
        if (tower.consoles.get(info.id)?.state === 'running') tower.consoles.write(info.id, '\r');
      }, SUBMIT_DELAY_MS);
      tower.store.audit('canvas_idea', info.id, { characters: text.length });
      return { ok: true, message: `Idea sent to ${info.name}. Follow their work in the session beside your canvas.` };
    }),
    r('POST', '/api/consoles', async ({ body }) => {
      try {
        const console = await tower.consoles.create(body);
        tower.store.audit('console_open', console.id, { kind: console.kind, cwd: console.cwd });
        return { ok: true, console };
      } catch (error) {
        if (error instanceof ConsoleInputError) throw new UserError(error.message);
        throw new UserError(`Could not open the console: ${(error as Error).message}`);
      }
    }),
    // Consoles remembered from an earlier run: offered back, never launched without a click.
    r('GET', '/api/consoles/saved', () => ({ saved: tower.consoles.savedSpecs() })),
    r('POST', '/api/consoles/saved/:id/restore', async ({ params }) => {
      try {
        const console = await tower.consoles.restore(params[0]);
        tower.store.audit('console_restore', console.id, { kind: console.kind, cwd: console.cwd });
        return { ok: true, console };
      } catch (error) {
        if (error instanceof ConsoleInputError) throw new UserError(error.message);
        throw new UserError(`Could not restore the console: ${(error as Error).message}`);
      }
    }),
    r('POST', '/api/consoles/saved/:id/discard', ({ params, body }) => {
      if (bodyOf(body).confirm !== true) throw new UserError('Discarding a saved console requires confirm: true.');
      if (!tower.consoles.discard(params[0])) throw new UserError('That saved console is no longer available.');
      tower.store.audit('console_discard', params[0], {});
      return { ok: true };
    }),
    // Team controls: a fixed keystroke per action and console kind, never operator text.
    r('POST', '/api/consoles/:id/keys', ({ params, body }) => {
      const action = bodyOf(body).action;
      if (!isKeyAction(action)) throw new UserError(`Unknown action. Use one of: ${KEY_ACTIONS.join(', ')}.`);
      const info = requireConsole(params[0]);
      const keys = keysFor(action, info.kind);
      if (!keys || info.state !== 'running') return { ok: true, sent: false };
      tower.consoles.write(info.id, keys);
      tower.store.audit(`console_${action}`, info.id, {});
      return { ok: true, sent: true };
    }),
    // Hands a task to another agent console: a bracketed paste of the task plus this console's recent output, then Enter.
    r('POST', '/api/consoles/:id/handoff', ({ params, body }) => {
      let request;
      try { request = validateHandoff(body); } catch (error) { throw new UserError((error as Error).message); }
      const from = requireConsole(params[0]);
      const to = requireConsole(request.to);
      if (to.id === from.id) throw new UserError('Choose a different console to hand the task to.');
      if (to.kind === 'shell') throw new UserError('Hand tasks to a Claude Code or Codex console; a shell would run the brief as a command.');
      if (to.state !== 'running') throw new UserError(`${to.name} is not running.`);
      tower.consoles.write(to.id, handoffBrief({ from: from.name, task: request.task, context: plainTail(tower.consoles.scrollbackOf(from.id)) }));
      // The CLI needs a moment to take in the paste before Enter submits it as one message.
      setTimeout(() => tower.consoles.write(to.id, '\r'), SUBMIT_DELAY_MS);
      tower.store.audit('console_handoff', from.id, { to: to.id, task: request.task });
      return { ok: true, message: `Handed to ${to.name}.` };
    }),
    r('POST', '/api/consoles/:id/name', ({ params, body }) => {
      const info = requireConsole(params[0]);
      try { tower.consoles.rename(info.id, bodyOf(body).name); } catch (error) {
        if (error instanceof ConsoleInputError) throw new UserError(error.message);
        throw error;
      }
      tower.store.audit('console_rename', info.id, { name: tower.consoles.get(info.id)?.name });
      return { ok: true, console: tower.consoles.get(info.id) };
    }),
    r('POST', '/api/consoles/:id/kill', ({ params, body }) => {
      if (bodyOf(body).confirm !== true) throw new UserError('Ending a console requires confirm: true.');
      requireConsole(params[0]);
      tower.consoles.kill(params[0]);
      tower.store.audit('console_kill', params[0], {});
      return { ok: true };
    }),
    r('POST', '/api/consoles/:id/dismiss', ({ params, body }) => {
      const info = requireConsole(params[0]);
      if (info.state === 'running' && bodyOf(body).confirm !== true) throw new UserError('Closing a running console requires confirm: true.');
      tower.consoles.dismiss(params[0]);
      tower.store.audit('console_dismiss', params[0], {});
      return { ok: true };
    }),
  ];
}
