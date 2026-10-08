import { AnimatePresence } from 'framer-motion';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type AgentTemplate, type Prerequisite, type ScheduleView, type UsageSummary } from '../api.ts';
import { formatTokens, formatUsd, shortModel } from '../format.ts';
import { Icon } from './Icon.tsx';
import { Confirm } from './Modal.tsx';
import { DAY_NAMES, ScheduleForm } from './ScheduleForm.tsx';
import { PanelEmpty, SectionTabs, type SectionTab } from './SectionTabs.tsx';
import { UsageWindows } from './UsageWindows.tsx';

interface OpsViewProps {
  readonly defaultCwd?: string;
  readonly notify: (text: string, kind?: 'ok' | 'error') => void;
  readonly onNewAgent: () => void;
}
interface Loaded {
  readonly usage?: UsageSummary;
  readonly schedules: ScheduleView[];
  readonly templates: AgentTemplate[];
  readonly prerequisites: Prerequisite[];
}
type Tab = 'usage' | 'schedules' | 'templates' | 'setup';
type ScheduleFilter = 'all' | 'active' | 'paused';

export function OpsView({ defaultCwd, notify, onNewAgent }: OpsViewProps) {
  const [tab, setTab] = useState<Tab>('usage');
  const [data, setData] = useState<Loaded>({ schedules: [], templates: [], prerequisites: [] });
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [editingId, setEditingId] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ScheduleFilter>('all');
  const [confirm, setConfirm] = useState<{ title: string; body: string; action: () => Promise<void> }>();
  const [windowsKey, setWindowsKey] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [usage, schedules, templates, prerequisites] = await Promise.all([
        api.usage(7), api.schedules(), api.templates(), api.prerequisites(),
      ]);
      setData({ usage: usage.usage, schedules: schedules.schedules, templates: templates.templates, prerequisites: prerequisites.prerequisites });
      setError(undefined);
      setLoaded(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const act = async (id: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(id);
    try {
      await fn();
      notify(ok);
      await load();
    } catch (err) {
      notify((err as Error).message, 'error');
    } finally {
      setBusy(undefined);
    }
  };
  const tabs: readonly SectionTab<Tab>[] = [
    { id: 'usage', label: 'Usage', icon: 'activity' },
    { id: 'schedules', label: 'Schedules', icon: 'clock', count: loaded ? data.schedules.length : undefined },
    { id: 'templates', label: 'Templates', icon: 'copy', count: loaded ? data.templates.length : undefined },
    { id: 'setup', label: 'Setup checks', icon: 'shield' },
  ];
  const schedules = useMemo(() => data.schedules.filter((s) =>
    (filter === 'all' || s.enabled === (filter === 'active')) &&
    `${s.label} ${s.launch.cwd} ${s.launch.prompt}`.toLowerCase().includes(query.trim().toLowerCase()),
  ), [data.schedules, filter, query]);
  const missing = data.prerequisites.filter((p) => !p.ok).length;
  const createSchedule = () => { setTab('schedules'); setEditingId(undefined); setShowNew(true); };

  return <div className="ops-view ops-workspace">
    <div className="workspace-toolbar">
      <SectionTabs tabs={tabs} value={tab} onChange={setTab} label="Usage and automation sections" panelId="ops-panel" />
      <button className="btn btn-ghost" disabled={loading} onClick={() => { setWindowsKey((k) => k + 1); void load(); }}><Icon name="refresh" size={15} />{loading ? 'Refreshing…' : 'Refresh'}</button>
    </div>
    {error && <div className="detail-load-error" role="alert"><p>Couldn’t load this page. {error}</p><button className="btn" onClick={() => void load()}>Try again</button></div>}
    {!loaded && loading && <div className="workspace-loading" role="status"><Icon name="clock" />Loading usage and schedules…</div>}
    {loaded && <div id="ops-panel" role="tabpanel" aria-label={tabs.find((t) => t.id === tab)?.label} className="ops-tab-panel" aria-busy={loading}>
      {tab === 'usage' && <div className="usage-dashboard">
        <UsageWindows refreshKey={windowsKey} />
        <SpendSection usage={data.usage} />
        <div className="automation-callout"><span className="automation-icon"><Icon name="clock" size={24} /></span><div><h3>Something you do every morning?</h3><p>Put it on the calendar. You can pause it whenever you need.</p></div><button className="btn" onClick={createSchedule}>Add a schedule<Icon name="arrow" size={15} /></button></div>
      </div>}

      {tab === 'schedules' && <section className="ops-section workspace-panel" aria-labelledby="ops-schedules">
        <div className="section-heading"><div><h2 id="ops-schedules">Recurring tasks</h2><p>Tasks that run on the days you choose.</p></div><button className="btn btn-go" onClick={createSchedule} disabled={showNew}><Icon name="plus" size={16} />New schedule</button></div>
        <div className="workspace-note"><Icon name="info" size={16} /><span>Times use this machine’s timezone ({Intl.DateTimeFormat().resolvedOptions().timeZone}). Keep Waystation running; missed runs are skipped.</span></div>
        {showNew && <ScheduleForm defaultCwd={defaultCwd} onDone={() => { setShowNew(false); void load(); }} notify={notify} />}
        {data.schedules.length > 0 && <div className="resource-toolbar"><label className="resource-search"><Icon name="search" size={17} /><input type="search" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search schedules" placeholder="Search tasks or projects…" /></label><div className="filter-buttons" aria-label="Schedule status">{(['all', 'active', 'paused'] as const).map((f) => <button key={f} aria-pressed={filter === f} onClick={() => setFilter(f)}>{f === 'all' ? 'All schedules' : f === 'active' ? 'Active' : 'Paused'}</button>)}</div></div>}
        {data.schedules.length === 0 && !showNew && <PanelEmpty icon="clock" title="Nothing on the calendar yet"><p>A daily PR review or a weekly project update is a good place to start.</p><button className="btn btn-go" onClick={createSchedule}><Icon name="plus" size={16} />New schedule</button></PanelEmpty>}
        {data.schedules.length > 0 && schedules.length === 0 && <PanelEmpty icon="search" title="No matching schedules"><p>Try a different search or show all schedules.</p><button className="btn" onClick={() => { setQuery(''); setFilter('all'); }}>Clear filters</button></PanelEmpty>}
        <ul className="schedule-cards">
          {schedules.map((s) => <li key={s.id}>{editingId === s.id
            ? <ScheduleForm schedule={s} onDone={() => { setEditingId(undefined); void load(); }} notify={notify} />
            : <article className="schedule-card">
              <div className="schedule-card-head"><span className="schedule-card-icon"><Icon name="clock" size={21} /></span><div><h3>{s.label}</h3><span className={`status-pill ${s.enabled ? 'status-active' : ''}`}>{s.enabled ? 'Active' : 'Paused'}</span></div><div className="schedule-enable"><span>{s.enabled ? 'On' : 'Off'}</span><button className="detail-switch" role="switch" aria-checked={s.enabled} aria-label={`${s.label} enabled`} disabled={!!busy} onClick={() => void act(s.id, () => api.setScheduleEnabled(s.id, !s.enabled), s.enabled ? 'Schedule paused' : 'Schedule on')}><span /></button></div></div>
              <p className="schedule-task">{s.launch.prompt}</p>
              <div className="schedule-timing"><strong>{s.time}</strong><span>{s.days.length === 7 ? 'Every day' : s.days.map((d) => DAY_NAMES[d]).join(', ')}</span></div>
              <div className="schedule-next">{s.enabled ? (s.nextRunAt ? <>Next run <time dateTime={new Date(s.nextRunAt).toISOString()}>{new Date(s.nextRunAt).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time></> : 'Waiting for the next run') : 'Paused until you turn it on'}{s.lastResult && <span>Last run: {s.lastResult}</span>}</div>
              <div className="schedule-card-meta"><span><Icon name="terminal" size={14} />{s.launch.vendor === 'codex' ? 'Codex' : 'Claude'}{s.launch.model ? ` · ${shortModel(s.launch.model)}` : ''}</span><span title={s.launch.cwd}><Icon name="folder" size={14} />{s.launch.cwd}</span></div>
              <details className="schedule-details"><summary>Resources &amp; run settings</summary><p>{s.resources?.length ?? 0} resources · {s.maxMinutes ?? 60} minute limit · {s.stopWhenDone === false ? 'keeps running when done' : 'stops when done'}</p><p>{s.notify && s.notify.when !== 'never' ? `Updates ${s.notify.when === 'failure' ? 'on failure' : 'after every run'} to inbox${s.notify.channelIds.length ? ` and ${s.notify.channelIds.length} channels` : ''}` : 'Notifications off'}</p></details>
              <footer><button className="btn btn-small" disabled={!!busy} onClick={() => void act(s.id, () => api.runSchedule(s.id), `Launched ${s.label}`)}><Icon name="play" size={14} />{busy === s.id ? 'Working…' : 'Run now'}</button><button className="btn btn-small btn-ghost" aria-label={`Edit ${s.label}`} onClick={() => { setShowNew(false); setEditingId(s.id); }}>Edit</button><button className="icon-btn schedule-delete" aria-label={`Delete ${s.label}`} title="Delete schedule" disabled={!!busy} onClick={() => setConfirm({ title: `Delete ${s.label}?`, body: 'It will no longer launch agents. Agents it already launched keep running.', action: () => act(s.id, () => api.deleteSchedule(s.id), 'Schedule deleted') })}><Icon name="trash" size={16} /></button></footer>
            </article>}
          </li>)}
        </ul>
      </section>}

      {tab === 'templates' && <section className="ops-section workspace-panel" aria-labelledby="ops-templates">
        <div className="section-heading"><div><h2 id="ops-templates">Saved starting points</h2><p>Reuse an agent’s model, instructions and task when you start new work.</p></div><button className="btn btn-go" onClick={onNewAgent}><Icon name="plus" size={16} />New agent</button></div>
        <div className="workspace-note"><Icon name="info" size={16} /><span>Create a template with <b>Save as template</b> in New agent. To use one, choose it from the template menu before launching.</span></div>
        {data.templates.length === 0 && <PanelEmpty icon="copy" title="No saved setups yet"><p>Save a setup in New agent to use it again later.</p><button className="btn" onClick={onNewAgent}>Open New agent<Icon name="arrow" size={15} /></button></PanelEmpty>}
        <ul className="template-cards">{data.templates.map((t) => <li key={t.id} className="template-card"><span className="template-icon"><Icon name="copy" size={20} /></span><div><h3>{t.label}</h3><span className="status-pill">{t.vendor === 'codex' ? 'Codex' : 'Claude'} · {t.model ? shortModel(t.model) : 'Default model'}</span>{t.prompt && <p>{t.prompt}</p>}{t.agentName && <small>Agent name: {t.agentName}</small>}{t.instructions && <small>Includes role instructions</small>}</div><button className="icon-btn" disabled={!!busy} aria-label={`Delete ${t.label}`} onClick={() => setConfirm({ title: `Delete ${t.label}?`, body: 'Agents launched from it are not affected.', action: () => act(t.id, () => api.deleteTemplate(t.id), 'Template deleted') })}><Icon name="trash" size={16} /></button></li>)}</ul>
      </section>}

      {tab === 'setup' && <section className="ops-section workspace-panel" aria-labelledby="ops-prereqs">
        <div className="section-heading"><div><h2 id="ops-prereqs">Setup checks</h2><p>What’s installed on this machine, and what it’s used for.</p></div><span className={`status-pill ${missing ? 'status-warning' : 'status-active'}`}>{missing ? `${missing} to check` : 'All checks passed'}</span></div>
        <div className="workspace-note"><Icon name="info" size={16} /><span>These checks only report what’s installed. Use Refresh to check again after setting up a tool.</span></div>
        <ul className="ops-list setup-list">{data.prerequisites.map((p) => <li key={p.id} className={`ops-row prereq-${p.ok ? 'ok' : 'missing'}`}><span className="prereq-mark"><Icon name={p.ok ? 'check' : 'alert'} size={20} /></span><div className="ops-row-main"><strong>{p.label}</strong><p>{p.purpose}</p><small>{p.detail}</small></div><span className={`status-pill ${p.ok ? 'status-active' : 'status-warning'}`}>{p.ok ? 'Available' : 'Not found'}</span></li>)}</ul>
      </section>}
    </div>}
    <AnimatePresence>{confirm && <Confirm title={confirm.title} body={confirm.body} confirmLabel="Delete" danger onConfirm={() => void confirm.action()} onClose={() => setConfirm(undefined)} />}</AnimatePresence>
  </div>;
}

function SpendSection({ usage }: { readonly usage?: UsageSummary }) {
  const week = usage?.byDay.reduce((sum, day) => ({ tokens: sum.tokens + day.tokens, costUsd: sum.costUsd + day.costUsd }), { tokens: 0, costUsd: 0 });
  const maxCost = Math.max(0.01, ...(usage?.byDay.map((d) => d.costUsd) ?? []));
  const [query, setQuery] = useState('');
  const agents = (usage?.byAgent ?? []).filter((row) => `${row.name} ${row.project} ${row.model ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()));
  return <div className="usage-content">
    <div className="metric-grid ops-metrics" aria-label="Usage summary">
      <div className="metric"><div className="metric-label">Today’s spend<Icon name="activity" size={17} /></div><div className="metric-value">{formatUsd(usage?.today.costUsd ?? 0)}</div><div className="metric-note">Estimated · {formatTokens(usage?.today.tokens ?? 0)} tokens</div></div>
      <div className="metric"><div className="metric-label">This week’s spend<Icon name="clock" size={17} /></div><div className="metric-value">{formatUsd(week?.costUsd ?? 0)}</div><div className="metric-note">Estimated over the last 7 days</div></div>
      <div className="metric"><div className="metric-label">Tokens this week<Icon name="terminal" size={17} /></div><div className="metric-value">{formatTokens(week?.tokens ?? 0)}</div><div className="metric-note">Across {usage?.byAgent.length ?? 0} agents with recorded usage</div></div>
    </div>
    <div className="workspace-note"><Icon name="info" size={16} /><span>Spend is an estimate based on list prices. Codex contributes tokens only; subscription billing may differ.</span></div>
    <section className="workspace-panel" aria-labelledby="ops-spend"><div className="section-heading"><div><h2 id="ops-spend">Daily spending</h2><p>A look at your last 7 days.</p></div><span className="period-label">Last 7 days</span></div>
      {usage && usage.byDay.length > 0 ? <ol className="spend-columns" aria-label="Estimated spend per day">{usage.byDay.map((day) => <li key={day.day}><span className="spend-column-value">{formatUsd(day.costUsd)}</span><span className="spend-column-track"><span style={{ height: `${Math.max(day.costUsd > 0 ? 3 : 0, Math.round(day.costUsd / maxCost * 100))}%` }} /></span><span className="spend-column-day">{new Date(`${day.day}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short' })}<small>{new Date(`${day.day}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</small></span></li>)}</ol>
        : <PanelEmpty icon="activity" title="Your usage will appear here"><p>As agents work, you’ll see their daily token usage and estimated spend.</p></PanelEmpty>}
    </section>
    <section className="workspace-panel" aria-labelledby="ops-agent-usage"><div className="section-heading"><div><h2 id="ops-agent-usage">Usage by agent<span className="section-count">{usage?.byAgent.length ?? 0}</span></h2><p>See where your tokens and estimated spend go.</p></div>{!!usage?.byAgent.length && <label className="resource-search"><Icon name="search" size={16} /><input type="search" aria-label="Search agent usage" placeholder="Find an agent or project…" value={query} onChange={(e) => setQuery(e.target.value)} /></label>}</div>
      {agents.length > 0 ? <div className="spend-table-wrap"><table className="spend-table"><caption className="sr-only">Usage by agent, last 7 days</caption><thead><tr><th scope="col">Agent</th><th scope="col">Model</th><th scope="col">Project</th><th scope="col" className="num">Tokens</th><th scope="col" className="num">Estimated spend</th></tr></thead><tbody>{agents.map((row) => <tr key={row.agentId}><td><strong>{row.name}</strong></td><td>{shortModel(row.model ?? undefined) ?? '—'}</td><td>{row.project}</td><td className="num">{formatTokens(row.tokens)}</td><td className="num">{row.priced ? formatUsd(row.costUsd) : <span title="This model has no price estimate">Tokens only</span>}</td></tr>)}</tbody></table></div>
        : <PanelEmpty icon={query ? 'search' : 'crew'} title={query ? 'No matching agents' : 'No agent usage yet'}><p>{query ? 'Try another agent name, model or project.' : 'Usage is recorded automatically as your agents work.'}</p>{query && <button className="btn" onClick={() => setQuery('')}>Clear search</button>}</PanelEmpty>}
    </section>
  </div>;
}
