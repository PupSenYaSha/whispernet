import { useState, useEffect, useRef } from 'react';
import { useConnection } from '../context';
import { cn } from '../utils';

export function LoginScreen() {
  const { connect, state, t } = useConnection();
  const [isRegister, setIsRegister] = useState(false);
  const [nickname, setNickname] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const nicknameRef = useRef<HTMLInputElement>(null);

  useEffect(() => { nicknameRef.current?.focus(); }, []);

  useEffect(() => {
    document.title = 'WhisperNet';
    window.electronAPI?.setTitle('WhisperNet');
  }, []);

  useEffect(() => {
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
          <button type="button" onClick={() => setIsRegister(false)}
            className={cn('flex-1 py-3 rounded-xl text-[15px] font-semibold transition-all duration-200',
              !isRegister ? 'bg-accent-primary text-accent-text shadow-sm' : 'text-fg-muted hover:text-fg-primary')}>
            {t('login')}
          </button>
          <button type="button" onClick={() => setIsRegister(true)}
            className={cn('flex-1 py-3 rounded-xl text-[15px] font-semibold transition-all duration-200',
              isRegister ? 'bg-accent-primary text-accent-text shadow-sm' : 'text-fg-muted hover:text-fg-primary')}>
            {t('register')}
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-[13px] font-medium text-fg-secondary mb-2">{t('nickname')}</label>
            <input ref={nicknameRef} type="text" value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              className="input" placeholder={t('nickname_placeholder')}
              autoComplete="username" maxLength={16} disabled={loading} />
          </div>
          <div>
            <label className="block text-[13px] font-medium text-fg-secondary mb-2">{t('password')}</label>
            <input type="password" value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="input" placeholder={isRegister ? t('password_create') : t('password_enter')}
              autoComplete={isRegister ? 'new-password' : 'current-password'} maxLength={32} disabled={loading} />
          </div>

          {state.authError && (
            <div className="p-3 rounded-xl bg-status-error/10 border border-status-error/20 text-status-error text-sm text-center">
              {state.authError}
            </div>
          )}

          <button type="submit" disabled={loading || !nickname.trim() || !password}
            className="btn-primary w-full py-3.5 text-[15px] mt-2">
            {loading ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                {isRegister ? t('creating_account') : t('signing_in')}
              </span>
            ) : (isRegister ? t('create_account') : t('sign_in'))}
          </button>
        </form>

        <p className="text-center text-xs text-fg-subtle mt-5">{t('nickname_hint')}</p>
      </div>
    </div>
  );
}
