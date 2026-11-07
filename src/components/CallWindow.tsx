/**
 * In-call window: local and remote video, microphone/camera toggles, hang up.
 *
 * The parent is responsible for the WebRTC signalling (offer/answer/candidate)
 * via the existing websocket. This component only owns the local media stream,
 * the peer connection lifecycle, and the UI.
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { createPeerConnection, OFFER_CONSTRAINTS } from '../webrtc';

interface CallWindowProps {
  /** The peer we are calling or being called by. */
  peerId: string;
  /** True when this device initiated the call. */
  isCaller: boolean;
  /** Called when the user ends the call. */
  onHangUp: () => void;
  /** Called when the remote SDP offer arrives (parent routes it through the socket). */
  onOffer: (sdp: RTCSessionDescriptionInit) => void;
  /** Called when the remote SDP answer arrives. */
  onAnswer: (sdp: RTCSessionDescriptionInit) => void;
  /** Called when an ICE candidate arrives. */
  onCandidate: (candidate: RTCIceCandidateInit) => void;
  /** Whether the call is currently connected (iceConnectionState === connected). */
  connected?: boolean;
}

export function CallWindow({ peerId, isCaller, onHangUp, onOffer, onAnswer: _onAnswer, onCandidate, connected }: CallWindowProps) {
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const [micEnabled, setMicEnabled] = useState(true);
  const [camEnabled, setCamEnabled] = useState(true);
  const [localReady, setLocalReady] = useState(false);

  const startLocalMedia = useCallback(async () => {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: camEnabled ? true : false,
        video: camEnabled ? { width: 640, height: 480 } : false,
      });
    } catch {
      // No camera/mic permission or hardware: fall back to audio-only if possible
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        setCamEnabled(false);
      } catch {
        setMicEnabled(false);
        setCamEnabled(false);
        return;
      }
    }
    localStreamRef.current = stream;
    if (localVideoRef.current) localVideoRef.current.srcObject = stream;
    setLocalReady(true);
  }, [camEnabled]);

  const createConnection = useCallback(async () => {
    const pc = createPeerConnection();
    pcRef.current = pc;

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        onCandidate({ candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid, sdpMLineIndex: e.candidate.sdpMLineIndex });
      }
    };

    pc.onconnectionstatechange = () => {
      // no-op here; parent reads connected from its own state
    };

    pc.ontrack = (e) => {
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = e.streams[0];
      }
    };

    if (localStreamRef.current) {
      for (const track of localStreamRef.current.getTracks()) {
        pc.addTrack(track, localStreamRef.current);
      }
    }

    if (isCaller) {
      const offer = await pc.createOffer(OFFER_CONSTRAINTS);
      await pc.setLocalDescription(offer);
      onOffer(offer);
    }
  }, [isCaller, onOffer, onCandidate]);

  useEffect(() => {
    startLocalMedia().then(() => {
      void createConnection();
    });
    return () => {
      pcRef.current?.close();
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, [startLocalMedia, createConnection]);

  const handleHangUp = () => {
    pcRef.current?.close();
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    onHangUp();
  };

  const toggleMic = () => {
    setMicEnabled((prev) => {
      localStreamRef.current?.getAudioTracks().forEach((t) => { t.enabled = !prev; });
      return !prev;
    });
  };

  const toggleCam = () => {
    setCamEnabled((prev) => {
      localStreamRef.current?.getVideoTracks().forEach((t) => { t.enabled = !prev; });
      return !prev;
    });
  };

  if (!localReady && !connected) {
    return (
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80">
        <div className="text-fg-primary text-lg font-medium animate-pulse">Подключение к звонку…</div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/90 backdrop-blur-sm" onClick={handleHangUp}>
      <div
        className="relative bg-[#0a0a0a] border border-border-default rounded-3xl shadow-2xl w-full max-w-2xl max-h-[85vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-border-default flex items-center justify-between">
          <h2 className="text-lg font-semibold text-fg-primary">Звонок с @{peerId}</h2>
          <button
            onClick={handleHangUp}
            className="p-2 rounded-full text-fg-muted hover:bg-status-error/20 hover:text-status-error transition-colors"
            aria-label="Завершить звонок"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="flex-1 flex items-center justify-center p-2 min-h-[300px] relative">
          {/* Local video (small, bottom-left) */}
          {localReady && (
            <div className="absolute left-3 bottom-3 w-32 h-24 rounded-xl border border-border-default bg-black overflow-hidden">
              <video ref={localVideoRef} autoPlay muted playsInline className="w-full h-full object-cover" />
              <div className="absolute bottom-1 left-1 bg-black/60 text-[10px] text-fg-primary px-1.5 py-0.5 rounded">
                Вы
              </div>
            </div>
          )}
          {/* Remote video (large, center) */}
          <div className="relative w-full h-full min-w-[200px] min-h-[200px] bg-[#050505] flex items-center justify-center">
            <video ref={remoteVideoRef} autoPlay playsInline className="w-full h-full object-contain" />
            {!connected && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/40">
                <div className="text-fg-muted text-[13px]">Ожидание ответа…</div>
              </div>
            )}
          </div>
        </div>

        <div className="px-6 py-4 border-t border-border-default flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button
              onClick={toggleMic}
              className={`w-10 h-10 rounded-full flex items-center justify-center transition-colors ${micEnabled ? 'bg-accent-primary text-accent-text hover:brightness-110' : 'text-fg-muted hover:bg-bg-hover'}`}
              aria-label={micEnabled ? 'Отключить микрофон' : 'Включить микрофон'}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3Z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <line x1="12" y1="19" x2="12" y2="23" />
                <line x1="8" y1="23" x2="16" y2="23" />
              </svg>
            </button>
            <button
              onClick={toggleCam}
              className={`w-10 h-10 rounded-full flex items-center justify-center transition-colors ${camEnabled ? 'bg-accent-primary text-accent-text hover:brightness-110' : 'text-fg-muted hover:bg-bg-hover'}`}
              aria-label={camEnabled ? 'Отключить камеру' : 'Включить камеру'}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            </button>
          </div>
          <div className={`w-10 h-10 rounded-full flex items-center justify-center ${connected ? 'bg-status-success text-bg-primary' : 'text-fg-muted hover:bg-bg-hover'} transition-colors`} title={connected ? 'Соединено' : 'Подключение…'}>
            {connected ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></svg>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
