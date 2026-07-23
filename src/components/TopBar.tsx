import { useState } from 'react';
import { useConnection } from '../context';
import { cn } from '../utils';

export function TopBar({ onSettingsClick, isMobile, onBack }: { onSettingsClick: () => void; isMobile?: boolean; onBack?: () => void }) {
  const { state, openGeneral, t } = useConnection();
  const [showUsers, setShowUsers] = useState(false);
  const isDm = state.activeChannel !== 'general';
  const dmContact = isDm ? state.contacts.find(c => c.id === state.activeChannel) : null;
  const dmUser = isDm ? state.users.find(u => u.id === state.activeChannel) : null;
  const displayDm = dmContact || dmUser;
  const isOnline = isDm ? !!dmUser : false;

  return (
    <header className="sticky top-0 z-30 bg-bg-secondary/80 backdrop-blur-xl border-b border-border-default">
      <div className={isMobile ? "px-4" : "px-3"}>
        <div className={cn("flex items-center justify-between", isMobile ? "h-16" : "h-14")}>
          <div className="flex items-center gap-3">
            {isMobile && onBack && (
              <button onClick={onBack} className="p-2 -ml-1 rounded-xl hover:bg-bg-tertiary transition-colors text-fg-muted">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M15 18l-6-6 6-6" />
                </svg>
              </button>
            )}
            {!isMobile && isDm && (
              <button onClick={openGeneral} className="p-2 -ml-1 rounded-xl hover:bg-bg-tertiary transition-colors text-fg-muted">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M15 18l-6-6 6-6" />
                </svg>
              </button>
            )}
            <div className={cn(
              isMobile ? 'w-11 h-11 rounded-2xl' : 'w-10 h-10 rounded-2xl',
              'flex items-center justify-center flex-shrink-0 text-[13px] font-bold',
              isDm ? 'bg-accent-primary/15 text-accent-primary' : 'bg-accent-primary'
            )}>
              {isDm && displayDm ? (
                <span>{displayDm.nickname.charAt(0).toUpperCase()}</span>
              ) : (
                <svg width={isMobile ? "20" : "18"} height={isMobile ? "20" : "18"} viewBox="0 0 24 24" fill="none" stroke="var(--color-accent-text)" strokeWidth="2.5">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
              )}
            </div>
            <div>
              <h1 className={cn(isMobile ? "text-[17px]" : "text-[15px]", "font-bold text-fg-primary leading-tight")}>
                {isDm ? `@${displayDm?.nickname || '...'}` : t('global_chat')}
              </h1>
              <div className="flex items-center gap-1.5 mt-0.5">
                {isDm ? (
                  <>
                    <span className={cn(isMobile ? 'w-2.5 h-2.5' : 'w-2 h-2', 'rounded-full', isOnline ? 'bg-status-success shadow-[0_0_6px_var(--color-status-success)]' : 'bg-fg-subtle')} />
                    <span className={cn(isMobile ? 'text-[12px]' : 'text-[11px]', 'text-fg-muted')}>{isOnline ? t('online') : t('offline')}</span>
                  </>
                ) : (
                  <>
                    <span className={cn(isMobile ? 'w-2.5 h-2.5' : 'w-2 h-2', 'rounded-full', state.status === 'connected' ? 'bg-status-success shadow-[0_0_6px_var(--color-status-success)]' : state.status === 'disconnected' ? 'bg-status-error' : 'bg-status-warning animate-pulse')} />
                    <span className={cn(isMobile ? 'text-[12px]' : 'text-[11px]', 'text-fg-muted')}>{state.status === 'connected' ? t('status_connected') : state.status === 'disconnected' ? t('status_disconnected') : t('status_connecting')}</span>
                  </>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            {!isDm && state.users.length > 0 && (
              <button
                onClick={() => setShowUsers(!showUsers)}
                className="px-3 py-1.5 rounded-xl text-[12px] font-medium text-fg-muted hover:bg-bg-tertiary transition-colors"
              >
                {state.users.length + 1} {t('online_users')}
              </button>
            )}

            {!isMobile && (
              <button
                onClick={onSettingsClick}
                className="p-2 rounded-xl hover:bg-bg-tertiary transition-colors text-fg-muted hover:text-fg-primary"
                aria-label={t('settings')}
              >
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>

      {showUsers && !isDm && (
        <div className="border-t border-border-default px-4 py-2.5 bg-bg-secondary">
          <div className="flex flex-wrap gap-1.5">
            <span className="px-2.5 py-1 text-[12px] font-medium bg-accent-primary/10 text-accent-primary rounded-lg">
              @{state.nickname} (you)
            </span>
            {state.users.map(u => (
              <button key={u.id} onClick={() => { setShowUsers(false); }}
                className="px-2.5 py-1 text-[12px] font-medium bg-bg-tertiary text-fg-muted rounded-lg hover:bg-accent-primary/10 hover:text-accent-primary transition-colors cursor-pointer">
                @{u.nickname}
              </button>
            ))}
          </div>
        </div>
      )}
    </header>
  );
}
