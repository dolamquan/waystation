import { providerLabel } from '../../../shared/agentProviders.ts';
import { motion, AnimatePresence } from 'framer-motion';
import type { CSSProperties } from 'react';
import type { Agent } from '../api.ts';
import { STATUS_LABEL, TIER_LABEL, subagentCountLabel, subagentOfLabel, timeAgo } from '../format.ts';
import { AgentAlert, AgentMeta } from './AgentMeta.tsx';
import { Icon } from './Icon.tsx';
import { CrewAvatar } from './CrewAvatar.tsx';
import { currentActivity } from '../activity.ts';

interface AgentCardProps {
  readonly agent: Agent;
  readonly selected: boolean;
  readonly now: number;
  readonly onSelect: (id: string) => void;
  /** Number of this agent's subagents currently listed (shown as a badge). */
  readonly subagentCount?: number;
  /** Rendered indented directly under its parent's card. */
  readonly nested?: boolean;
  readonly depth?: number;
  readonly parentName?: string;
  /** Files this agent and another agent in the same checkout both wrote recently. */
  readonly sharedFiles?: number;
}

export function AgentCard({ agent, selected, now, onSelect, subagentCount = 0, nested = false, depth = 1, parentName, sharedFiles = 0 }: AgentCardProps) {
  const tier = TIER_LABEL[agent.tier];
  const parentLabel = agent.parentId && parentName ? `Subagent of ${parentName}` : subagentOfLabel(agent);
  return (
    <motion.button
      layout
      initial={{ opacity: 0, y: 12, scale: 1 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.98 }}
      transition={{ type: 'spring', stiffness: 260, damping: 26 }}
      whileHover={{ y: -2 }}
      className={`card vendor-${agent.vendor} status-${agent.status} ${selected ? 'card-selected' : ''} ${agent.parentId ? 'card-subagent' : ''} ${nested ? 'card-nested' : ''}`}
      style={{ '--agent-depth': Math.min(depth, 4) } as CSSProperties}
      onClick={() => onSelect(agent.id)}
      aria-pressed={selected}
      aria-label={parentLabel ? `${agent.name}, ${parentLabel.toLowerCase()}` : undefined}
    >
      <div className="card-head">
        <div className="card-crew-avatar"><CrewAvatar id={agent.id} status={agent.status} size={40} animated={false} /></div>
        <div className="card-title">
          <div className="card-provider">{providerLabel(agent)}<span>{agent.observation ? ' / Detected runtime' : ' / Agent session'}</span></div>
          <div className="card-name" title={agent.name}>{agent.name}</div>
        </div>
        <span className={`status-pill pill-${agent.status}`}>{STATUS_LABEL[agent.status]}</span>
      </div>

      {parentLabel && <div className="card-parent" title={parentLabel}><span aria-hidden="true">↳</span><span>{parentLabel}</span></div>}
      <div className="card-project" title={agent.cwd ?? agent.project}><Icon name="folder" size={14} /><span>{agent.project}</span></div>
      <AgentMeta agent={agent} />

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

      <AgentAlert agent={agent} />

      <div className="card-foot">
        <span className={`tier tier-${agent.tier}`} title={tier.hint}>{tier.label}</span>
        {agent.intercepting && <span className="tag tag-intercept">Intercepting</span>}
        {subagentCount > 0 && <span className="tag tag-subagents">{subagentCountLabel(subagentCount)}</span>}
        {sharedFiles > 0 && <span className="tag tag-shared-file" title="Another agent in this checkout wrote the same file recently">{sharedFiles === 1 ? 'Shared file' : `${sharedFiles} shared files`}</span>}
        <span className="card-time">{timeAgo(agent.lastEventAt ?? agent.startedAt, now)}</span>
        <Icon name="arrow" size={15} />
      </div>
    </motion.button>
  );
}
