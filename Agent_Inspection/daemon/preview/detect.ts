import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { PreviewPlan, ScriptRunner } from './types.ts';

/** Dependencies that mean `npm start` serves a web page rather than running a CLI or a bot. */
const WEB_TOOLS = [
  'vite', 'next', 'react-scripts', 'astro', '@sveltejs/kit', 'nuxt', 'parcel', 'webpack-dev-server', 'gatsby',
  '@angular/cli', '@vue/cli-service', 'serve', 'http-server', 'live-server', 'express',
] as const;
/** Folders a plain website usually lives in, checked in order after the project folder itself. */
const STATIC_DIRS = ['', 'public', 'dist', 'build', 'site', 'docs'] as const;
const LOCKFILES: ReadonlyArray<readonly [string, ScriptRunner]> = [
  ['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lockb', 'bun'], ['bun.lock', 'bun'],
];

const NOTHING_YET = 'Nothing to preview yet. When an agent builds a website or app in this folder, you can see it here.';
const NO_FOLDER = 'This agent’s folder no longer exists.';

interface PackageJson {
  readonly scripts?: Record<string, unknown>;
  readonly dependencies?: Record<string, unknown>;
  readonly devDependencies?: Record<string, unknown>;
}

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

function readPackage(cwd: string): PackageJson | undefined {
  const file = join(cwd, 'package.json');
  if (!isFile(file)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as PackageJson : undefined;
  } catch {
    return undefined;
  }
}

function runnerFor(cwd: string): ScriptRunner {
  return LOCKFILES.find(([lockfile]) => isFile(join(cwd, lockfile)))?.[1] ?? 'npm';
}

/** `dev` when present; otherwise `start`, but only when the project depends on a web server or framework. */
function scriptFor(pkg: PackageJson): 'dev' | 'start' | undefined {
  const has = (name: string) => typeof pkg.scripts?.[name] === 'string';
  if (has('dev')) return 'dev';
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  return has('start') && WEB_TOOLS.some((tool) => tool in deps) ? 'start' : undefined;
}

function staticPlan(cwd: string): PreviewPlan | undefined {
  const dir = STATIC_DIRS.find((candidate) => isFile(join(cwd, candidate, 'index.html')));
  if (dir === undefined) return undefined;
  return { kind: 'static', root: join(cwd, dir), label: dir ? `Shows the website in the ${dir} folder` : 'Shows the website in this folder' };
}

/**
 * How Waystation can show what was built in `cwd`: run the project's own dev script, serve a plain
 * website, or nothing. Commands come only from this fixed set, never from the request or the agent.
 */
export function detectPreview(cwd: string | undefined): PreviewPlan {
  if (!cwd) return { kind: 'none', reason: 'No project folder was recorded for this session.' };
  if (!isDirectory(cwd)) return { kind: 'none', reason: NO_FOLDER };
  const pkg = readPackage(cwd);
  const script = pkg && scriptFor(pkg);
  if (script) {
    const runner = runnerFor(cwd);
    return {
      kind: 'script',
      runner,
      script,
      command: `${runner} run ${script}`,
      needsInstall: !existsSync(join(cwd, 'node_modules')),
      label: 'Runs the app the way a developer would',
    };
  }
  return staticPlan(cwd) ?? { kind: 'none', reason: NOTHING_YET };
}
