import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { MotionConfig } from 'framer-motion';
import './styles.css';
import './world.css';
import './reading.css';
import './teams.css';
import './ops.css';
import './library.css';
import './workbench.css';
import './workspace.css';
import './team-session.css';
import './usage.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MotionConfig reducedMotion="user"><App /></MotionConfig>
  </StrictMode>,
);
