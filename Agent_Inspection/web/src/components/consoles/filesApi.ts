import { request, type ConsoleInfo } from '../../api.ts';
import type { FileContent, FolderEntry, FolderListing } from '../../../../daemon/files/folderFiles.ts';

/** Typed wrappers over /api/files (file tiles) and console renaming. api.ts is not edited for these. */
export type { FileContent, FolderEntry, FolderListing };

const q = encodeURIComponent;

/** One folder inside `root` ('' for the root itself). */
export const listFolder = async (root: string, dir = ''): Promise<FolderListing> =>
  (await request<{ listing: FolderListing }>('GET', `/api/files/list?root=${q(root)}&dir=${q(dir)}`)).listing;

/** One file inside `root`, as text, notebook, PDF or image; the daemon refuses anything outside the folder. */
export const readFile = async (root: string, path: string): Promise<FileContent & { revision?: string }> =>
  (await request<{ file: FileContent & { revision?: string } }>('GET', `/api/files/read?root=${q(root)}&path=${q(path)}`)).file;

export const writeFile = (root: string, path: string, text: string, revision: string) => request<{ revision: string; size: number }>('POST', '/api/files/write', { root, path, text, revision });
export type Runtime = import('../../../../daemon/files/workspaceRuntime.ts').ExecutionState;
export const kernels = () => request<{ kernels: { name: string; label: string; language: string }[] }>('GET', '/api/files/kernels');
export const startKernel = async (root: string, path: string, kernel: string) => (await request<{ runtime: Runtime }>('POST', '/api/files/kernel/start', { root, path, kernel })).runtime;
export const runFile = async (root: string, path: string) => (await request<{ runtime: Runtime }>('POST', '/api/files/run', { root, path })).runtime;
export const runtimeState = async (id: string) => (await request<{ runtime: Runtime }>('GET', `/api/files/runtime/${q(id)}`)).runtime;
export const executeCell = async (id: string, code: string) => (await request<{ runtime: Runtime }>('POST', `/api/files/runtime/${q(id)}/execute`, { code })).runtime;
export const interruptRuntime = async (id: string) => (await request<{ runtime: Runtime }>('POST', `/api/files/runtime/${q(id)}/interrupt`)).runtime;
export const closeRuntime = (id: string) => request('POST', `/api/files/runtime/${q(id)}/close`);

export const renameConsole = async (id: string, name: string): Promise<ConsoleInfo> =>
  (await request<{ console: ConsoleInfo }>('POST', `/api/consoles/${q(id)}/name`, { name })).console;
