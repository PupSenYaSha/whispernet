import { useState } from 'react';
import { useConnection } from '../context';
import { TopBar } from './TopBar';
import { MessageList } from './MessageList';
import { MessageInput } from './MessageInput';
import { SettingsPanel } from './SettingsPanel';

export function ChatArea({ showContacts: _showContacts, isMobile, onBack }: { showContacts: boolean; isMobile?: boolean; onBack?: () => void }) {
  const { state, t, identityWarning, dismissIdentityWarning } = useConnection();
  const [showSettings, setShowSettings] = useState(false);
  const [settingsClosing, setSettingsClosing] = useState(false);
  const isDm = state.activeChannel !== 'general';
  const currentMessages = isDm ? (state.dmMessages[state.activeChannel] || []) : state.messages;
  const fontSizeClass = state.settings.fontSize === 'small' ? 'text-[13px]'
    : state.settings.fontSize === 'large' ? 'text-[17px]'
    : 'text-[15px]';

  const warningForCurrent = identityWarning && (isDm && identityWarning.userId === state.activeChannel)
    ? identityWarning : null;

  const handleCloseSettings = () => {
    setSettingsClosing(true);
    setTimeout(() => { setShowSettings(false); setSettingsClosing(false); }, 250);
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <TopBar onSettingsClick={() => setShowSettings(true)} isMobile={isMobile} onBack={onBack} />
      {warningForCurrent && (
        <button onClick={dismissIdentityWarning}
          className="flex items-center gap-2 mx-3 mt-2 px-3 py-2 rounded-xl bg-red-500/15 border border-red-500/40 text-red-300 text-[12.5px] font-medium text-left leading-snug hover:bg-red-500/25 transition-colors">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 text-red-400"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></svg>
          Identity key changed for @{warningForCurrent.nickname || ''} — verify the new safety number in Security Settings.
        </button>
      )}
      <MessageList key={state.activeChannel} messages={currentMessages} fontSizeClass={fontSizeClass} t={t} />
      <div className="border-t border-border-default">
        <MessageInput />
      </div>
      {!isMobile && showSettings && <SettingsPanel onClose={handleCloseSettings} closing={settingsClosing} />}
    </div>
  );
}
