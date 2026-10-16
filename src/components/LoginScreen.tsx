import { useState, useEffect, useRef } from 'react';
import { useConnection } from '../context';
import { cn } from '../utils';

export function LoginScreen() {
  const { connect, state, t, cancelPow } = useConnection();
  const [isRegister, setIsRegister] = useState(false);
  const [nickname, setNickname] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const nicknameRef = useRef<HTMLInputElement>(null);

  useEffect(() => { nicknameRef.current?.focus(); }, []);

  useEffect(() => {
    document.title = 'WhisperNet';
  }, []);

  /**
   * Creating an account costs a proof-of-work search, which takes seconds.
   *
   * While it runs the fields are disabled - a second submit would start a second search against a challenge
   * the server has already handed out, and the second answer would arrive after the first. But it has to be
   * cancellable, because a disabled form with no way out is a screen someone is stuck on, and the wait is
   * long enough on a slow phone to be worth an exit.
   */
  const powRunning = isRegister && state.powProgress !== null;
  useEffect(() => { if (powRunning) setLoading(true); }, [powRunning]);

  /**
   * Leaving the register tab while a proof runs.
   *
   * The effect above only ever sets `true`, so anything that ends the proof without ending `loading` leaves
   * the form disabled for good. Switching to the sign-in tab did exactly that: `isRegister` goes false, the
   * progress panel - which holds the only Cancel button - unmounts, and the inputs stay disabled with no
   * visible way out. The proof also kept running to completion and then registered an account for the
   * nickname and password the user had just navigated away from.
   *
   * So the mode switch cancels the work and releases the form, rather than only changing which form is drawn.
   */
  const switchMode = (next: boolean) => {
    if (next === isRegister) return;
    if (state.powProgress !== null) cancelPow();
    setLoading(false);
    setIsRegister(next);
  };

  // A failed connection leaves the status on "disconnected" again, which is what it already was,
  // so a deps-based reset never fired and the form stayed disabled behind a spinner for good.
  // Watching the transition out of "connecting" covers every outcome.
  const wasConnecting = useRef(false);
  useEffect(() => {
    if (state.status === 'connecting') { wasConnecting.current = true; return; }
    if (wasConnecting.current && state.status !== 'connected') setLoading(false);
    if (state.status === 'connected' || state.authError) setLoading(false);
  }, [state.status, state.authError]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!nickname.trim() || !password) return;
    setLoading(true);
    connect(nickname.trim(), password, isRegister);
  };

  return (
    <div className="flex h-full items-center justify-center p-4 bg-bg-primary">
      <div className="w-full max-w-sm" style={{ animation: 'fadeSlideIn 0.4s cubic-bezier(0.22, 1, 0.36, 1)' }}>
        <div className="text-center mb-8">
          <img src="/logo.svg" alt="WhisperNet" className="w-20 h-20 mx-auto mb-5" />
          <h1 className="text-2xl font-bold text-fg-primary tracking-tight">WhisperNet</h1>
          <p className="text-sm text-fg-muted mt-1.5">{t('about_desc').split('.')[0]}</p>
        </div>

        <div className="flex gap-1 p-1 bg-bg-tertiary rounded-2xl mb-5">
          <button type="button" data-testid="auth-mode-login" onClick={() => switchMode(false)}
            className={cn('flex-1 py-3 rounded-xl text-[15px] font-semibold transition-all duration-200',
              !isRegister ? 'bg-accent-primary text-accent-text shadow-sm' : 'text-fg-muted hover:text-fg-primary')}>
            {t('login')}
          </button>
          <button type="button" data-testid="auth-mode-register" onClick={() => switchMode(true)}
            className={cn('flex-1 py-3 rounded-xl text-[15px] font-semibold transition-all duration-200',
              isRegister ? 'bg-accent-primary text-accent-text shadow-sm' : 'text-fg-muted hover:text-fg-primary')}>
            {t('register')}
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-[13px] font-medium text-fg-secondary mb-2">{t('nickname')}</label>
            <input ref={nicknameRef} data-testid="auth-nickname" type="text" value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              className="input" placeholder={t('nickname_placeholder')}
              autoComplete="username" maxLength={16} disabled={loading} />
          </div>
          <div>
            <label className="block text-[13px] font-medium text-fg-secondary mb-2">{t('password')}</label>
            <input data-testid="auth-password" type="password" value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="input" placeholder={isRegister ? t('password_create') : t('password_enter')}
              autoComplete={isRegister ? 'new-password' : 'current-password'} maxLength={64} disabled={loading} />
          </div>

          {state.authError && (
            <div className="p-3 rounded-xl bg-status-error/10 border border-status-error/20 text-status-error text-sm text-center animate-step-in">
              {state.authError}
            </div>
          )}

          {powRunning && (
            <div className="p-3 rounded-xl bg-bg-tertiary border border-border-default text-sm animate-step-in">
              <div className="flex items-center justify-between text-fg-secondary mb-2">
                <span>{t('pow_working')}</span>
                {/* Not a fake percentage: the search reports how far it has actually got, which is uneven
                    by nature, and a bar that jumps around is more honest than one that creeps. */}
                <span className="tabular-nums text-fg-muted">{Math.round((state.powProgress ?? 0) * 100)}%</span>
              </div>
              <div className="w-full h-1.5 bg-bg-primary rounded-full overflow-hidden">
                <div className="h-full bg-accent-primary rounded-full transition-all duration-200"
                  style={{ width: `${Math.max(2, (state.powProgress ?? 0) * 100)}%` }} />
              </div>
              <p className="text-xs text-fg-subtle mt-2">{t('pow_explainer')}</p>
              <button type="button" onClick={() => { cancelPow(); setLoading(false); }}
                className="mt-2 text-xs text-fg-muted hover:text-fg-primary underline underline-offset-2 transition-colors">
                {t('pow_cancel')}
              </button>
            </div>
          )}

          <button type="submit" data-testid="auth-submit" disabled={loading || !nickname.trim() || !password}
            className="btn-primary w-full py-3.5 text-[15px] mt-2">
            {loading ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                {powRunning ? t('pow_working_short') : (isRegister ? t('creating_account') : t('signing_in'))}
              </span>
            ) : (isRegister ? t('create_account') : t('sign_in'))}
          </button>
        </form>

        <p className="text-center text-xs text-fg-subtle mt-5">{t('nickname_hint')}</p>
      </div>
    </div>
  );
}
