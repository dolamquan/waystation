/** Unreleased workspaces stay unavailable unless a developer explicitly enables the preview at build time. */
export const previewWorkspacesEnabled = import.meta.env.VITE_ENABLE_UNRELEASED_WORKSPACES === 'true';

export function workspaceAvailable(view: string): boolean {
  return previewWorkspacesEnabled || (view !== 'factory' && view !== 'architecture');
}
