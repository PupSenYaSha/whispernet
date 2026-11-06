import { useState, useRef, useEffect } from 'react';

/**
 * Аудио-плеер для голосовых сообщений.
 *
 * Показывает прогресс, длительность и кнопку воспроизведения/паузы.
 */
export function AudioPlayer({ url, onError }: { url: string; onError?: () => void }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!audioRef.current) return;
    const audio = audioRef.current;
    const onLoaded = () => { setDuration(audio.duration); setLoaded(true); };
    const onEnded = () => { setPlaying(false); if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; } };
    const onError_ = () => { setPlaying(false); onError?.(); };
    audio.addEventListener('loadedmetadata', onLoaded);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('error', onError_);
    return () => {
      audio.removeEventListener('loadedmetadata', onLoaded);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('error', onError_);
      audio.pause();
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [url, onError]);

  const toggle = () => {
    if (!audioRef.current) return;
    if (playing) { audioRef.current.pause(); setPlaying(false); if (timerRef.current) clearInterval(timerRef.current); }
    else { audioRef.current.play().catch(() => {}); setPlaying(true); timerRef.current = setInterval(() => setCurrentTime(audioRef.current!.currentTime), 200); }
  };

  const formatTime = (seconds: number) => {
    if (!isFinite(seconds) || seconds < 0) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const progress = loaded && duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;

  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-bg-tertiary border border-border-default max-w-[200px]">
      <audio ref={audioRef} src={url} preload="metadata" />
      <button
        onClick={toggle}
        className={`w-8 h-8 rounded-full flex items-center justify-center ${playing ? 'bg-status-success text-bg-primary' : 'text-fg-muted hover:text-fg-primary hover:bg-bg-hover'} transition-colors`}
        aria-label={playing ? 'pause' : 'play'}
      >
        {playing ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><rect x="6" y="7" width="4" height="10" /><rect x="14" y="7" width="4" height="10" /></svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polygon points="5 3 19 12 5 21" /></svg>
        )}
      </button>
      <div className="flex-1 min-w-0">
        <div className="h-1.5 bg-bg-secondary/50 rounded-full overflow-hidden">
          <div className="h-full bg-accent-primary rounded-full transition-all duration-100" style={{ width: progress }}></div>
        </div>
      </div>
      <span className="text-[11px] text-fg-muted font-mono min-w-[24px]">{formatTime(currentTime)} / {formatTime(duration)}</span>
    </div>
  );
}
