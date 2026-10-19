/** Live app previews: shared by the daemon's preview endpoints and the Preview tab. */

export type ScriptRunner = 'npm' | 'pnpm' | 'yarn' | 'bun';

export type PreviewPlan =
  | {
    readonly kind: 'script';
    readonly runner: ScriptRunner;
    readonly script: 'dev' | 'start';
    /** Shown to the operator before they start it, e.g. "npm run dev". */
    readonly command: string;
    /** No node_modules yet: the packages are installed first. */
    readonly needsInstall: boolean;
    readonly label: string;
  }
  | { readonly kind: 'static'; readonly root: string; readonly label: string }
  | { readonly kind: 'none'; readonly reason: string };

export type PreviewStatus = 'idle' | 'installing' | 'starting' | 'running' | 'failed';

export interface PreviewView {
  readonly folder: string;
  readonly status: PreviewStatus;
  readonly plan: PreviewPlan;
  /** Loopback address the app answers on, once running. */
  readonly url?: string;
  /** Plain-language reason the app isn't running, after a failure or an unexpected exit. */
  readonly error?: string;
  /** The app's recent console output, ANSI colours removed. */
  readonly log: readonly string[];
  readonly startedAt?: number;
}
