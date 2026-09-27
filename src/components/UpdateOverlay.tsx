import { useState, useEffect } from 'react';
import { useConnection } from '../context';

declare const __APP_VERSION__: string;

export function UpdateOverlay() {
  const { t } = useConnection();
  const [state, setState] = useState<'checking' | 'available' | 'downloading' | 'extracting' | 'ready' | 'error' | null>(null);
  const [version, setVersion] = useState('');
  const [percent, setPercent] = useState(0);
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    const handler = (e: Event) => {
      const data = (e as CustomEvent).detail as { kind?: string; version?: string; status?: string; percent?: number; message?: string };
      if (!data?.kind) return;
      switch (data.kind) {
        case 'available':
          setVersion(data.version || '');
          setState('available');
          break;
        case 'progress':
          setState('downloading');
          setPercent(data.percent || 0);
          if (data.status === 'extracting') setState('extracting');
          break;
        case 'ready':
          setVersion(data.version || '');
          setState('ready');
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

  if (!state) return null;

  const handleRestart = () => {
    if (state === 'ready') setState(null);
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/75">
      <div className="bg-bg-secondary border border-border-default rounded-2xl shadow-2xl p-8 max-w-md w-full mx-4 text-center animate-in">
        {state === 'available' && (
          <>
            <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-accent-primary/20 flex items-center justify-center">
              <svg className="w-8 h-8 text-accent-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
            </div>
            <h2 className="text-lg font-semibold text-fg-primary mb-2">{t('update_available')}</h2>
            <p className="text-sm text-fg-secondary mb-6">{t('update_available_desc').replace('{version}', version)}</p>
            <button onClick={() => setState('downloading')} className="w-full py-3 rounded-2xl bg-accent-primary hover:brightness-110 text-accent-text font-medium transition-all">
              {t('update_now')}
            </button>
          </>
        )}
        {state === 'downloading' && (
          <>
            <div className="w-16 h-16 mx-auto mb-4">
              <svg className="w-16 h-16 text-accent-primary animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            </div>
            <h2 className="text-lg font-semibold text-fg-primary mb-2">{t('update_downloading')}</h2>
            <p className="text-sm text-fg-secondary mb-4">{t('update_version')}{version}</p>
            <div className="w-full h-2.5 bg-bg-tertiary rounded-full overflow-hidden mb-2">
              <div className="h-full bg-accent-primary rounded-full transition-all duration-300" style={{ width: `${percent}%` }} />
            </div>
            <p className="text-xs text-fg-muted">{percent}%</p>
          </>
        )}
        {state === 'extracting' && (
          <>
            <div className="w-16 h-16 mx-auto mb-4">
              <svg className="w-16 h-16 text-accent-primary animate-pulse" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5m8.25 3v6.75m0 0l-3-3m3 3l3-3M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z" />
              </svg>
            </div>
            <h2 className="text-lg font-semibold text-fg-primary mb-2">{t('update_extracting')}</h2>
            <p className="text-sm text-fg-secondary">{t('update_wait')}</p>
          </>
        )}
        {state === 'ready' && (
          <>
            <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-status-success/15 flex items-center justify-center">
              <svg className="w-8 h-8 text-status-success" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <h2 className="text-lg font-semibold text-fg-primary mb-2">{t('update_ready')}</h2>
            <p className="text-sm text-fg-secondary mb-6">{t('update_ready_desc').replace('{version}', version)}</p>
            <button onClick={handleRestart} className="w-full py-3 rounded-2xl bg-accent-primary hover:brightness-110 text-accent-text font-medium transition-all">
              {t('update_restart')}
            </button>
          </>
        )}
        {state === 'error' && (
          <>
            <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-status-error/15 flex items-center justify-center">
              <svg className="w-8 h-8 text-status-error" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </div>
            <h2 className="text-lg font-semibold text-fg-primary mb-2">{t('update_failed')}</h2>
            <p className="text-sm text-fg-secondary mb-6">{errorMsg || t('update_error_default')}</p>
            <button onClick={() => setState(null)} className="w-full py-3 rounded-2xl bg-bg-tertiary hover:bg-bg-hover text-fg-primary font-medium transition-colors">
              {t('update_dismiss')}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
