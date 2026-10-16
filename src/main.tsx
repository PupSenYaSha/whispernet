import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles/globals.css';
import App from './App';
import { desktopAvailable } from './desktop';

const container = document.getElementById('root');
if (!container) throw new Error('Root element not found');

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

/**
 * The offline shell, in production builds only.
 *
 * `public/sw.js` is served as-is by the dev server, so registering it there means the worker caches the
 * modules being edited right now and then serves them back offline-stale — a debugging problem that looks
 * like a bug in the app. The browser suite serves the real build, and a worker with a populated cache is one
 * config change away from a suite that intermittently loads a shell pointing at the previous run's hashed
 * chunks, so it is kept out of that too and left to do its job for people actually using the app.
 *
 * The failure is logged rather than swallowed: a worker that did not register is worth knowing about.
 */
// `desktopAvailable()` and not a check of our own: it is the module that already decides which runtime this
// is, and a second definition of it here would be a second thing to keep in step.
//
// The desktop shell keeps the service worker's registration on its own origin, the app's real origin, so
// the worker stays in charge of what the privileged WebView loads: a stale hashed chunk served out of a
// cache generation nobody evicted is code the Rust side knows nothing about, running with `invoke` behind
// it. The desktop build has no offline story to protect either - the shell navigates the window to the
// server and errors out on its own when there is nothing there.
if (import.meta.env.PROD && 'serviceWorker' in navigator && !desktopAvailable()) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((e) => {
      console.warn('[sw] registration failed; the app will not work offline:', e);
    });
  });
}