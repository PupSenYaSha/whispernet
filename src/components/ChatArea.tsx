import { useState } from 'react';
import { useConnection } from '../context';
import { TopBar } from './TopBar';
import { MessageList } from './MessageList';
import { MessageInput } from './MessageInput';
import { SettingsPanel } from './SettingsPanel';

export function ChatArea({ showContacts: _showContacts, isMobile, onBack }: { showContacts: boolean; isMobile?: boolean; onBack?: () => void }) {
  const { state, t, loadOlderMessages } = useConnection();
  const [showSettings, setShowSettings] = useState(false);
  const [settingsClosing, setSettingsClosing] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const isDm = state.activeChannel !== 'general';
  const currentMessages = isDm ? state.dmMessages[state.activeChannel] || [] : state.messages;
  const window_ = isDm ? (state.dmHistory[state.activeChannel] || null) : state.generalHistory;
  const fontSizeClass = state.settings.fontSize === 'small' ? 'text-[13px]'
    : state.settings.fontSize === 'large' ? 'text-[17px]'
    : 'text-[15px]';

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
    setTimeout(() => { setShowSettings(false); setSettingsClosing(false); }, 250);
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <TopBar onSettingsClick={() => setShowSettings(true)} isMobile={isMobile} onBack={onBack} />
      <MessageList key={state.activeChannel} messages={currentMessages} fontSizeClass={fontSizeClass} t={t}
        hasMore={window_?.hasMore !== false} loadingOlder={loadingOlder} onLoadMore={handleLoadOlder} />
      <div className="border-t border-border-default">
        <MessageInput />
      </div>
      {!isMobile && showSettings && <SettingsPanel onClose={handleCloseSettings} closing={settingsClosing} />}
    </div>
  );
}
