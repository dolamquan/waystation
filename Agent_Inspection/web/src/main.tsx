import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { RemoteGate } from './components/RemoteGate.tsx';
import { MotionConfig } from 'framer-motion';
import './styles.css';
import './reading.css';
import './teams.css';
import './ops.css';
import './library.css';
import './workbench.css';
import './workspace.css';
import './team-session.css';
import './team-workflow.css';
import './consoles.css';
import './usage.css';
import './theme.css';
import './station.css';
import './shell.css';
import { applyUiTheme, savedUiTheme } from './uiTheme.ts';

applyUiTheme(savedUiTheme());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MotionConfig reducedMotion="user"><RemoteGate><App /></RemoteGate></MotionConfig>
  </StrictMode>,
);
