import { useEffect, useRef, useState } from 'react';
import { useConnection } from '../context';
import { useEscapeKey } from '../useEscapeKey';
import { validateNewPassword } from '../changePassword';

/**
 * Changing the account password.
 *
 * Three fields, all required, and the current one asked for first: a password change that does not prove
 * you know the old one is a way to be signed out of your own account by anyone holding the unlocked tab.
 * The new one is typed twice because a typo in a field that cannot be read back is a permanent lockout,
 * and this is the one place where a mistake costs the user their own history.
 *
 * The note about what happens on success is not decoration. After a change the keys on this device are
 * sealed under the new password and nothing is signed out, but a different device still holds the old
 * blob - so the honest thing is to say that here rather than to have somebody discover it later.
 */
export function ChangePasswordModal({ onCancel, onChanged }: { onCancel: () => void; onChanged: () => void }) {
  const { changePassword, t } = useConnection();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => { firstRef.current?.focus(); }, []);
  useEscapeKey(() => { if (!busy) onCancel(); }, true, 70);

  const submit = async () => {
    const problem = validateNewPassword(next, confirm);
    if (problem) { setError(t(problem)); return; }
    if (!current) { setError(t('password_required')); return; }
    setBusy(true);
    setError(null);
    try {
      await changePassword(current, next);
      onChanged();
    } catch {
      // the old password not opening the stored blob is the only expected failure here, and the caller
      // cannot tell it apart from a key write failing, so it is reported as one message
      setError(t('password_change_failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4" onClick={() => !busy && onCancel()}>
      <div className="absolute inset-0 bg-black/60" />
      <div
        className="relative bg-bg-secondary border border-border-default rounded-2xl shadow-2xl max-w-sm w-full p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="w-14 h-14 rounded-2xl bg-accent-primary/15 flex items-center justify-center mx-auto mb-5">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="rgb(var(--color-accent-primary))" strokeWidth="2">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
        </div>
        <h3 className="text-center text-[17px] font-semibold text-fg-primary mb-1">{t('change_password')}</h3>
        <p className="text-center text-[12px] text-fg-muted leading-relaxed mb-4">{t('change_password_desc')}</p>

        <input
          ref={firstRef}
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          placeholder={t('current_password')}
          className="w-full px-4 py-3 rounded-xl bg-bg-tertiary border border-border-default text-[15px] text-fg-primary placeholder:text-fg-muted focus:outline-none focus:ring-2 focus:ring-accent-primary mb-2"
        />
        <input
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          placeholder={t('new_password')}
          className="w-full px-4 py-3 rounded-xl bg-bg-tertiary border border-border-default text-[15px] text-fg-primary placeholder:text-fg-muted focus:outline-none focus:ring-2 focus:ring-accent-primary mb-2"
        />
        <input
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && current && next && confirm) void submit(); }}
          placeholder={t('confirm_new_password')}
          className="w-full px-4 py-3 rounded-xl bg-bg-tertiary border border-border-default text-[15px] text-fg-primary placeholder:text-fg-muted focus:outline-none focus:ring-2 focus:ring-accent-primary mb-3"
        />

        {error && <p className="text-[12.5px] text-status-error mb-3 text-center leading-relaxed">{error}</p>}

        <div className="flex gap-3">
          <button
            onClick={onCancel}
            disabled={busy}
            className="flex-1 py-3 rounded-2xl border border-border-default text-fg-primary text-[15px] font-medium hover:bg-bg-tertiary transition-colors disabled:opacity-40"
          >
            {t('cancel')}
          </button>
          <button
            onClick={() => void submit()}
            disabled={busy || !current || !next || !confirm}
            className="flex-1 py-3 rounded-2xl bg-accent-primary text-accent-text text-[15px] font-semibold hover:opacity-90 transition-colors disabled:opacity-40"
          >
            {busy ? t('loading') : t('change_password_action')}
          </button>
        </div>
      </div>
    </div>
  );
}