import { useId, type ComponentProps, type KeyboardEvent, type ReactNode } from 'react';
import { Icon } from './Icon.tsx';
import { WorkspaceDoodle } from './WorkspaceDoodle.tsx';

export interface SectionTab<T extends string> {
  readonly id: T;
  readonly label: string;
  readonly description?: string;
  readonly icon: ComponentProps<typeof Icon>['name'];
  readonly count?: number;
}

/** One focusable tab at a time, with standard arrow, Home and End navigation. */
export function SectionTabs<T extends string>({ tabs, value, onChange, label, panelId, cards = false }: {
  readonly tabs: readonly SectionTab<T>[];
  readonly value: T;
  readonly onChange: (value: T) => void;
  readonly label: string;
  readonly panelId: string;
  readonly cards?: boolean;
}) {
  const id = useId();
  const onKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
      : event.key === 'ArrowRight' ? (index + 1) % tabs.length
      : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : undefined;
    if (next === undefined) return;
    event.preventDefault();
    onChange(tabs[next].id);
    document.getElementById(`${id}-${tabs[next].id}`)?.focus();
  };
  return <nav className={`section-tabs${cards ? ' section-tabs-cards' : ''}`} role="tablist" aria-label={label}>
    {tabs.map((tab, index) => <button key={tab.id} id={`${id}-${tab.id}`} role="tab"
      aria-selected={value === tab.id} aria-controls={panelId} tabIndex={value === tab.id ? 0 : -1}
      onClick={() => onChange(tab.id)} onKeyDown={(event) => onKey(event, index)}>
      <span className="section-tab-icon"><Icon name={tab.icon} size={cards ? 21 : 17} /></span>
      <span className="section-tab-copy"><span className="section-tab-label">{tab.label}{tab.count !== undefined && <span className="section-tab-count">{tab.count}</span>}</span>
        {cards && <span className="section-tab-description">{tab.description}</span>}</span>
    </button>)}
  </nav>;
}

export function PanelEmpty({ icon, title, children }: {
  readonly icon: ComponentProps<typeof Icon>['name'];
  readonly title: string;
  readonly children: ReactNode;
}) {
  return <div className="panel-empty"><span className="panel-empty-icon">{icon === 'book' ? <WorkspaceDoodle kind="books" /> : icon === 'clock' ? <WorkspaceDoodle kind="planner" /> : <Icon name={icon} size={25} />}</span><h3>{title}</h3>{children}</div>;
}
