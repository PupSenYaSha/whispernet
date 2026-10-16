import { useState, useEffect } from 'react';
import { useConnection } from '../context';
import { desktopAvailable, sendDesktopCommand } from '../desktop';

type Phase = 'available' | 'downloading' | 'extracting' | 'ready' | 'error' | 'declined' | null;

/**
 * The update prompt, and the consent that goes with it.
 *
 * The desktop shell used to restart the app three seconds after unpacking, with no question asked. Every
 * "close" button here therefore did nothing except hide an overlay that was about to be replaced by a
 * restart - so a user declining an update lost whatever they had typed. The shell now waits for an answer
 * (see `wait_for_update_consent`), which makes the buttons below real choices rather than decoration.
 *
 * Declining is not a throw-away click: the update has already been downloaded and unpacked by then, so it
 * is reported back as "installed, applied next launch" rather than being described as refused. Pretending
 * nothing was installed would be a small lie that costs the user a manual download later.
 */
export function UpdateOverlay() {
  const { t } = useConnection();
  const [state, setState] = useState<Phase>(null);
  const [version, setVersion] = useState('');
  const [percent, setPercent] = useState(0);
  const [errorMsg, setErrorMsg] = useState('');
  const [answering, setAnswering] = useState(false);

  useEffect(() => {
    const handler = (e: Event) => {
      const data = (e as CustomEvent).detail as { kind?: string; version?: string; status?: string; percent?: number; message?: string };
      if (!data?.kind) return;
      switch (data.kind) {
        case 'available':
          // the desktop side starts downloading on its own the moment it reports the release, so
          // this is a notice and not a question: there is nothing for a button to start
          setVersion(data.version || '');
          setState('available');
          break;
        case 'progress':
          setState(data.status === 'extracting' ? 'extracting' : 'downloading');
          setPercent(data.percent || 0);
          break;
        case 'ready':
          setVersion(data.version || '');
          setState('ready');
          break;
        case 'cancelled':
          // the shell declined on our behalf - it timed out waiting, which is what happens when this
          // window was never shown at all
          setState('declined');
          break;
        case 'error':
          setErrorMsg(data.message || '');
          setState('error');
          break;
      }
    };
    window.addEventListener('whispernet-update', handler);
    return () => window.removeEventListener('whispernet-update', handler);
  }, []);

  /**
   * Sends the answer, and keeps the dialog up if the shell never heard it.
   *
   * The prompt is the only thing the user can see, so a silently dropped command would leave the dialog
   * looking accepted while nothing happens - and, on the accepting branch, with an update the user believed
   * they had installed. Failing loudly is the whole point.
   */
  const answer = async (grant: boolean) => {
    setAnswering(true);
    const sent = await sendDesktopCommand('set_update_consent', { grant });
    setAnswering(false);
    if (sent) setState(grant ? 'ready' : 'declined');
    else setErrorMsg(t('update_error_no_shell'));
  };

  // In a browser or on Android there is no shell to ask, and nothing would have arrived here anyway
  if (!state || !desktopAvailable()) return null;

  const secondary = (
    <button onClick={() => void answer(false)} disabled={answering}
      className="w-full py-3 rounded-2xl bg-bg-tertiary hover:bg-bg-hover disabled:opacity-50 text-fg-primary font-medium transition-colors">
      {t('update_decline')}
    </button>
  );

  // Every state has to offer a way out: a full screen overlay with no dismiss left the messenger
  // unusable whenever the update check misbehaved. Declining is what the close button means now.
  const dismissible = (
    <button onClick={() => void answer(false)} disabled={answering}
      className="w-full py-3 rounded-2xl bg-bg-tertiary hover:bg-bg-hover disabled:opacity-50 text-fg-primary font-medium transition-colors">
      {t('update_dismiss')}
    </button>
  );

  const close = (
    <button onClick={() => void answer(false)} aria-label={t('update_dismiss')}
      className="absolute top-4 right-4 w-8 h-8 rounded-full text-fg-muted hover:text-fg-primary hover:bg-bg-hover transition-colors">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="mx-auto">
        <path d="M18 6L6 18M6 6l12 12" />
      </svg>
    </button>
  );

  const icon = (bg: string, fg: string, d: string, stroke = 2) => (
    <div className={`w-16 h-16 mx-auto mb-4 rounded-2xl ${bg} flex items-center justify-center`}>
      <svg className={`w-8 h-8 ${fg}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={stroke}>
        <path strokeLinecap="round" strokeLinejoin="round" d={d} />
      </svg>
    </div>
  );

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/75">
      <div className="relative bg-bg-secondary border border-border-default rounded-2xl shadow-2xl p-8 max-w-md w-full mx-4 text-center animate-in">
        {close}
        {/*
          The consent failure, once, above whichever state is on screen.

          It used to live inside the `ready` branch only. A consent that failed to send while the state was
          `available`, `downloading` or `extracting` therefore said nothing at all: the button simply
          re-enabled and the user pressed it again, indefinitely, with nothing to tell them why. That is
          exactly the failure the message was added to prevent. The `error` state has its own, more specific
          wording, so it is left alone.
        */}
        {errorMsg && state !== 'error' && (
          <p role="alert" className="text-xs text-status-error mb-3">{errorMsg}</p>
        )}
        {state === 'available' && (
          <>
            {icon('bg-accent-primary/20', 'text-accent-primary', 'M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4')}
            <h2 className="text-lg font-semibold text-fg-primary mb-2">{t('update_available')}</h2>
            <p className="text-sm text-fg-secondary mb-6">{t('update_available_desc').replace('{version}', version)}</p>
            {dismissible}
          </>
        )}
        {state === 'downloading' && (
          <>
            <div className="w-16 h-16 mx-auto mb-4">
              <svg className="w-16 h-16 text-accent-primary animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                <path className="opacity-75" fill="currentColor" d="M4 12a12 12 0 0 1 12-12V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            </div>
            <h2 className="text-lg font-semibold text-fg-primary mb-2">{t('update_downloading')}</h2>
            <p className="text-sm text-fg-secondary mb-4">{t('update_version')}{version}</p>
            <div className="w-full h-2.5 bg-bg-tertiary rounded-full overflow-hidden mb-2">
              <div className="h-full bg-accent-primary rounded-full transition-all duration-300" style={{ width: `${percent}%` }} />
            </div>
            <p className="text-xs text-fg-muted mb-5">{percent}%</p>
            {dismissible}
          </>
        )}
        {state === 'extracting' && (
          <>
            <div className="w-16 h-16 mx-auto mb-4">
              <svg className="w-16 h-16 text-accent-primary animate-pulse" fill="none" viewBox="0 0 24 24" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5m8.25 3v6.75m0 0l-3-3m3 3l3-3M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z" />
              </svg>
            </div>
            <h2 className="text-lg font-semibold text-fg-primary mb-2">{t('update_extracting')}</h2>
            <p className="text-sm text-fg-secondary mb-5">{t('update_wait')}</p>
            {dismissible}
          </>
        )}
        {state === 'ready' && (
          <>
            {icon('bg-status-success/15', 'text-status-success', 'M5 13l4 4L19 7')}
            <h2 className="text-lg font-semibold text-fg-primary mb-2">{t('update_ready')}</h2>
            <p className="text-sm text-fg-secondary mb-6">{t('update_ready_desc').replace('{version}', version)}</p>
            <div className="space-y-2">
              <button onClick={() => void answer(true)} disabled={answering}
                className="w-full py-3 rounded-2xl bg-accent-primary text-accent-text font-medium hover:brightness-110 disabled:opacity-50 transition-all">
                {t('update_apply')}
              </button>
              {secondary}
            </div>
          </>
        )}
        {state === 'declined' && (
          <>
            {icon('bg-status-success/15', 'text-status-success', 'M5 13l4 4L19 7')}
            <h2 className="text-lg font-semibold text-fg-primary mb-2">{t('update_ready')}</h2>
            <p className="text-sm text-fg-secondary mb-6">{t('update_declined')}</p>
            <button onClick={() => setState(null)}
              className="w-full py-3 rounded-2xl bg-accent-primary text-accent-text font-medium hover:brightness-110 transition-all">
              {t('ok')}
            </button>
          </>
        )}
        {state === 'error' && (
          <>
            {icon('bg-status-error/15', 'text-status-error', 'M6 18L18 6M6 6l12 12')}
            <h2 className="text-lg font-semibold text-fg-primary mb-2">{t('update_failed')}</h2>
            <p className="text-sm text-fg-secondary mb-6">{errorMsg || t('update_error_default')}</p>
            <button onClick={() => setState(null)}
              className="w-full py-3 rounded-2xl bg-bg-tertiary hover:bg-bg-hover text-fg-primary font-medium transition-colors">
              {t('ok')}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
