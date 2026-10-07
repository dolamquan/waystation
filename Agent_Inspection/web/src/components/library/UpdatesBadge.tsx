import { useEffect, useState } from 'react';
import { notifyApi } from '../../library/notifyApi.ts';

const POLL_MS = 30_000;
/** NotificationsPanel fires this after marking entries read so the badge updates at once. */
export const UPDATES_CHANGED_EVENT = 'waystation:updates-changed';

/** Unread count for the Library nav entry. Renders nothing when everything is read. */
export function UpdatesBadge() {
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    let live = true;
    const load = () => {
      notifyApi.notifications(1).then((data) => { if (live) setUnread(data.unread); }, () => undefined);
    };
    load();
    const timer = window.setInterval(load, POLL_MS);
    window.addEventListener('focus', load);
    window.addEventListener(UPDATES_CHANGED_EVENT, load);
    return () => {
      live = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', load);
      window.removeEventListener(UPDATES_CHANGED_EVENT, load);
    };
  }, []);

  if (unread === 0) return null;
  const label = `${unread} unread update${unread === 1 ? '' : 's'}`;
  return <span className="nav-count nav-alert" aria-label={label} title={label}>{unread > 99 ? '99+' : unread}</span>;
}
