import type { TowerStore } from '../store/db.ts';
import type { SecretStore } from './secretStore.ts';

/** What every library module is constructed with. Tests pass temp folders and an in-memory store. */
export interface LibraryDeps {
  readonly store: TowerStore;
  readonly secrets: SecretStore;
  readonly paths: {
    readonly skillsLibraryDir: string;
    readonly docsDir: string;
    readonly loadoutsDir: string;
    readonly claudeHome: string;
  };
  /** Records to the audit log. */
  readonly audit: (action: string, target: string, detail: unknown) => void;
}
