import { useState, useEffect, useRef } from 'react';
import { useConnection } from '../context';
import { cn, formatTime, getAvatarText } from '../utils';

export function ContactsPanel({ onSelect }: { onSelect: () => void }) {
  const { state, openDm, openGeneral, refreshContacts, searchUsers, t } = useConnection();
  const isDm = state.activeChannel !== 'general';
  const [query, setQuery] = useState('');
  const debounceRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    refreshContacts();
  }, []);

  const handleSearch = (value: string) => {
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      searchUsers(value);
    }, 300);
  };

  return (
    <div className="w-full h-full flex flex-col bg-bg-secondary border-r border-border-default">
      <div className="px-4 h-14 flex items-center border-b border-border-default">
        <h2 className="text-[15px] font-bold text-fg-primary">{t('chats')}</h2>
      </div>

      <div className="px-3 py-2.5">
        <input
          type="text"
          value={query}
          onChange={(e) => handleSearch(e.target.value)}
          placeholder={t('search_placeholder')}
          className="w-full px-4 py-2.5 rounded-2xl bg-bg-tertiary border border-border-default text-[15px] text-fg-primary placeholder:text-fg-muted focus:outline-none focus:ring-2 focus:ring-accent-primary"
        />
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="p-2">
          <button
            onClick={() => { openGeneral(); onSelect(); }}
            className={cn(
              'w-full flex items-center gap-3.5 px-3 py-3 rounded-2xl transition-all text-left',
              !isDm ? 'bg-accent-primary/10 text-accent-primary' : 'hover:bg-bg-tertiary text-fg-primary'
            )}
          >
            <div className="w-12 h-12 rounded-2xl bg-accent-primary/20 flex items-center justify-center flex-shrink-0">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            </div>
            <div>
              <span className="text-[15px] font-semibold">{t('general')}</span>
              <span className="block text-[12px] text-fg-muted mt-0.5">{t('chat')}</span>
            </div>
          </button>
        </div>

        {query.length > 0 && state.searchResults.length > 0 && (
          <>
            <div className="px-4 py-2">
              <span className="text-[11px] font-semibold text-fg-muted uppercase tracking-wider">{t('search_results')}</span>
            </div>
            <div className="p-2 space-y-0.5">
              {state.searchResults.map(user => (
                <button
                  key={user.id}
                  onClick={() => { openDm(user.id); setQuery(''); onSelect(); }}
                  className="w-full flex items-center gap-3.5 px-3 py-3 rounded-2xl transition-all text-left hover:bg-bg-tertiary text-fg-primary"
                >
                  <div className="w-12 h-12 rounded-2xl bg-accent-primary/10 flex items-center justify-center flex-shrink-0 relative">
                    <span className="text-[13px] font-bold text-accent-primary">
                      {getAvatarText(user.nickname)}
                    </span>
                    {user.online && (
                      <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-status-success border-[2.5px] border-bg-secondary" />
                    )}
                  </div>
                  <div>
                    <span className="text-[15px] font-semibold">@{user.nickname}</span>
                    <span className={cn('block text-[12px] mt-0.5', user.online ? 'text-status-success' : 'text-fg-muted')}>
                      {user.online ? t('online') : t('offline')}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          </>
        )}

        {query.length > 0 && state.searchResults.length === 0 && (
          <div className="px-4 py-8 text-center">
            <p className="text-[13px] text-fg-muted">{t('no_results')}</p>
          </div>
        )}

        {query.length === 0 && (
          <>
            <div className="px-4 py-2">
              <span className="text-[11px] font-semibold text-fg-muted uppercase tracking-wider">{t('contacts')}</span>
            </div>
            {state.contacts.length > 0 ? (
              <div className="p-2 space-y-0.5">
                {state.contacts.map(contact => {
                  const isActive = state.activeChannel === contact.id;
                  const userOnline = state.users.some(u => u.id === contact.id);
                  return (
                    <button
                      key={contact.id}
                      onClick={() => { openDm(contact.id); onSelect(); }}
                      className={cn(
                        'w-full flex items-center gap-3.5 px-3 py-3 rounded-2xl transition-all text-left',
                        isActive ? 'bg-accent-primary/10 text-accent-primary' : 'hover:bg-bg-tertiary text-fg-primary'
                      )}
                    >
                      <div className="w-12 h-12 rounded-2xl bg-bg-tertiary flex items-center justify-center flex-shrink-0 relative">
                        <span className="text-[13px] font-bold text-fg-muted">
                          {getAvatarText(contact.nickname)}
                        </span>
                        {userOnline && (
                          <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-status-success border-[2.5px] border-bg-secondary" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <span className="text-[15px] font-semibold block truncate">@{contact.nickname}</span>
                        <span className="text-[12px] text-fg-muted mt-0.5 block">{formatTime(contact.lastMessage)}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="px-4 py-8 text-center">
                <p className="text-[13px] text-fg-muted">{t('no_contacts')}</p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
