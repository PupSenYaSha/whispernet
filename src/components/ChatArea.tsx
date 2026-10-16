import { useEffect, useRef, useState } from 'react';
import { useConnection } from '../context';
import { TopBar } from './TopBar';
import { MessageList } from './MessageList';
import { MessageInput } from './MessageInput';
import { SettingsPanel } from './SettingsPanel';
import { ChatSearch } from './ChatSearch';
import { PinnedBar } from './PinnedBar';

export function ChatArea({ showContacts: _showContacts, isMobile, onBack }: { showContacts: boolean; isMobile?: boolean; onBack?: () => void }) {
  const { state, t, loadOlderMessages } = useConnection();
  const [showSettings, setShowSettings] = useState(false);
  const [settingsClosing, setSettingsClosing] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  /** The drawer's exit animation, on a clock that is cleaned up. See `handleCloseSettings`. */
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isDm = state.activeChannel !== 'general';
  const currentMessages = isDm ? state.dmMessages[state.activeChannel] || [] : state.messages;
  const window_ = isDm ? (state.dmHistory[state.activeChannel] || null) : state.generalHistory;
  const fontSizeClass = state.settings.fontSize === 'small' ? 'text-[13px]'
    : state.settings.fontSize === 'large' ? 'text-[17px]'
    : 'text-[15px]';
  const pinned = state.pinned[state.activeChannel] || [];

  const handleLoadOlder = async () => {
    if (loadingOlder) return;
    setLoadingOlder(true);
    try {
      await loadOlderMessages(isDm ? state.activeChannel : null, window_?.oldest ?? null);
    } finally {
      setLoadingOlder(false);
    }
  };

  const handleCloseSettings = () => {
    setSettingsClosing(true);
    // This used to be a bare `setTimeout`, so a conversation closed inside those 250 ms left the panel
    // mounted with `settingsClosing` stuck true - a drawer frozen mid-animation that nothing could close.
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      setShowSettings(false);
      setSettingsClosing(false);
    }, 250);
  };
  useEffect(() => () => {
    if (closeTimerRef.current) { clearTimeout(closeTimerRef.current); closeTimerRef.current = null; }
  }, []);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <TopBar onSettingsClick={() => setShowSettings(true)} isMobile={isMobile} onBack={onBack} />
      {state.searchOpen && <ChatSearch />}
      {pinned.length > 0 && !state.searchOpen && <PinnedBar channel={state.activeChannel} messages={pinned} />}
      <MessageList
        key={state.activeChannel}
        messages={currentMessages}
        fontSizeClass={fontSizeClass}
        t={t}
        hasMore={window_?.hasMore !== false}
        loadingOlder={loadingOlder}
        onLoadMore={handleLoadOlder}
        jumpToMessageId={state.jumpToMessageId}
        pinnedIds={pinned.map((m) => m.id)}
        channel={state.activeChannel}
        compact={!!state.settings.compactMode}
      />
      <div className="border-t border-border-default">
        <MessageInput />
      </div>
      {!isMobile && showSettings && <SettingsPanel onClose={handleCloseSettings} closing={settingsClosing} />}
    </div>
  );
}
