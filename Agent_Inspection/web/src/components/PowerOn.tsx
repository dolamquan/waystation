import { motion } from 'framer-motion';
import { useEffect, useMemo, useState } from 'react';
import { PREVIEW_CREW, PREVIEW_TEAM, buildClusters } from './AgentWorld.tsx';
import { Icon } from './Icon.tsx';
import { StationGraph } from './StationGraph.tsx';

interface PowerOnProps { readonly onReady: () => void }

const BOOT_MS = 450;

/** Standby: what Waystation is, a labeled sample of the station, and one way in. */
export function PowerOn({ onReady }: PowerOnProps) {
  const [booting, setBooting] = useState(false);
  useEffect(() => {
    if (!booting) return;
    const timer = setTimeout(onReady, BOOT_MS);
    return () => clearTimeout(timer);
  }, [booting, onReady]);
  const sample = useMemo(() => buildClusters(PREVIEW_CREW, [PREVIEW_TEAM]), []);

  return (
    <motion.div className="standby waystation-welcome" exit={{ opacity: 0 }} transition={{ duration: 0.25 }}>
      <header className="standby-header">
        <div className="standby-brand"><span className="brand-mark" aria-hidden="true" />Waystation</div>
        <span className="standby-local"><Icon name="shield" size={13} />Local only · runs on this machine</span>
      </header>
      <main className="standby-main">
        <div className="standby-copy">
          <h1>Every coding agent on this machine, in one place.</h1>
          <p>See who is working, who is waiting, and who needs a decision. Approve, instruct, stop or delegate without hunting through terminals.</p>
          <div className="standby-actions">
            <button className="btn btn-go standby-start" onClick={() => setBooting(true)} disabled={booting} aria-label="Enter Waystation">
              {booting ? 'Opening…' : 'Open the station'}<Icon name="arrow" size={16} />
            </button>
            <span className="standby-note">Claude Code, Codex and more</span>
          </div>
        </div>
        <figure className="welcome-world">
          <figcaption className="welcome-world-caption"><span><span className="connection-dot live" />Sample crew</span><span>No agents are running</span></figcaption>
          <div className="welcome-world-canvas" inert>
            <StationGraph clusters={sample} allAgents={PREVIEW_CREW} demo />
          </div>
        </figure>
      </main>
    </motion.div>
  );
}
