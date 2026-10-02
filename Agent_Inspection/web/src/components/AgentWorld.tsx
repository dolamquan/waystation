import { useEffect, useMemo, useState } from 'react';
import type { Agent } from '../api.ts';
import { CREW, WORLD_THEMES, characterFor, groupCrews, projectKey, type WorldTheme } from '../crew.ts';
import { STATUS_LABEL, VENDOR_LABEL } from '../format.ts';
import { CrewAvatar } from './CrewAvatar.tsx';
import { StationScene } from './StationScene.tsx';
import { Icon } from './Icon.tsx';

interface AgentWorldProps {
  readonly agents: readonly Agent[];
  readonly selectedId?: string;
  readonly connected: boolean;
  readonly authError: boolean;
  readonly onSelect: (id: string) => void;
  readonly onLaunch: () => void;
}

export const PREVIEW_CREW: Agent[] = CREW.map((character, i) => ({
  id: `demo-${character.name}`,
  vendor: i % 2 ? 'codex' : 'claude',
  tier: 'C',
  name: character.name,
  project: 'Demo expedition',
  status: (['busy', 'busy', 'waiting', 'idle', 'unknown', 'stopped'] as const)[i],
  currentActivity: character.detail,
  source: 'Illustration',
  hooked: false,
  intercepting: false,
  canInstruct: false,
}));

function savedTheme(): WorldTheme {
  try {
    const value = localStorage.getItem('waystation-theme');
    if (value && Object.hasOwn(WORLD_THEMES, value)) return value as WorldTheme;
  } catch { /* A theme also works without browser storage. */ }
  return 'moonbase';
}

export function AgentWorld({ agents, selectedId, connected, authError, onSelect, onLaunch }: AgentWorldProps) {
  const [theme, setTheme] = useState<WorldTheme>(savedTheme);
  const [project, setProject] = useState('all');
  const [page, setPage] = useState(0);
  const [motionPaused, setMotionPaused] = useState(false);
  const [demo, setDemo] = useState(false);
  const [demoId, setDemoId] = useState<string>();
  const [zoomed, setZoomed] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(preference.matches);
    update();
    preference.addEventListener('change', update);
    return () => preference.removeEventListener('change', update);
  }, []);
  const paused = motionPaused || !!reducedMotion;
  const groups = useMemo(() => groupCrews(agents), [agents]);
  const activeProject = groups.some(g => g.key === project) ? project : 'all';
  const visible = useMemo(() => {
    const list = demo ? PREVIEW_CREW : agents.filter(a => activeProject === 'all' || projectKey(a) === activeProject);
    return [...list].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.id.localeCompare(b.id));
  }, [agents, activeProject, demo]);
  const pages = Math.max(1, Math.ceil(visible.length / 8));
  const currentPage = Math.min(page, pages - 1);
  const floor = visible.slice(currentPage * 8, currentPage * 8 + 8);
  const preview = PREVIEW_CREW.find(a => a.id === demoId);

  const changeTheme = (next: WorldTheme) => {
    setTheme(next);
    try { localStorage.setItem('waystation-theme', next); } catch { /* optional preference */ }
  };
  const toggleDemo = () => { setDemo(!demo); setDemoId(undefined); setPage(0); };

  return (
    <section className={`agent-world world-${theme} ${paused ? 'motion-paused' : ''}`} aria-label="Waystation agent world">
      <header className="world-toolbar">
        <div className="world-title"><span className="world-title-icon"><Icon name="planet" size={19} /></span><div><h2>The station</h2><span>{demo ? 'Sample workspace' : WORLD_THEMES[theme].location}</span></div></div>
        <div className="world-controls">
          <div className="theme-picker" aria-label="Station theme">
            {(Object.keys(WORLD_THEMES) as WorldTheme[]).map(t => <button key={t} className={theme === t ? 'theme-active' : ''} onClick={() => changeTheme(t)} aria-pressed={theme === t}><span className={`theme-swatch swatch-${t}`} />{WORLD_THEMES[t].label}</button>)}
          </div>
          <button className="world-motion" onClick={() => setMotionPaused(!motionPaused)} disabled={!!reducedMotion} aria-label={paused ? 'Resume animations' : 'Pause animations'} aria-pressed={paused} title={reducedMotion ? 'Animations are off because of your system motion preference' : paused ? 'Resume animations' : 'Pause animations'}><Icon name={paused ? 'play' : 'pause'} size={16} /></button>
        </div>
      </header>

      <div className="world-body">
        <div className="world-scene-wrap">
          <div className="world-scene-topline"><span className={`world-live ${demo ? 'world-demo' : ''}`}><span className={`connection-dot ${connected && !demo ? 'live' : ''}`} />{demo ? 'DEMO CREW' : connected ? 'LIVE WORKSPACE' : authError ? 'ACCESS TOKEN REQUIRED' : 'CONNECTING'}</span><div className="scene-camera"><span className="world-coordinate">{theme === 'moonbase' ? '25.8° N / 02.6° E' : theme === 'greenhouse' ? '21°C / A LITTLE SUNSHINE' : 'DEPTH 2,400 M / ALL IS QUIET'}</span><button onClick={() => setZoomed(!zoomed)} aria-label={zoomed ? 'Fit station to view' : 'Zoom in on station'} aria-pressed={zoomed} title={zoomed ? 'Fit station to view' : 'Zoom in on station'}><Icon name={zoomed ? 'fit' : 'zoom'} size={14} /></button></div></div>
          <div className={`scene-viewport ${zoomed ? 'scene-zoomed' : ''}`}><StationScene agents={floor} theme={theme} paused={paused} selectedId={demo ? demoId : selectedId} onSelect={demo ? setDemoId : onSelect} /></div>
          {!floor.length && <div className="world-empty"><Icon name="planet" size={24} /><h3>{authError ? 'Your station is waiting' : connected ? 'Room for your first explorer' : 'Finding your crew…'}</h3><p>{authError ? 'Open the daemon’s access link to connect your agents.' : connected ? 'Launch an agent and watch it settle into the station.' : 'The crew will arrive when the daemon connects.'}</p>{connected && <button className="btn btn-go" onClick={onLaunch}><Icon name="plus" size={15} />Launch an agent</button>}</div>}
          {preview && demo && <div className="demo-inspector" role="status"><CrewAvatar id={preview.id} status={preview.status} size={38} /><div><strong>{characterFor(preview.id).name} · {STATUS_LABEL[preview.status]}</strong><span>A demo character. Live agent controls are available in your workspace.</span></div><button className="icon-btn" aria-label="Close demo details" onClick={() => setDemoId(undefined)}><Icon name="close" size={14} /></button></div>}
          <div className="world-scene-footer"><span><Icon name="cursor" size={13} />{zoomed ? 'Scroll around to explore' : 'Click a crewmate to check in'}</span><div className="deck-controls"><button aria-label="Previous deck" onClick={() => setPage(currentPage - 1)} disabled={currentPage === 0}><Icon name="chevronLeft" size={14} /></button><span>DECK {String(currentPage + 1).padStart(2, '0')}{pages > 1 ? ` / ${String(pages).padStart(2, '0')}` : ''}</span><button aria-label="Next deck" onClick={() => setPage(currentPage + 1)} disabled={currentPage >= pages - 1}><Icon name="chevronRight" size={14} /></button></div></div>
        </div>

        <aside className="crew-panel" aria-label="Station crew">
          <div className="crew-panel-heading"><div><span className="eyebrow">{demo ? 'Sample sessions' : 'Your sessions'}</span><h3>The crew<span>{visible.length}</span></h3></div><span className="crew-panel-badge"><Icon name="crew" size={18} /></span></div>
          <label className="crew-project-label" htmlFor="crew-project">Project team</label>
          <select id="crew-project" className="crew-project-select" value={activeProject} disabled={demo} onChange={e => { setProject(e.target.value); setPage(0); }}><option value="all">All projects</option>{groups.map(g => <option key={g.key} value={g.key}>{groups.filter(other => other.name === g.name).length > 1 ? g.key : g.name} ({g.agents.length})</option>)}</select>
          <div className="crew-panel-list">
            {floor.map(agent => <button key={agent.id} className={`crew-row ${agent.id === (demo ? demoId : selectedId) ? 'crew-row-selected' : ''}`} onClick={() => demo ? setDemoId(agent.id) : onSelect(agent.id)} aria-label={`Open ${agent.name}`}><CrewAvatar id={agent.id} status={agent.status} size={36} animated={false} /><span className="crew-row-text"><strong>{agent.name}</strong><small>{characterFor(agent.id).name} <span>· {VENDOR_LABEL[agent.vendor]}</span></small></span><span className={`crew-status crew-status-${agent.status}`} title={STATUS_LABEL[agent.status]} aria-label={STATUS_LABEL[agent.status]} /></button>)}
            {!floor.length && <p className="crew-panel-empty">A good team starts with one little explorer.</p>}
          </div>
          <div className="world-legend" aria-label="Character states"><span><i className="legend-working" />Working</span><span><i className="legend-waiting" />Needs you</span><span><i className="legend-idle" />Idle</span></div>
          <div className="world-demo-card"><span className="demo-mini-crew">{CREW.slice(0, 3).map(c => <CrewAvatar key={c.name} character={c} size={25} animated={false} />)}</span><strong>{demo ? 'Ready for the real crew?' : 'Meet the little explorers'}</strong><p>{demo ? 'Return to your live sessions whenever you’re ready.' : 'Take a look around with a sample crew. No agents are launched.'}</p><button onClick={toggleDemo}>{demo ? 'Back to live workspace' : 'Explore the demo'}<Icon name="arrow" size={14} /></button></div>
        </aside>
      </div>
      <footer className="world-bottomline"><span><Icon name="cursor" size={13} />Select a character to open its session</span><span>{demo ? 'Sample data · No live actions' : `${visible.length} ${visible.length === 1 ? 'agent' : 'agents'} · ${visible.filter(a => a.status === 'busy').length} working`}</span></footer>
    </section>
  );
}
