import { useState, useEffect, useMemo } from 'react';
import { useConnection } from '../context';
import { cn, formatTime } from '../utils';
import { Avatar } from './Avatar';

/**
 * Which conversations the list is showing.
 *
 * The filters a chat list needs once there are more than a handful: everything, whatever has something
 * new in it, and the people rather than the public room. Each conversation remembers its own filter,
 * because the point of filtering is to come back to the conversation you were working in.
 */
type Filter = 'all' | 'unread' | 'personal';

const FILTERS: { value: Filter; key: string }[] = [
  { value: 'all', key: 'filter_all' },
  { value: 'unread', key: 'filter_unread' },
  { value: 'personal', key: 'filter_personal' },
];

function loadFilters(): Record<string, Filter> {
  try {
    const raw = localStorage.getItem('wn_chat_filters');
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, Filter> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (v === 'all' || v === 'unread' || v === 'personal') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function ChatList({ onSelect }: { onSelect?: () => void }) {
  const { state, openDm, openGeneral, openProfile, refreshContacts, searchUsers, t } = useConnection();
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<Record<string, Filter>>(loadFilters);
  const [showFilters, setShowFilters] = useState(false);
  const activeChannel = state.activeChannel;
  const filter = filters[activeChannel] || 'all';

  useEffect(() => { refreshContacts(); }, [refreshContacts]);

  // cleared as soon as there is anything typed, so a stale result list is never left sitting under the
  // conversation list pretending to be an answer
  const trimmed = query.trim();
  const searching = trimmed.length > 0;

  const setFilter = (next: Filter) => {
    const updated = { ...filters, [activeChannel]: next };
    setFilters(updated);
    try { localStorage.setItem('wn_chat_filters', JSON.stringify(updated)); } catch { /* private mode */ }
  };

  const totalUnread = useMemo(
    () => Object.values(state.unreadByChannel).reduce((sum, n) => sum + n, 0),
    [state.unreadByChannel]
  );

  const visibleContacts = useMemo(() => {
    let list = state.contacts;
    // the public room is not in this list, so the people filter only ever hides it
    if (filter === 'unread') list = list.filter((c) => (state.unreadByChannel[c.id] || 0) > 0);
    if (trimmed) list = list.filter((c) => c.nickname.toLowerCase().includes(trimmed.toLowerCase()));
    return list;
  }, [state.contacts, state.unreadByChannel, filter, trimmed]);

  const unreadFilterEmpty = filter === 'unread' && !searching && visibleContacts.length === 0 && totalUnread > 0;
  const generalUnread = state.unreadByChannel['general'] || 0;
  const showGeneral = !searching && (filter !== 'personal') && !(filter === 'unread' && generalUnread === 0);

  return (
    <div className="w-full h-full flex flex-col bg-bg-secondary border-r border-border-default">
      <div className="px-4 h-14 flex items-center justify-between gap-2 border-b border-border-default">
        <h2 className="text-[15px] font-bold text-fg-primary">{t('chats')}</h2>
        <div className="relative">
          <button
            onClick={() => setShowFilters((v) => !v)}
            className={cn(
              'px-2.5 py-1.5 rounded-xl text-[12px] font-medium transition-colors flex items-center gap-1.5',
              showFilters ? 'bg-accent-primary/15 text-accent-primary' : 'text-fg-muted hover:bg-bg-tertiary',
            )}
            aria-expanded={showFilters}
            aria-label={t('filters')}
          >
            {t(`filter_${filter}`)}
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" className={cn(showFilters && 'rotate-180')} aria-hidden="true">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
          {showFilters && (
            <div className="absolute right-0 top-full mt-1 z-30 min-w-[150px] rounded-xl bg-bg-secondary border border-border-default shadow-lg py-1">
              {FILTERS.map((f) => (
                <button
                  key={f.value}
                  onClick={() => { setFilter(f.value); setShowFilters(false); }}
                  className={cn(
                    'w-full text-left px-3 py-2 text-[13px] transition-colors flex items-center gap-2',
                    filter === f.value ? 'text-accent-primary font-medium' : 'text-fg-primary hover:bg-bg-tertiary',
                  )}
                >
                  <span className="w-3.5">{filter === f.value ? '✓' : ''}</span>
                  {t(f.key)}
                  {f.value === 'unread' && totalUnread > 0 && (
                    <span className="ml-auto text-[11px] text-fg-muted">{totalUnread}</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="px-3 py-2.5">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // the server does the matching for people; the list only filters what is already loaded
            if (e.key === 'Enter' && query.trim()) searchUsers(query.trim());
          }}
          placeholder={t('search_placeholder')}
          className="w-full px-4 py-2.5 rounded-2xl bg-bg-tertiary border border-border-default text-[15px] text-fg-primary placeholder:text-fg-muted focus:outline-none focus:ring-2 focus:ring-accent-primary"
          aria-label={t('search_placeholder')}
        />
      </div>

      <div className="flex-1 overflow-y-auto">
        {showGeneral && (
          <div className="p-2">
            <ChatRow
              nickname={t('general')}
              subtitle={t('global_chat_desc')}
              unread={generalUnread}
              active={!searching && activeChannel === 'general'}
              onClick={() => { openGeneral(); onSelect?.(); }}
              icon={<div className="w-12 h-12 rounded-2xl bg-accent-primary/20 flex items-center justify-center flex-shrink-0">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="rgb(var(--color-accent-primary))" strokeWidth="2">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
              </div>}
            />
          </div>
        )}

        {searching && state.searchResults.length > 0 && (
          <>
            <div className="px-4 py-2">
              <span className="text-[11px] font-semibold text-fg-muted uppercase tracking-wider">{t('search_results')}</span>
            </div>
            <div className="p-2 space-y-0.5">
              {state.searchResults.map((user) => (
                <ChatRow
                  key={user.id}
                  nickname={user.nickname}
                  subtitle={undefined}
                  online={user.online}
                  unread={0}
                  active={false}
                  onClick={() => { openDm(user.id, user.nickname); setQuery(''); onSelect?.(); }}
                  avatar={<Avatar userId={user.id} nickname={user.nickname} avatar={state.avatars[user.id]} className="w-12 h-12 rounded-2xl" textClassName="text-[13px]" />}
                />
              ))}
            </div>
          </>
        )}

        {searching && state.searchResults.length === 0 && (
          <p className="px-4 py-8 text-center text-[13px] text-fg-muted">{t('no_results')}</p>
        )}

        {!searching && (
          <>
            {visibleContacts.length > 0 && (
              <div className="px-4 py-2">
                <span className="text-[11px] font-semibold text-fg-muted uppercase tracking-wider">{t('chats')}</span>
              </div>
            )}
            <div className="p-2 space-y-0.5">
              {visibleContacts.map((contact) => {
                const online = state.users.some((u) => u.id === contact.id);
                return (
                  <ChatRow
                    key={contact.id}
                    nickname={contact.nickname}
                    subtitle={formatTime(contact.lastMessage)}
                    online={online}
                    unread={state.unreadByChannel[contact.id] || 0}
                    active={activeChannel === contact.id}
                    onClick={() => { openDm(contact.id, contact.nickname); onSelect?.(); }}
                    avatar={<Avatar userId={contact.id} nickname={contact.nickname} avatar={state.avatars[contact.id]} className="w-12 h-12 rounded-2xl" textClassName="text-[13px]" />}
                  />
                );
              })}
            </div>
            {visibleContacts.length === 0 && (
              <p className="px-4 py-8 text-center text-[13px] text-fg-muted">
                {unreadFilterEmpty ? t('filter_unread_empty') : t('no_chats')}
              </p>
            )}
          </>
        )}
      </div>

      <button onClick={() => { if (state.userId) openProfile(state.userId); }}
        className="flex items-center gap-3 px-4 h-14 border-t border-border-default bg-bg-secondary hover:bg-bg-tertiary transition-colors text-left flex-shrink-0">
        <Avatar userId={state.userId || ''} nickname={state.nickname} avatar={state.userId ? state.avatars[state.userId] : null}
          className="w-9 h-9 rounded-full" textClassName="text-[12px]" />
        <div className="min-w-0 flex-1">
          <span className="text-[14px] font-semibold text-fg-primary block truncate">@{state.nickname}</span>
          <span className={cn('text-[11.5px]', state.status === 'connected' ? 'text-status-success' : 'text-fg-muted')}>
            {t(state.status === 'connected' ? 'my_profile_online' : 'my_profile_offline')}
          </span>
        </div>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-fg-muted flex-shrink-0">
          <circle cx="12" cy="8" r="4" />
          <path d="M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5" />
        </svg>
      </button>
    </div>
  );
}

function ChatRow({ nickname, subtitle, online, unread, active, onClick, avatar, icon }: {
  nickname: string;
  subtitle?: string;
  online?: boolean;
  unread: number;
  active: boolean;
  onClick: () => void;
  avatar?: React.ReactNode;
  icon?: React.ReactNode;
}) {
  const { t } = useConnection();
  const strong = unread > 0;
  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full flex items-center gap-3.5 px-3 py-3 rounded-2xl transition-all text-left',
        active ? 'bg-accent-primary/10 text-accent-primary' : 'hover:bg-bg-tertiary text-fg-primary',
      )}
    >
      <div className="relative flex-shrink-0">
        {icon || avatar}
        {online && (
          <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-status-success border-[2.5px] border-bg-secondary" />
        )}
      </div>
      <div className="min-w-0 flex-1 flex items-center gap-2">
        <span className={cn('text-[15px] block truncate', strong ? 'font-bold' : 'font-semibold')}>
          {nickname.startsWith('@') ? nickname : `@${nickname}`}
        </span>
        {subtitle && (
          <span className={cn('text-[12px] shrink-0 ml-auto', unread > 0 ? 'text-accent-primary font-medium' : 'text-fg-muted')}>
            {subtitle}
          </span>
        )}
      </div>
      {unread > 0 && (
        <span
          className="flex-shrink-0 min-w-[20px] h-5 px-1.5 rounded-full bg-accent-primary text-accent-text text-[11px] font-bold flex items-center justify-center"
          aria-label={`${unread} ${t('unread')}`}
        >
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </button>
  );
}
