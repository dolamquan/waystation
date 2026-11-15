import type { IncomingMessage } from 'node:http';
import { FolderFileError, listFolder, readFolderFile } from '../../files/folderFiles.ts';
import { UserError } from '../../userError.ts';
import { bodyOf, r, type Route } from './route.ts';
import { editableFile, writeFolderFile } from '../../files/fileEditing.ts';
import { workspaceRuntime } from '../../files/workspaceRuntime.ts';

const queryParam = (req: IncomingMessage, name: string): string | null =>
  new URL(req.url ?? '/', 'http://localhost').searchParams.get(name);

/** Expected refusals (outside the folder, too large, binary) become 400s with their message. */
function guarded<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof FolderFileError) throw new UserError(error.message);
    throw error;
  }
}

/** Operator routes (token already checked) for the canvas's file tiles: browse a folder, read one file. Read-only. */
export function fileRoutes(): Route[] {
  return [
    r('GET', '/api/files/list', ({ req }) => guarded(() => ({ listing: listFolder(queryParam(req, 'root'), queryParam(req, 'dir') ?? '') }))),
    r('GET', '/api/files/read', ({ req }) => guarded(() => ({ file: editableFile(queryParam(req, 'root'), queryParam(req, 'path')) }))),
    r('POST', '/api/files/write', ({ body }) => guarded(() => ({ ok: true, ...writeFolderFile(bodyOf(body)) }))),
    r('GET', '/api/files/kernels', async () => {
      try { return { kernels: await workspaceRuntime.kernels() }; } catch (error) { throw new UserError((error as Error).message); }
    }),
    r('POST', '/api/files/kernel/start', async ({ body }) => {
      try { return { runtime: await workspaceRuntime.startKernel(bodyOf(body)) }; } catch (error) { throw new UserError((error as Error).message); }
    }),
    r('GET', '/api/files/runtime/:id', ({ params }) => guarded(() => ({ runtime: workspaceRuntime.get(params[0]) }))),
    r('POST', '/api/files/runtime/:id/execute', ({ params, body }) => guarded(() => ({ runtime: workspaceRuntime.execute(params[0], bodyOf(body).code) }))),
    r('POST', '/api/files/runtime/:id/interrupt', ({ params }) => guarded(() => ({ runtime: workspaceRuntime.interrupt(params[0]) }))),
    r('POST', '/api/files/runtime/:id/close', ({ params }) => { workspaceRuntime.close(params[0]); return { ok: true }; }),
    r('POST', '/api/files/run', ({ body }) => guarded(() => ({ runtime: workspaceRuntime.run(bodyOf(body)) }))),
  ];
}
