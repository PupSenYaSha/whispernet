import { useEffect, useRef, useState } from 'react';
import type { Message } from '../types';
import { useConnection } from '../context';
import { cn, formatTime } from '../utils';
import { useEscapeKey } from '../useEscapeKey';

/**
 * Search inside the conversation that is open.
 *
 * The server does the matching, over the words it actually holds. That is a real limit and worth stating
 * rather than hiding: a private message is stored as ciphertext, so there is nothing on the server to
 * match a word against. Asking here in a private chat therefore returns nothing, and the panel says why -
 * an empty list with no explanation reads as "no matches", and people conclude the message is missing
 * when in fact the search never had anything to look at.
 */
export function ChatSearch() {
  const { state, dispatch, searchInChannel, jumpTo, t } = useConnection();
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const isDm = state.activeChannel !== 'general';

  useEscapeKey(() => dispatch({ type: 'SET_SEARCH_OPEN', open: false }), true, 45);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // a short pause before asking: a search per keystroke is a search per keystroke on the server
  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      dispatch({ type: 'SET_SEARCH_LOADING', loading: false });
      dispatch({ type: 'SET_MESSAGE_SEARCH_RESULTS', results: [] });
      return;
    }
    dispatch({ type: 'SET_SEARCH_LOADING', loading: true });
    const timer = setTimeout(() => searchInChannel(trimmed, state.activeChannel), 350);
    return () => clearTimeout(timer);
  }, [query, state.activeChannel, searchInChannel, dispatch]);

  const results = state.messageSearchResults || [];
  const showEmpty = query.trim().length >= 2 && !state.searchLoading && results.length === 0;

  return (
    <div className="border-b border-border-default bg-bg-secondary">
      <div className="flex items-center gap-2 px-3 py-2">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-fg-muted flex-shrink-0" aria-hidden="true">
          <circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('search_in_chat')}
          className="flex-1 px-2 py-1.5 rounded-lg bg-bg-tertiary border border-border-default text-[14px] text-fg-primary placeholder:text-fg-muted focus:outline-none focus:ring-2 focus:ring-accent-primary"
          aria-label={t('search_in_chat')}
        />
        {state.searchLoading && (
          <svg className="animate-spin h-4 w-4 text-fg-muted flex-shrink-0" viewBox="0 0 24 24" aria-hidden="true">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" fill="none" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        )}
        <button
          onClick={() => dispatch({ type: 'SET_SEARCH_OPEN', open: false })}
          className="p-1.5 rounded-lg hover:bg-bg-tertiary text-fg-muted transition-colors flex-shrink-0"
          aria-label={t('close')}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
        </button>
      </div>

      {isDm && (
        <p className="px-4 pb-2 text-[11.5px] text-fg-muted leading-relaxed">{t('search_dm_note')}</p>
      )}

      {query.trim().length < 2 && (
        <p className="px-4 pb-2.5 text-[11.5px] text-fg-muted">{t('search_messages_hint')}</p>
      )}

      {showEmpty && !isDm && (
        <p className="px-4 pb-2.5 text-[11.5px] text-fg-muted">{t('search_messages_none')}</p>
      )}

      {results.length > 0 && (
        <div className="max-h-64 overflow-y-auto border-t border-border-default">
          {results.map((m) => (
            <ResultRow key={m.id} message={m} onOpen={() => jumpTo(m.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

function ResultRow({ message, onOpen }: { message: Message; onOpen: () => void }) {
  const { t } = useConnection();
  const text = (message.text || '').trim();
  return (
    <button
      onClick={onOpen}
      className="w-full text-left px-4 py-2.5 hover:bg-bg-tertiary transition-colors border-b border-border-default/50 last:border-b-0"
    >
      <div className="flex items-baseline gap-2">
        <span className="text-[13px] font-semibold text-accent-primary truncate">@{message.senderNickname}</span>
        <span className="text-[11px] text-fg-muted flex-shrink-0 ml-auto">{formatTime(message.timestamp)}</span>
      </div>
      <p className="text-[13px] text-fg-primary line-clamp-2 mt-0.5 break-words">
        {text || <span className={cn('text-fg-muted italic')}>{t('encrypted_message')}</span>}
      </p>
    </button>
  );
}
