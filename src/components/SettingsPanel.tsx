import { useState, useEffect } from 'react';
import type { AccentColor } from '../types';
import { useConnection } from '../context';
import { cn, getAvatarText } from '../utils';
import { generateSafetyNumber } from '../crypto';
import QRCode from 'qrcode';

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
        checked ? 'bg-accent-primary shadow-[0_0_10px_var(--color-accent-bg)]' : 'bg-bg-tertiary border-border-default'
      )}
    >
      <span className={cn(
        'pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-lg ring-0 transition duration-200',
        checked ? 'translate-x-5' : 'translate-x-0'
      )} />
    </button>
  );
}

function Segmented<T extends string>({ value, onChange, options }: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div className="flex gap-1 p-1 rounded-xl bg-bg-tertiary/70 border border-border-default w-full min-w-0">
      {options.map(o => (
        <button key={o.value} onClick={() => onChange(o.value)}
          className={cn(
            'flex-1 min-w-0 px-1.5 py-1.5 rounded-lg text-[12px] font-semibold transition-all whitespace-nowrap',
            value === o.value
              ? 'bg-accent-primary text-accent-text shadow-sm'
              : 'text-fg-muted hover:text-fg-primary'
          )}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Option({ label, icon, children, stacked }: { label: string; icon?: React.ReactNode; children: React.ReactNode; stacked?: boolean }) {
  return (
    <div className="py-3.5 px-4 hover:bg-bg-tertiary/40 transition-colors">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          {icon && <div className="w-9 h-9 rounded-2xl bg-gradient-to-br from-bg-tertiary to-bg-tertiary/60 border border-border-default flex items-center justify-center text-fg-muted flex-shrink-0">{icon}</div>}
          <span className="text-[15px] text-fg-primary">{label}</span>
        </div>
        {!stacked && <div className="flex-shrink-0">{children}</div>}
      </div>
      {stacked && <div className="mt-3">{children}</div>}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-0">
      <div className="flex items-center gap-2 px-1 mb-2">
        <span className="w-1 h-3.5 rounded-full bg-accent-primary/70" />
        <h3 className="text-[11px] font-bold text-fg-muted uppercase tracking-wider">{title}</h3>
      </div>
      <div className="rounded-2xl border border-border-default divide-y divide-border-default overflow-hidden bg-bg-primary/40 shadow-sm">
        {children}
      </div>
    </section>
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
  const { state, updateSettings, logout, sessions, requestSessions, isAdmin, reports, adminReports, adminBan, adminUnban, bannedUsers, adminGetBanned, adminError, dismissAdminError, revokeSession: revoke, t } = useConnection();
  const [confirmAction, setConfirmAction] = useState<'logout' | 'clearData' | 'adminBan' | 'adminUnban' | null>(null);
  const [banNick, setBanNick] = useState('');
  const [pendingBan, setPendingBan] = useState<string | null>(null);
  const [banListOpen, setBanListOpen] = useState(false);

  useEffect(() => {
    requestSessions();
    if (isAdmin) { adminReports(); adminGetBanned(); }
    if (!inline) {
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = ''; };
    }
  }, [inline, requestSessions, isAdmin, adminReports, adminGetBanned]);

  const accentColors: AccentColor[] = ['purple', 'blue', 'green', 'red', 'orange', 'pink', 'teal', 'indigo'];
  const accentColorPreview: Record<AccentColor, string> = {
    purple: '#8b5cf6', blue: '#3b82f6', green: '#22c55e', red: '#ef4444',
    orange: '#f97316', pink: '#ec4899', teal: '#14b8a6', indigo: '#6366f1',
  };

  const SafetyNumberButton = () => {
    const { state, getMyPublicKey, getPublicKey, t } = useConnection();
    const [showSafety, setShowSafety] = useState(false);
    const [safetyNum, setSafetyNum] = useState('');
    const [qrCode, setQrCode] = useState<string>('');
    const [copyOk, setCopyOk] = useState(false);

    const showNumber = async () => {
      try {
        const pubKey = getMyPublicKey();
        if (!pubKey) {
          setSafetyNum('KEY NOT FOUND -- re-login required');
          setShowSafety(true);
          return;
        }
        const otherKey = state.activeChannel !== 'general' ? getPublicKey(state.activeChannel) : null;
        const num = await generateSafetyNumber(pubKey, otherKey || undefined);
        setSafetyNum(num);
        const qr = await QRCode.toDataURL(num);
        setQrCode(qr);
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
                {qrCode && (
                  <div className="flex justify-center mb-4">
                    <img src={qrCode} alt="Safety Number QR" className="w-48 h-48" />
                  </div>
                )}
                <div className="p-4 rounded-xl bg-bg-tertiary font-mono text-[13px] text-fg-primary break-all text-center leading-relaxed">
                  {safetyNum}
                </div>
                <button onClick={handleCopy}
                  className="w-full py-3 rounded-xl border border-border-default text-fg-primary text-[15px] hover:bg-bg-tertiary transition-colors font-medium">
                  {copyOk ? 'OK Copied' : t('copy')}
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
        <Option label={t('theme')} stacked icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" /></svg>}>
          <Segmented
            value={state.settings.theme}
            onChange={(theme) => updateSettings({ theme })}
            options={[{ value: 'dark', label: t('theme_dark') }, { value: 'light', label: t('theme_light') }]}
          />
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
        <Option label={t('language')} stacked icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" /></svg>}>
          <Segmented
            value={state.settings.language}
            onChange={(lang) => updateSettings({ language: lang })}
            options={[{ value: 'en', label: 'English' }, { value: 'ru', label: t('lang_ru') }]}
          />
        </Option>
      </Section>

      <Section title={t('sec_text')}>
        <Option label={t('font_size')} stacked icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="4 7 4 4 20 4 20 7" /><line x1="9" y1="20" x2="15" y2="20" /><line x1="12" y1="4" x2="12" y2="20" /></svg>}>
          <Segmented
            value={state.settings.fontSize}
            onChange={(size) => updateSettings({ fontSize: size })}
            options={[{ value: 'small', label: t('font_small') }, { value: 'normal', label: t('font_normal') }, { value: 'large', label: t('font_large') }]}
          />
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

      <Section title={t('sec_privacy')}>
        <Option label={t('disappearing_messages')} stacked icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>}>
          <Segmented
            value={state.settings.disappearingTTL}
            onChange={(ttl) => updateSettings({ disappearingTTL: ttl })}
            options={[
              { value: 'off', label: t('disappearing_off') },
              { value: '24h', label: t('disappearing_24h') },
              { value: '7d', label: t('disappearing_7d') },
              { value: '30d', label: t('disappearing_30d') },
            ]}
          />
        </Option>
        <Option label={t('screenshot_prot')} icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" /><line x1="3" y1="3" x2="21" y2="21" /></svg>}>
          <Toggle checked={!!localStorage.getItem('wn_screenshot_prot')} onChange={(v) => {
            if (v) localStorage.setItem('wn_screenshot_prot', '1');
            else localStorage.removeItem('wn_screenshot_prot');
          }} />
        </Option>
      </Section>

      <Section title={t('sec_safety')}>
        <Option label={t('safety_number')} icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>}>
          <SafetyNumberButton />
        </Option>
      </Section>

      <Section title={t('sessions')}>
        <div className="px-4 py-3 space-y-2">
          <p className="text-[12px] text-fg-muted leading-relaxed">{t('sessions_note')}</p>
          {sessions.length === 0 ? (
            <p className="text-[13px] text-fg-muted py-1">{t('sessions_desc')}</p>
          ) : (
            sessions.map((s) => (
              <div key={s.id} className="flex items-center justify-between gap-2 px-3 py-2.5 rounded-xl bg-bg-tertiary border border-border-default">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={cn('w-2 h-2 rounded-full flex-shrink-0', s.online === false ? 'bg-fg-muted/50' : 'bg-status-success')} />
                    <span className="text-[13px] text-fg-primary truncate">{s.name || `…${s.id.slice(-6)}`}</span>
                    {s.current && (
                      <span className="flex-shrink-0 px-2 py-0.5 rounded-full bg-accent-primary/15 text-accent-primary text-[10px] font-bold">{t('current_session')}</span>
                    )}
                  </div>
                  <span className="text-[11px] text-fg-muted block mt-0.5">{new Date(s.lastActive).toLocaleString()}{s.online === false ? ` · ${t('offline')}` : ''}</span>
                </div>
                {!s.current && (
                  <button onClick={() => revoke(s.id)}
                    className="flex-shrink-0 px-2.5 py-1.5 rounded-lg border border-border-default text-fg-muted text-[11px] font-medium hover:text-status-error hover:border-status-error/40 transition-colors">
                    {t('revoke')}
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      </Section>

      {isAdmin && (
        <Section title={t('admin_section')}>
          <div className="px-4 py-3 space-y-4">
            {adminError && (
              <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-xl bg-status-error/10 border border-status-error/30 text-status-error text-[12px]">
                <span className="min-w-0 leading-relaxed">{adminError}</span>
                <button onClick={dismissAdminError} className="flex-shrink-0 text-status-error/70 hover:text-status-error text-[16px] leading-none px-1" aria-label="Dismiss">✕</button>
              </div>
            )}

            <div>
              <p className="text-[11px] font-bold text-fg-muted uppercase tracking-wider mb-1.5">{t('admin_ban_nick')}</p>
              <div className="flex gap-2 flex-wrap">
                <input
                  value={banNick}
                  onChange={(e) => setBanNick(e.target.value)}
                  placeholder={t('admin_ban_hint')}
                  maxLength={16}
                  className="flex-1 min-w-[140px] px-3.5 py-2.5 rounded-xl bg-bg-tertiary border border-border-default text-[14px] text-fg-primary placeholder:text-fg-muted focus:outline-none focus:ring-2 focus:ring-accent-primary" />
                <button
                  onClick={() => { if (banNick.trim()) { setPendingBan(banNick.trim()); setConfirmAction('adminBan'); } }}
                  disabled={!banNick.trim()}
                  className="flex-shrink-0 px-4 py-2.5 rounded-xl bg-status-error text-white text-[13px] font-semibold hover:brightness-110 transition-all disabled:opacity-40">
                  {t('admin_ban')}
                </button>
              </div>
            </div>

            <div>
              <button onClick={() => setBanListOpen(!banListOpen)}
                className="w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl bg-bg-tertiary border border-border-default hover:bg-bg-tertiary/60 transition-colors">
                <div className="flex items-center gap-2 min-w-0">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-status-error flex-shrink-0">
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                  </svg>
                  <span className="text-[14px] font-semibold text-fg-primary">{t('admin_blocked')}</span>
                  {bannedUsers.length > 0 && (
                    <span className="px-1.5 py-0.5 rounded-full bg-status-error/15 text-status-error text-[10px] font-bold">{bannedUsers.length}</span>
                  )}
                </div>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
                  className={`flex-shrink-0 text-fg-muted transition-transform duration-200 ${banListOpen ? 'rotate-180' : ''}`}>
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
              {banListOpen && (
                <div className="mt-2 space-y-1.5">
                  {bannedUsers.length === 0 ? (
                    <p className="text-[12px] text-fg-muted py-1">{t('admin_blocked_empty')}</p>
                  ) : (
                    bannedUsers.map((u) => (
                      <div key={u.userId} className="flex items-center justify-between gap-2 px-3 py-2 rounded-xl bg-bg-tertiary border border-border-default">
                        <div className="min-w-0">
                          <div className="text-[13px] text-fg-primary truncate">@{u.nickname}</div>
                          <div className="text-[11px] text-fg-muted">{new Date(u.bannedAt).toLocaleString()}</div>
                        </div>
                        <button
                          onClick={() => { setPendingBan(u.nickname); setConfirmAction('adminUnban'); }}
                          className="flex-shrink-0 px-2.5 py-1.5 rounded-lg bg-accent-primary/15 text-accent-primary text-[12px] font-semibold hover:bg-accent-primary/25 transition-colors">
                          {t('admin_unblock')}
                        </button>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>

            <div>
              <p className="text-[11px] font-bold text-fg-muted uppercase tracking-wider mb-1.5">{t('admin_reports')}</p>
              {reports.length === 0 ? (
                <p className="text-[13px] text-fg-muted py-1">{t('admin_no_reports')}</p>
              ) : (
                <div className="space-y-2">
                  {reports.map((r) => (
                    <div key={r.id} className="px-3 py-2.5 rounded-xl bg-bg-tertiary border border-border-default space-y-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[13px] font-bold text-fg-primary truncate">@{r.targetNick || '?'}</span>
                        <span className="text-[10px] text-fg-muted flex-shrink-0">{new Date(r.timestamp).toLocaleString()}</span>
                      </div>
                      {r.messageText && <p className="text-[12px] text-fg-muted leading-relaxed break-words">"{r.messageText}"</p>}
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="px-1.5 py-0.5 rounded-full bg-accent-primary/15 text-accent-primary text-[10px] font-semibold">
                          {r.channel === 'general' ? t('admin_channel_general') : t('admin_channel_dm')}
                        </span>
                        <span className="text-[12px] text-fg-primary">{r.reason}</span>
                      </div>
                      <div className="text-[11px] text-fg-subtle">from @{r.reporterNick || '?'}</div>
                      <button
                        onClick={() => { if (r.targetNick) { setPendingBan(r.targetNick); setConfirmAction('adminBan'); } }}
                        className="mt-0.5 px-3 py-1.5 rounded-lg bg-status-error/10 text-status-error text-[12px] font-semibold hover:bg-status-error/20 transition-colors">
                        {t('admin_ban')} @{r.targetNick}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </Section>
      )}

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
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
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
      </div>
    );
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/40 z-40" onClick={onClose} style={{ animation: closing ? 'fadeOut 0.25s ease-in forwards' : 'fadeIn 0.2s ease-out' }} />

      <div className="fixed right-0 top-0 h-full w-full max-w-sm bg-bg-secondary border-l border-border-default z-50 flex flex-col" style={{ animation: closing ? 'slideOutToRight 0.25s ease-in forwards' : 'slideInFromRight 0.3s cubic-bezier(0.22, 1, 0.36, 1)' }}>
        <div className="flex items-center justify-between px-4 h-14 border-b border-border-default">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-accent-primary/15 flex items-center justify-center">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent-primary)" strokeWidth="2">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
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
      {confirmAction === 'adminBan' && pendingBan && (
        <ConfirmModal title={t('admin_confirm_ban')} message={`@${pendingBan}`} confirmLabel={t('admin_ban')} cancelLabel={t('cancel')} danger
          onConfirm={() => { adminBan(pendingBan); setConfirmAction(null); setPendingBan(null); setBanNick(''); }}
          onCancel={() => { setConfirmAction(null); setPendingBan(null); }} />
      )}
      {confirmAction === 'adminUnban' && pendingBan && (
        <ConfirmModal title={t('admin_confirm_unban')} message={`@${pendingBan}`} confirmLabel={t('admin_unban')} cancelLabel={t('cancel')}
          onConfirm={() => { adminUnban(pendingBan); setConfirmAction(null); setPendingBan(null); setBanNick(''); }}
          onCancel={() => { setConfirmAction(null); setPendingBan(null); }} />
      )}
    </>
  );
}

