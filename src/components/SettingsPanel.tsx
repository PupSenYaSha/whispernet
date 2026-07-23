import { useState, useEffect, useRef } from 'react';
import type { AccentColor } from '../types';
import type { EncryptedKeyBundle } from '../crypto-keys';
import { useConnection } from '../context';
import { cn, getAvatarText } from '../utils';
import { encryptPrivateKey, isEncryptedBundle, createBackup, downloadBackup, isKeyBackup } from '../crypto-keys';
import { generateSafetyNumber } from '../crypto';

declare const __APP_VERSION__: string;

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200',
        checked ? 'bg-accent-primary' : 'bg-bg-tertiary border-border-default'
      )}
    >
      <span className={cn(
        'pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-lg ring-0 transition duration-200',
        checked ? 'translate-x-5' : 'translate-x-0'
      )} />
    </button>
  );
}

function Option({ label, icon, children }: { label: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between py-3.5 px-4">
      <div className="flex items-center gap-3">
        {icon && <div className="w-9 h-9 rounded-xl bg-bg-tertiary flex items-center justify-center text-fg-muted flex-shrink-0">{icon}</div>}
        <span className="text-[15px] text-fg-primary">{label}</span>
      </div>
      {children}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-0">
      <h3 className="text-[11px] font-semibold text-fg-muted uppercase tracking-wider px-1 mb-2">{title}</h3>
      <div className="rounded-2xl border border-border-default divide-y divide-border-default overflow-hidden">
        {children}
      </div>
    </section>
  );
}

function PasswordModal({ title, onConfirm, onCancel }: {
  title: string; onConfirm: (password: string) => void; onCancel: () => void;
}) {
  const [password, setPassword] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  return (
    <>
      <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[60]" onClick={onCancel} />
      <div className="fixed inset-0 z-[61] flex items-center justify-center p-4">
        <div className="bg-bg-secondary border border-border-default rounded-2xl shadow-2xl max-w-sm w-full p-6" style={{ animation: 'scaleIn 0.2s cubic-bezier(0.22, 1, 0.36, 1)' }}>
          <div className="w-14 h-14 rounded-2xl bg-accent-primary/15 flex items-center justify-center mx-auto mb-5">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent-primary)" strokeWidth="2">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
          </div>
          <h3 className="text-center text-[17px] font-semibold text-fg-primary mb-4">{title}</h3>
          <input ref={inputRef} type="password" value={password} onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && password) onConfirm(password); if (e.key === 'Escape') onCancel(); }}
            className="w-full px-4 py-3 rounded-xl bg-bg-tertiary border border-border-default text-[15px] text-fg-primary placeholder:text-fg-muted focus:outline-none focus:ring-2 focus:ring-accent-primary mb-4"
            placeholder="Password" />
          <div className="flex gap-3">
            <button onClick={onCancel}
              className="flex-1 py-3 rounded-2xl border border-border-default text-fg-primary text-[15px] font-medium hover:bg-bg-tertiary transition-colors">
              Cancel
            </button>
            <button onClick={() => password && onConfirm(password)} disabled={!password}
              className="flex-1 py-3 rounded-2xl bg-accent-primary text-accent-text text-[15px] font-semibold hover:opacity-90 transition-colors disabled:opacity-40">
              OK
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function ConfirmModal({ title, message, confirmLabel, cancelLabel, danger, onConfirm, onCancel }: {
  title: string; message: string; confirmLabel: string; cancelLabel: string; danger?: boolean;
  onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <>
      <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[60]" onClick={onCancel} />
      <div className="fixed inset-0 z-[61] flex items-center justify-center p-4">
        <div className="bg-bg-secondary border border-border-default rounded-2xl shadow-2xl max-w-sm w-full p-6" style={{ animation: 'scaleIn 0.2s cubic-bezier(0.22, 1, 0.36, 1)' }}>
          <div className={cn('w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-5',
            danger ? 'bg-status-error/15' : 'bg-accent-primary/15'
          )}>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke={danger ? 'var(--color-status-error)' : 'var(--color-accent-primary)'} strokeWidth="2">
              {danger ? (
                <><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></>
              ) : (
                <><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></>
              )}
            </svg>
          </div>
          <h3 className="text-center text-[17px] font-semibold text-fg-primary mb-2">{title}</h3>
          <p className="text-center text-[14px] text-fg-muted mb-6 leading-relaxed">{message}</p>
          <div className="flex gap-3">
            <button onClick={onCancel}
              className="flex-1 py-3 rounded-2xl border border-border-default text-fg-primary text-[15px] font-medium hover:bg-bg-tertiary transition-colors">
              {cancelLabel}
            </button>
            <button onClick={onConfirm}
              className={cn('flex-1 py-3 rounded-2xl text-[15px] font-semibold transition-colors',
                danger
                  ? 'bg-status-error text-white hover:opacity-90'
                  : 'bg-accent-primary text-accent-text hover:opacity-90'
              )}>
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

export function SettingsPanel({ onClose, closing, inline }: { onClose: () => void; closing?: boolean; inline?: boolean }) {
  const { state, updateSettings, logout, getMyPublicKey, getPublicKey, sessions, requestSessions, showImportModal, t } = useConnection();
  const [confirmAction, setConfirmAction] = useState<'logout' | 'clearData' | null>(null);
  const [exportModal, setExportModal] = useState(false);

  useEffect(() => {
    if (!inline) {
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = ''; };
    }
  }, [inline]);

  const accentColors: AccentColor[] = ['purple', 'blue', 'green', 'red', 'orange', 'pink', 'teal', 'indigo'];
  const accentColorPreview: Record<AccentColor, string> = {
    purple: '#8b5cf6', blue: '#3b82f6', green: '#22c55e', red: '#ef4444',
    orange: '#f97316', pink: '#ec4899', teal: '#14b8a6', indigo: '#6366f1',
  };

  const SafetyNumberButton = () => {
    const [showSafety, setShowSafety] = useState(false);
    const [safetyNum, setSafetyNum] = useState('');
    const [copyOk, setCopyOk] = useState(false);

    const showNumber = async () => {
      try {
        const pubKey = getMyPublicKey();
        if (!pubKey) {
          setSafetyNum('KEY NOT FOUND — re-login required');
          setShowSafety(true);
          return;
        }
        const otherKey = state.activeChannel !== 'general' ? getPublicKey(state.activeChannel) : null;
        const num = await generateSafetyNumber(pubKey, otherKey || undefined);
        setSafetyNum(num);
        setShowSafety(true);
      } catch (e: any) {
        setSafetyNum('ERROR: ' + (e.message || 'unknown'));
        setShowSafety(true);
      }
    };

    const handleCopy = async () => {
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(safetyNum);
        } else {
          const ta = document.createElement('textarea');
          ta.value = safetyNum;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
        }
        setCopyOk(true);
        setTimeout(() => setCopyOk(false), 2000);
      } catch {}
    };

    return (
      <>
        <button onClick={showNumber}
          className="px-3 py-1.5 rounded-xl text-[13px] font-medium bg-bg-tertiary text-fg-muted hover:text-fg-primary transition-colors">
          {t('safety_number')}
        </button>
        {showSafety && (
          <>
            <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[60]" onClick={() => setShowSafety(false)} />
            <div className="fixed inset-0 flex items-center justify-center z-[61] p-4">
              <div className="bg-bg-secondary border border-border-default rounded-2xl w-full max-w-sm p-6 space-y-4 animate-in" onClick={(e) => e.stopPropagation()}>
                <h3 className="text-[17px] font-semibold text-fg-primary">{t('safety_yours')}</h3>
                <p className="text-[13px] text-fg-muted">{t('safety_number_desc')}</p>
                <div className="p-4 rounded-xl bg-bg-tertiary font-mono text-[13px] text-fg-primary break-all text-center leading-relaxed">
                  {safetyNum}
                </div>
                <button onClick={handleCopy}
                  className="w-full py-3 rounded-xl border border-border-default text-fg-primary text-[15px] hover:bg-bg-tertiary transition-colors font-medium">
                  {copyOk ? '✓ Copied' : t('copy')}
                </button>
                <button onClick={() => setShowSafety(false)}
                  className="w-full py-3 rounded-xl bg-accent-primary text-accent-text text-[15px] font-semibold hover:opacity-90 transition-opacity">
                  {t('done')}
                </button>
              </div>
            </div>
          </>
        )}
      </>
    );
  };

  const content = (
    <div className="flex-1 overflow-y-auto p-4 space-y-6">
      <Section title={t('sec_appearance')}>
        <Option label={t('theme')} icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" /></svg>}>
          <div className="flex gap-1.5">
            {(['dark', 'light'] as const).map((theme) => (
              <button key={theme} onClick={() => updateSettings({ theme })}
                className={cn(
                  'flex-1 px-2 py-1.5 rounded-xl text-[13px] font-medium transition-all whitespace-nowrap',
                  state.settings.theme === theme
                    ? 'bg-accent-primary text-accent-text'
                    : 'bg-bg-tertiary text-fg-muted hover:text-fg-primary'
                )}>
                {theme === 'dark' ? t('theme_dark') : t('theme_light')}
              </button>
            ))}
          </div>
        </Option>
        <Option label={t('accent_color')} icon={<div className="w-4 h-4 rounded-full" style={{ backgroundColor: accentColorPreview[state.settings.accentColor || 'purple'] }} />}>
          <div className="flex gap-1.5 flex-wrap justify-end max-w-[180px]">
            {accentColors.map((color) => (
              <button key={color} onClick={() => updateSettings({ accentColor: color })}
                className={cn(
                  'w-7 h-7 rounded-full transition-all duration-200 border-2',
                  (state.settings.accentColor || 'purple') === color
                    ? 'border-fg-primary scale-110'
                    : 'border-transparent hover:scale-110'
                )}
                style={{ backgroundColor: accentColorPreview[color] }}
                title={t(`accent_${color}`)}
              />
            ))}
          </div>
        </Option>
        <Option label={t('language')} icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" /></svg>}>
          <div className="flex gap-1.5">
            {(['en', 'ru'] as const).map((lang) => (
              <button key={lang} onClick={() => updateSettings({ language: lang })}
                className={cn(
                  'flex-1 min-w-0 px-1.5 py-1.5 rounded-xl text-[11px] font-medium transition-all',
                  state.settings.language === lang
                    ? 'bg-accent-primary text-accent-text'
                    : 'bg-bg-tertiary text-fg-muted hover:text-fg-primary'
                )}>
                {lang === 'en' ? 'English' : 'Русский'}
              </button>
            ))}
          </div>
        </Option>
      </Section>

      <Section title={t('sec_text')}>
        <Option label={t('font_size')} icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="4 7 4 4 20 4 20 7" /><line x1="9" y1="20" x2="15" y2="20" /><line x1="12" y1="4" x2="12" y2="20" /></svg>}>
          <div className="flex gap-1.5">
            {(['small', 'normal', 'large'] as const).map((size) => (
              <button key={size} onClick={() => updateSettings({ fontSize: size })}
                className={cn(
                  'flex-1 min-w-0 px-1.5 py-1.5 rounded-xl text-[11px] font-medium transition-all',
                  state.settings.fontSize === size
                    ? 'bg-accent-primary text-accent-text'
                    : 'bg-bg-tertiary text-fg-muted hover:text-fg-primary'
                )}>
                {t(`font_${size}`)}
              </button>
            ))}
          </div>
        </Option>
        <Option label={t('compact_mode')} icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="21" y1="10" x2="3" y2="10" /><line x1="21" y1="6" x2="3" y2="6" /><line x1="21" y1="14" x2="3" y2="14" /><line x1="21" y1="18" x2="3" y2="18" /></svg>}>
          <Toggle checked={state.settings.compactMode || false} onChange={(v) => updateSettings({ compactMode: v })} />
        </Option>
      </Section>

      <Section title={t('sec_notifications')}>
        <Option label={t('enable_notifications')} icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 0 1-3.46 0" /></svg>}>
          <Toggle checked={state.settings.notifications} onChange={(v) => updateSettings({ notifications: v })} />
        </Option>
        <Option label={t('message_sound')} icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" /><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" /></svg>}>
          <Toggle checked={state.settings.soundEnabled} onChange={(v) => updateSettings({ soundEnabled: v })} />
        </Option>
      </Section>

      <Section title={t('sec_safety')}>
        <Option label={t('safety_number')} icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>}>
          <SafetyNumberButton />
        </Option>
        <Option label={t('export_keys')} icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>}>
          <button onClick={() => setExportModal(true)} className="text-[13px] text-accent-primary hover:underline">{t('export_keys')}</button>
        </Option>
        <Option label={t('import_keys')} icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>}>
          <input type="file" accept=".json" className="hidden" id={`import-keys-input${inline ? '-inline' : ''}`} onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            try {
              const text = await file.text();
              const data = JSON.parse(text);
              if (!isKeyBackup(data)) { alert(t('key_import_err')); return; }
              showImportModal(data, 'settings');
            } catch { alert(t('key_import_err')); }
            e.target.value = '';
          }} />
          <label htmlFor={`import-keys-input${inline ? '-inline' : ''}`} className="text-[13px] text-accent-primary hover:underline cursor-pointer">{t('import_keys')}</label>
        </Option>
        <Option label={t('screenshot_prot')} icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" /><line x1="3" y1="3" x2="21" y2="21" /></svg>}>
          <Toggle checked={!!localStorage.getItem('wn_screenshot_prot')} onChange={(v) => {
            if (v) localStorage.setItem('wn_screenshot_prot', '1');
            else localStorage.removeItem('wn_screenshot_prot');
          }} />
        </Option>
      </Section>

      <Section title={t('sessions')}>
        <div className="px-4 py-3">
          <button onClick={requestSessions} className="text-[13px] text-accent-primary hover:underline mb-2">{t('sessions_desc')}</button>
          {sessions.length > 0 && (
            <div className="space-y-2 mt-2">
              {sessions.map((s) => (
                <div key={s.id} className="flex items-center justify-between py-2 px-3 rounded-xl bg-bg-tertiary">
                  <div>
                    <span className="text-[13px] text-fg-primary">{t('sessions')} (you)</span>
                    <span className="text-[11px] text-fg-muted block">{new Date(s.lastActive).toLocaleTimeString()}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </Section>

      <Section title={t('sec_account')}>
        <Option label={state.nickname ? `@${state.nickname}` : ''} icon={<div className="w-9 h-9 rounded-xl bg-accent-primary/15 flex items-center justify-center text-[13px] font-bold text-accent-primary">{state.nickname ? getAvatarText(state.nickname) : ''}</div>}>
          <span className="text-[12px] text-fg-muted">{t('version')} {typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : ''}</span>
        </Option>
      </Section>
    </div>
  );

  if (inline) {
    return (
      <div className="h-full flex flex-col bg-bg-secondary">
        <div className="px-4 h-14 flex items-center border-b border-border-default">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-accent-primary/15 flex items-center justify-center">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent-primary)" strokeWidth="2">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </div>
            <h2 className="text-[17px] font-semibold text-fg-primary">{t('settings')}</h2>
          </div>
        </div>

        {content}

        <div className="p-4 border-t border-border-default space-y-2.5 pb-safe">
          <button onClick={() => setConfirmAction('logout')}
            className="w-full py-3 rounded-2xl border border-border-default text-fg-primary text-[15px] hover:bg-bg-tertiary transition-colors font-medium flex items-center justify-center gap-2">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" />
            </svg>
            {t('logout')}
          </button>
          <button onClick={() => setConfirmAction('clearData')}
            className="w-full py-3 rounded-2xl text-status-error text-[13px] hover:bg-status-error/10 transition-colors font-medium">
            {t('clear_local_data')}
          </button>
        </div>

        {confirmAction === 'logout' && (
          <ConfirmModal title={t('confirm_logout')} message={t('confirm_logout_desc')} confirmLabel={t('logout')} cancelLabel={t('cancel')} danger
            onConfirm={() => { logout(); window.location.reload(); }} onCancel={() => setConfirmAction(null)} />
        )}
        {confirmAction === 'clearData' && (
          <ConfirmModal title={t('confirm_clear_data')} message={t('confirm_clear_data_desc')} confirmLabel={t('confirm_clear')} cancelLabel={t('cancel')} danger
            onConfirm={() => { (() => { const keys = Object.keys(localStorage).filter(k => k.startsWith('wn_')); keys.forEach(k => localStorage.removeItem(k)); })(); window.location.reload(); }} onCancel={() => setConfirmAction(null)} />
        )}
        {exportModal && (
          <PasswordModal title={t('enter_backup_password')} onCancel={() => setExportModal(false)} onConfirm={async (pass) => {
            try {
              const nick = state.nickname.toLowerCase();
              const savedKey = localStorage.getItem(`wn_pk_${nick}`);
              const savedPubKey = localStorage.getItem(`wn_pub_${nick}`);
              if (!savedKey || !savedPubKey) return;
              const parsed = JSON.parse(savedKey);
              let bundle: EncryptedKeyBundle;
              if (isEncryptedBundle(parsed)) { bundle = parsed; } else {
                bundle = await encryptPrivateKey(parsed, pass);
                bundle.publicKey = JSON.parse(savedPubKey);
              }
              const backup = createBackup(state.nickname, bundle.publicKey, bundle);
              downloadBackup(backup);
            } catch {}
            setExportModal(false);
          }} />
        )}
      </div>
    );
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-40" onClick={onClose} style={{ animation: closing ? 'fadeOut 0.25s ease-in forwards' : 'fadeIn 0.2s ease-out' }} />

      <div className="fixed right-0 top-0 h-full w-full max-w-sm bg-bg-secondary border-l border-border-default z-50 flex flex-col" style={{ animation: closing ? 'slideOutToRight 0.25s ease-in forwards' : 'slideInFromRight 0.3s cubic-bezier(0.22, 1, 0.36, 1)' }}>
        <div className="flex items-center justify-between px-4 h-14 border-b border-border-default">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-accent-primary/15 flex items-center justify-center">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent-primary)" strokeWidth="2">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </div>
            <h2 className="text-[17px] font-semibold text-fg-primary">{t('settings')}</h2>
          </div>
          <button onClick={onClose} className="p-2 rounded-xl hover:bg-bg-tertiary text-fg-muted transition-colors" aria-label={t('close_settings')}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {content}

        <div className="p-4 border-t border-border-default space-y-2.5 pb-safe">
          <button onClick={() => setConfirmAction('logout')}
            className="w-full py-3 rounded-2xl border border-border-default text-fg-primary text-[15px] hover:bg-bg-tertiary transition-colors font-medium flex items-center justify-center gap-2">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" />
            </svg>
            {t('logout')}
          </button>
          <button onClick={() => setConfirmAction('clearData')}
            className="w-full py-3 rounded-2xl text-status-error text-[13px] hover:bg-status-error/10 transition-colors font-medium">
            {t('clear_local_data')}
          </button>
        </div>
      </div>

      {confirmAction === 'logout' && (
        <ConfirmModal title={t('confirm_logout')} message={t('confirm_logout_desc')} confirmLabel={t('logout')} cancelLabel={t('cancel')} danger
          onConfirm={() => { logout(); onClose(); }} onCancel={() => setConfirmAction(null)} />
      )}
      {confirmAction === 'clearData' && (
        <ConfirmModal title={t('confirm_clear_data')} message={t('confirm_clear_data_desc')} confirmLabel={t('confirm_clear')} cancelLabel={t('cancel')} danger
          onConfirm={() => { (() => { const keys = Object.keys(localStorage).filter(k => k.startsWith('wn_')); keys.forEach(k => localStorage.removeItem(k)); })(); window.location.reload(); }} onCancel={() => setConfirmAction(null)} />
      )}
      {exportModal && (
        <PasswordModal title={t('enter_backup_password')} onCancel={() => setExportModal(false)} onConfirm={async (pass) => {
          try {
            const nick = state.nickname.toLowerCase();
            const savedKey = localStorage.getItem(`wn_pk_${nick}`);
            const savedPubKey = localStorage.getItem(`wn_pub_${nick}`);
            if (!savedKey || !savedPubKey) return;
            const parsed = JSON.parse(savedKey);
            let bundle: EncryptedKeyBundle;
            if (isEncryptedBundle(parsed)) { bundle = parsed; } else {
              bundle = await encryptPrivateKey(parsed, pass);
              bundle.publicKey = JSON.parse(savedPubKey);
            }
            const backup = createBackup(state.nickname, bundle.publicKey, bundle);
            downloadBackup(backup);
          } catch {}
          setExportModal(false);
        }} />
      )}
    </>
  );
}
