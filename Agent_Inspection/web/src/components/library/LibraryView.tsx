import { useState } from 'react';
import { Icon } from '../Icon.tsx';
import { SectionTabs, type SectionTab } from '../SectionTabs.tsx';
import { DocsPanel } from './DocsPanel.tsx';
import { IntegrationsPanel } from './IntegrationsPanel.tsx';
import { NotificationsPanel } from './NotificationsPanel.tsx';
import { SkillsPanel } from './SkillsPanel.tsx';

export interface LibraryPanelProps {
  readonly notify: (text: string, kind?: 'ok' | 'error') => void;
}

type Tab = 'skills' | 'docs' | 'integrations' | 'notifications';

const TABS: readonly SectionTab<Tab>[] = [
  { id: 'skills', label: 'Skills', icon: 'sparkle', description: 'Instructions to reuse' },
  { id: 'docs', label: 'Context docs', icon: 'book', description: 'Notes for the task' },
  { id: 'integrations', label: 'Tools & plugins', icon: 'link', description: 'Useful connections' },
  { id: 'notifications', label: 'Notifications', icon: 'message', description: 'Updates from your agents' },
];

/** Everything an agent can be given at launch, managed in one place. */
export function LibraryView({ notify, initialTab = 'skills' }: LibraryPanelProps & { readonly initialTab?: Tab }) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const current = TABS.find((t) => t.id === tab) ?? TABS[0];

  return (
    <section className="library-view" aria-label="Agent library">
      <SectionTabs tabs={TABS} value={tab} onChange={setTab} label="Library sections" panelId="library-panel" cards />
      <p className="library-guide"><Icon name="info" size={16} /><span>Pick things from this shelf in <b>New agent</b> or when you make a schedule.</span></p>
      <div id="library-panel" role="tabpanel" aria-label={current.label} className="library-panel">
        {tab === 'skills' && <SkillsPanel notify={notify} />}
        {tab === 'docs' && <DocsPanel notify={notify} />}
        {tab === 'integrations' && <IntegrationsPanel notify={notify} />}
        {tab === 'notifications' && <NotificationsPanel notify={notify} />}
      </div>
    </section>
  );
}
