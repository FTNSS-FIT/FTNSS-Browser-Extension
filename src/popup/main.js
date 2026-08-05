// Which of the two interfaces to show.
//
// The default is the PANEL — the thing a user came for. The measurement harness is internal
// tooling that still has phase-1 work to do, and it stays available behind a preference rather
// than being deleted or left as the front door.
//
// The harness is imported DYNAMICALLY, so a normal session never loads it. That is not a
// performance argument at this size; it is that the harness reaches for storage, migrations and
// tab messaging on import, and none of that should run for someone who only wants to know whether
// there is a gym near their hotel.

import { loadPrefs } from '../lib/prefs.js';
import { renderPanel } from './panel.js';

async function start() {
  let prefs;
  try {
    prefs = await loadPrefs();
  } catch {
    // Storage unavailable is not a reason to show nothing. The panel is the safe default.
    prefs = { devMode: false };
  }

  if (prefs.devMode) {
    document.getElementById('harness').hidden = false;
    // popup.js runs its own start() on import.
    await import('./popup.js');
    return;
  }

  const root = document.getElementById('panel');
  root.hidden = false;
  await renderPanel(root);
}

/*
 * A POPUP THAT THROWS SHOWS NOTHING AT ALL, which is the one failure a user cannot act on or
 * report — it looks identical to the extension being broken, uninstalled, or having found no gyms.
 * Anything that escapes start() lands here and says so instead. There is no error surface in a
 * popup otherwise: no console anyone will open, no page to reload.
 */
void start().catch(() => {
  const root = document.getElementById('panel');
  if (root == null) return;
  root.hidden = false;
  root.replaceChildren();
  const message = document.createElement('div');
  message.className = 'panel-body';
  message.textContent = 'Something went wrong opening this panel. Closing and reopening it usually clears it.';
  root.appendChild(message);
});
