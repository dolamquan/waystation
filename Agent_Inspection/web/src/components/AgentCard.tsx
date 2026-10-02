import { motion, AnimatePresence } from 'framer-motion';
import type { Agent } from '../api.ts';
import { STATUS_LABEL, TIER_LABEL, VENDOR_LABEL, timeAgo } from '../format.ts';
import { Icon } from './Icon.tsx';
import { CrewAvatar } from './CrewAvatar.tsx';
import { characterFor } from '../crew.ts';
import { currentActivity } from '../activity.ts';

interface AgentCardProps {
  readonly agent: Agent;
  readonly selected: boolean;
  readonly now: number;
  readonly onSelect: (id: string) => void;
}

export function AgentCard({ agent, selected, now, onSelect }: AgentCardProps) {
  const tier = TIER_LABEL[agent.tier];
  return (
    <motion.button
      layout
      initial={{ opacity: 0, y: 12, scale: 1 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.98 }}
      transition={{ type: 'spring', stiffness: 260, damping: 26 }}
      whileHover={{ y: -2 }}
      className={`card vendor-${agent.vendor} status-${agent.status} ${selected ? 'card-selected' : ''}`}
      onClick={() => onSelect(agent.id)}
      aria-pressed={selected}
    >
      <div className="card-head">
        <div className="card-crew-avatar"><CrewAvatar id={agent.id} status={agent.status} size={40} animated={false} /></div>
        <div className="card-title">
          <div className="card-provider">{characterFor(agent.id).name}<span> / {VENDOR_LABEL[agent.vendor]}</span></div>
          <div className="card-name" title={agent.name}>{agent.name}</div>
        </div>
        <span className={`status-pill pill-${agent.status}`}>{STATUS_LABEL[agent.status]}</span>
      </div>

      <div className="card-project" title={agent.cwd ?? agent.project}><Icon name="folder" size={14} /><span>{agent.project}</span></div>

      <div className="activity">
        <div className="activity-label"><span className={`activity-dot activity-${agent.status}`} />Current activity</div>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={agent.currentActivity ?? 'none'}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.2 }}
            className="activity-text"
          >
            {currentActivity(agent)}
          </motion.div>
        </AnimatePresence>
      </div>

      <div className="card-foot">
        <span className={`tier tier-${agent.tier}`} title={tier.hint}>{tier.label}</span>
        {agent.intercepting && <span className="tag tag-intercept">Intercepting</span>}
        <span className="card-time">{timeAgo(agent.lastEventAt ?? agent.startedAt, now)}</span>
        <Icon name="arrow" size={15} />
      </div>
    </motion.button>
  );
}
