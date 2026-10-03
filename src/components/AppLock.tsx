import { useEffect, useRef, useState } from 'react';
import { useConnection } from '../context';
import { appLockLockedOut, unlockAppLock } from '../appLock';
import type { AppLockSettings } from '../appLock';

/**
 * The curtain over the app.
 *
 * Shown over the whole interface, not inside it, so nothing of the conversation is on screen behind it:
 * the browser's own screenshot and screen-share tools capture whatever is painted, and a lock drawn
 * inside the page leaves the messages readable in the capture.
 *
 * Reloading is treated as leaving and returning, so the code is asked for again on a fresh page load.
 */
export function AppLockGate({ onUnlocked }: { onUnlocked: () => void }) {
  const { t } = useConnection();
  const [checking, setChecking] = useState(true);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [lockedFor, setLockedFor] = useState(appLockLockedOut());
  const inputRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);

  useEffect(() => {
    setChecking(false);
    inputRef.current?.focus();
  }, []);

  // while the code is being refused, the counter still has to be visible counting down
  useEffect(() => {
    if (lockedFor <= 0) return;
    const timer = setInterval(() => {
      const left = appLockLockedOut();
      setLockedFor(left);
      if (left <= 0) inputRef.current?.focus();
    }, 1000);
    return () => clearInterval(timer);
  }, [lockedFor]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && code && !busyRef.current) void submit();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (checking) return null;

  const submit = async () => {
    if (!code || busyRef.current) return;
    busyRef.current = true;
    setError(null);
    const result = await unlockAppLock(code);
    busyRef.current = false;
    if (result.ok) {
      setCode('');
      onUnlocked();
      return;
    }
    if (result.reason === 'locked') {
      setLockedFor(result.retryInMs);
      setError(t('app_lock_wait'));
      return;
    }
    setCode('');
    setLockedFor(appLockLockedOut());
    setError(t('app_lock_wrong'));
    inputRef.current?.focus();
  };

  return (
    <div className="fixed inset-0 z-[200] bg-bg-primary flex flex-col items-center justify-center p-6">
      {checking ? null : (
        <div className="w-full max-w-[280px] text-center" style={{ animation: 'fadeSlideIn 0.25s ease-out' }}>
          <div className="w-16 h-16 rounded-2xl bg-accent-primary/15 flex items-center justify-center mx-auto mb-5">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="rgb(var(--color-accent-primary))" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
          </div>
          <h2 className="text-[17px] font-semibold text-fg-primary mb-1">{t('app_lock_title')}</h2>
          <p className="text-[13px] text-fg-muted mb-6 leading-relaxed">{t('app_lock_desc')}</p>

          <input
            ref={inputRef}
            type="password"
            inputMode="numeric"
            autoComplete="off"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, '').slice(0, 12))}
            placeholder={t('app_lock_enter')}
            aria-label={t('app_lock_enter')}
            className="w-full px-4 py-3.5 rounded-2xl bg-bg-tertiary border border-border-default text-[20px] tracking-[0.4em] text-center text-fg-primary placeholder:text-fg-muted focus:outline-none focus:ring-2 focus:ring-accent-primary"
          />

          {error && (
            <p className="mt-3 text-[13px] text-status-error" role="alert">
              {lockedFor > 0 ? `${error} ${Math.ceil(lockedFor / 1000)}s` : error}
            </p>
          )}

          <button
            onClick={submit}
            disabled={!code || lockedFor > 0}
            className="mt-5 w-full py-3.5 rounded-2xl bg-accent-primary text-accent-text text-[15px] font-semibold hover:opacity-90 transition-opacity disabled:opacity-40"
          >
            {t('unlock')}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Covers the app after a period of doing nothing, and asks for the code again.
 *
 * Driven by real activity rather than a countdown, so a conversation being read does not lock itself and
 * walking away does. The threshold belongs to the device, not the account: it is about the machine being
 * left alone, which is why it lives beside the rest of the per-device settings.
 */
export function useAutoLock(settings: AppLockSettings, onLock: () => void): void {
  const onLockRef = useRef(onLock);
  onLockRef.current = onLock;
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!settings.enabled) return;
    const schedule = () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      if (settings.autoLockMs <= 0) return;
      timeoutRef.current = setTimeout(() => onLockRef.current(), settings.autoLockMs);
    };
    const events = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
    for (const e of events) window.addEventListener(e, schedule, { passive: true });
    // leaving the tab counts as leaving: a machine that is unattended and switched away is exactly the
    // case the lock is for, and a timer alone would not notice for the whole threshold
    const onVisibility = () => { if (document.hidden) onLockRef.current(); };
    document.addEventListener('visibilitychange', onVisibility);
    schedule();
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      for (const e of events) window.removeEventListener(e, schedule);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [settings.enabled, settings.autoLockMs]);
}
