import type { ComponentProps, ReactNode } from 'react';
import { Icon } from '../Icon.tsx';

export function ResourceMark({ icon }: { icon: ComponentProps<typeof Icon>['name'] }) {
  return <span className="platform-resource-mark" aria-hidden="true"><Icon name={icon} size={19} /></span>;
}

export function StatusBadge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'success' | 'warning' | 'error' }) {
  return <span className={`platform-badge tone-${tone}`}><span aria-hidden="true" />{children}</span>;
}

export function WorkspaceEmpty({ icon, title, children }: { icon: ComponentProps<typeof Icon>['name']; title: string; children: ReactNode }) {
  return <div className="platform-empty-state"><Icon name={icon} size={26} /><h3>{title}</h3><p>{children}</p></div>;
}
