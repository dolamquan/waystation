import type { PtyHandle, PtySpawn } from './types.ts';

/** Runs a terminal call that can throw if the process has just exited, so a race never becomes an uncaught exception. */
function guarded(action: string, run: () => void): void {
  try {
    run();
  } catch (error) {
    console.error(`[pty] could not ${action}:`, (error as Error).message);
  }
}

/**
 * Starts a real pseudo-terminal with node-pty. The native module loads on first use, so a machine where it
 * cannot load still runs everything else in Waystation and only fails when a console is opened.
 */
export const spawnNodePty: PtySpawn = async (file, args, options) => {
  let pty: typeof import('node-pty');
  try {
    // node-pty is CommonJS: plain Node hands it over as `default`, tsx (how the daemon runs) as the namespace itself.
    const loaded = await import('node-pty');
    pty = loaded.default ?? loaded;
  } catch (error) {
    throw new Error(`The terminal engine (node-pty) could not load: ${(error as Error).message}`);
  }
  const term = pty.spawn(file, [...args], {
    name: 'xterm-256color',
    cwd: options.cwd,
    cols: options.cols,
    rows: options.rows,
    env: { ...options.env },
  });
  const handle: PtyHandle = {
    pid: term.pid,
    onData: (listener) => { term.onData(listener); },
    onExit: (listener) => { term.onExit((event) => listener(event.exitCode)); },
    write: (data) => guarded('send input to the console', () => term.write(data)),
    resize: (cols, rows) => guarded('resize the console', () => term.resize(cols, rows)),
    kill: () => guarded('end the console process', () => term.kill()),
  };
  return handle;
};
