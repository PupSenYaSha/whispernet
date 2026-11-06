import { useState, useEffect, useMemo } from 'react';
import { useConnection } from '../context';
import { cn } from '../utils';
import { Avatar } from './Avatar';

export function GroupList({ onSelect, onCreate }: { onSelect?: (groupId: string) => void; onCreate?: () => void }) {
  const { state, loadGroups, t } = useConnection();
  const [query, setQuery] = useState('');

  useEffect(() => {
    loadGroups();
  }, [loadGroups]);

  const trimmed = query.trim();
  const searching = trimmed.length > 0;

  const visibleGroups = useMemo(() => {
    return state.groups
      .filter((g) => !trimmed || g.name.toLowerCase().includes(trimmed.toLowerCase()))
      .sort((a, b) => b.memberCount - a.memberCount);
  }, [state.groups, trimmed]);

  return (
    <div className="w-full h-full flex flex-col bg-bg-secondary border-r border-border-default">
      <div className="px-4 h-14 flex items-center justify-between gap-2 border-b border-border-default">
        <h2 className="text-[15px] font-bold text-fg-primary">{t('groups')}</h2>
      </div>

      <div className="px-3 py-2.5">
        <input
          data-testid="group-search"
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('search_groups')}
          className="w-full px-4 py-2.5 rounded-2xl bg-bg-tertiary border border-border-default text-[15px] text-fg-primary placeholder:text-fg-muted focus:outline-none focus:ring-2 focus:ring-accent-primary"
          aria-label={t('search_groups')}
        />
      </div>

      <div className="flex-1 overflow-y-auto">
        {searching && visibleGroups.length === 0 && (
          <p className="px-4 py-8 text-center text-[13px] text-fg-muted">{t('no_results')}</p>
        )}

        {!searching && (
          <>
            {visibleGroups.length > 0 && (
              <div className="px-4 py-2">
                <span className="text-[11px] font-semibold text-fg-muted uppercase tracking-wider">{t('groups')}</span>
              </div>
            )}
            <div className="p-2 space-y-0.5">
              {visibleGroups.map((group) => {
                const isMine = group.createdBy === state.userId;
                return (
                  <button
                    key={group.id}
                    data-testid="group-row"
                    onClick={() => { onSelect?.(group.id); }}
                    className={cn(
                      'w-full flex items-center gap-3.5 px-3 py-3 rounded-2xl transition-all text-left',
                      state.currentGroup?.id === group.id
                        ? 'bg-accent-primary/10 text-accent-primary'
                        : 'hover:bg-bg-tertiary text-fg-primary',
                    )}
                  >
                    <div className="relative flex-shrink-0">
                      <Avatar
                        userId={group.id}
                        nickname={group.name}
                        avatar={{ ext: null, updatedAt: null }}
                        className="w-12 h-12 rounded-xl flex-shrink-0"
                        textClassName="text-[14px]"
                      />
                    </div>
                    <div className="min-w-0 flex-1 flex items-center gap-2">
                      <span className={cn('text-[15px] block truncate', isMine ? 'font-bold' : 'font-semibold')}>
                        @{group.name}
                      </span>
                      <span className="text-[12px] shrink-0 ml-auto text-fg-muted">
                        {group.memberCount} {t('members')}
                      </span>
                    </div>
                    <div className="flex-shrink-0">
                      <span className={cn('text-[11px] font-medium', group.myRole === 'admin' ? 'text-accent-primary' : 'text-fg-muted')}>
                        {group.myRole === 'admin' ? t('admin') : t('member')}
                      </span>
                    </div>
                  </button>
                );
              })}
              {visibleGroups.length === 0 && !searching && (
                <p className="px-4 py-8 text-center text-[13px] text-fg-muted">{t('no_groups')}</p>
              )}
            </div>
          </>
        )}
      </div>

      <div className="px-4 py-4 border-t border-border-default bg-bg-secondary">
        <button
          data-testid="group-create"
          onClick={onCreate}
          className="w-full py-3 rounded-2xl bg-accent-primary text-accent-text text-[15px] font-semibold hover:brightness-110 transition-all flex items-center justify-center gap-2"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          {t('create_group')}
        </button>
      </div>
    </div>
  );
}
