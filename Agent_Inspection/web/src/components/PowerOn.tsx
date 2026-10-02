import { motion } from 'framer-motion';
import { useEffect, useState } from 'react';
import { CREW } from '../crew.ts';
import { PREVIEW_CREW } from './AgentWorld.tsx';
import { CrewAvatar } from './CrewAvatar.tsx';
import { StationScene } from './StationScene.tsx';
import { Icon } from './Icon.tsx';

interface PowerOnProps { readonly onReady: () => void }

export function PowerOn({ onReady }: PowerOnProps) {
  const [booting, setBooting] = useState(false);
  useEffect(() => {
    if (!booting) return;
    const timer = setTimeout(onReady, 450);
    return () => clearTimeout(timer);
  }, [booting, onReady]);

  return (
    <motion.div className="standby waystation-welcome" exit={{ opacity: 0 }} transition={{ duration: 0.3 }}>
      <header className="standby-header">
        <div className="standby-brand"><span className="brand-mark"><Icon name="planet" size={24} /></span>Waystation<span className="welcome-beta">Your agent workspace</span></div>
        <span className="standby-local"><Icon name="shield" size={13} />Running on your machine</span>
      </header>
      <main className="standby-main">
        <div className="standby-copy">
          <h1>Your team,<br />in one place.</h1>
          <p>Turn your coding sessions into a little crew. Watch them work, see who needs a hand, and guide the mission from one place.</p>
          <button className="btn btn-go standby-start" onClick={() => setBooting(true)} disabled={booting} aria-label="Turn on Agent Control Tower"><Icon name={booting ? 'activity' : 'planet'} size={18} />{booting ? 'Opening the station…' : 'Enter the station'}<Icon name="arrow" size={18} /></button>
          <div className="standby-note"><Icon name="shield" size={15} />Connect your local Claude and Codex sessions.</div>
          <div className="welcome-crew"><span className="eyebrow">Meet the crew</span><div>{CREW.map(character => <div key={character.name}><CrewAvatar character={character} size={42} /><span>{character.name}</span></div>)}</div></div>
        </div>
        <div className="welcome-world">
          <div className="welcome-world-caption"><span><span className="connection-dot live" />WELCOME TO WAYSTATION</span><span>MOONBASE / 01</span></div>
          <StationScene agents={PREVIEW_CREW} theme="moonbase" />
          <div className="welcome-world-footer"><Icon name="sparkle" size={13} />An illustrated crew. Your real agents are waiting inside.</div>
        </div>
      </main>
      <footer className="standby-footer"><span>Built for your local coding sessions.</span><span>Waystation</span></footer>
    </motion.div>
  );
}
