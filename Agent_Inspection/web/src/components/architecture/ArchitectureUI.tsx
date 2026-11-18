import type { ComponentProps, ReactNode } from 'react';
import { Icon } from '../Icon.tsx';

type IconName = ComponentProps<typeof Icon>['name'];

export function ResourceMark({ icon }: { icon: IconName }) {
  return <span className="platform-resource-mark" aria-hidden="true"><Icon name={icon} size={19} /></span>;
}

export function StatusBadge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'success' | 'warning' | 'error' }) {
  return <span className={`platform-badge tone-${tone}`}><span aria-hidden="true" />{children}</span>;
}

export function WorkspaceEmpty({ icon, title, children, action }: { icon: IconName; title: string; children: ReactNode; action?: ReactNode }) {
  return <div className="platform-empty-state"><span className="platform-empty-mark" aria-hidden="true"><Icon name={icon} size={24} /></span><h3>{title}</h3><p>{children}</p>{action}</div>;
}

/** One icon per Architecture section, shared by the section tabs and each section's heading. */
export const SECTION_ICONS = {
  design: 'git', agents: 'sparkle', capabilities: 'grid', connections: 'link', 'app-access': 'planet',
  environments: 'tower', secrets: 'shield', sandboxes: 'terminal', evaluation: 'check', activity: 'activity',
} as const satisfies Record<string, IconName>;
