/**
 * The one place that talks to the desktop shell.
 *
 * The app runs in three places - a browser, Capacitor on Android, and the Tauri desktop build - and the
 * update flow only exists in the third. Nothing else in the client should have to know that, so this
 * module owns the awkward parts: which runtime we are in, and the fact that the Tauri IPC bridge is an
 * internal global rather than a dependency we can import.
 *
 * `@tauri-apps/api` would be the supported way to call this, but it is not a dependency of this project
 * and adding it for a single call is not worth the lockfile churn. Tauri v2 installs its IPC bridge as
 * `window.__TAURI_INTERNALS__` in every build regardless of `withGlobalTauri`, and that global is what the
 * official package calls. If a future Tauri release renames it, this file is the only thing that breaks -
 * see `desktopUnavailable` for how that failure is meant to look.
 */

type InvokeFn = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

function invokeFn(): InvokeFn | null {
  const internals = (window as unknown as {
    __TAURI_INTERNALS__?: { invoke?: InvokeFn };
  }).__TAURI_INTERNALS__;
  return typeof internals?.invoke === 'function' ? internals.invoke : null;
}

/**
 * Whether commands can be sent to the desktop shell at all.
 *
 * False in a browser and on Android, which is the whole point: an update prompt there belongs to the
 * store the app was installed from, and pretending otherwise is how you end up shipping a "download now"
 * button that goes nowhere.
 */
export function desktopAvailable(): boolean {
  return invokeFn() !== null;
}

/**
 * Sends a command, reporting failure as `false` instead of throwing.
 *
 * The callers are UI buttons guarding an irreversible action, and a rejected promise from a button
 * handler is an unhandled rejection with no user-visible effect - the click would look like it did nothing
 * at all. A refused command has to be visible to the caller so it can keep the prompt on screen.
 */
export async function sendDesktopCommand(cmd: string, args?: Record<string, unknown>): Promise<boolean> {
  const invoke = invokeFn();
  if (!invoke) return false;
  try {
    await invoke(cmd, args);
    return true;
  } catch {
    return false;
  }
}
