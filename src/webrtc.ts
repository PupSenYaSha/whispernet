/**
 * WebRTC helpers for WhisperNet voice/video calls.
 *
 * Uses free public STUN servers (Google). No TURN server is self-hosted here
 * because the project runs on free infrastructure only; calls work on the same
 * network or when at least one side has a public IP. For production behind
 * symmetric NAT a self-hosted Coturn TURN can be added later.
 */

export const STUN_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun4.l.google.com:19302' },
];

/** Builds an RTCPeerConnection with the free STUN pool. */
export function createPeerConnection(config?: RTCConfiguration): RTCPeerConnection {
  return new RTCPeerConnection({
    iceServers: config?.iceServers ?? STUN_SERVERS,
    iceTransportPolicy: config?.iceTransportPolicy ?? 'all',
    bundlePolicy: config?.bundlePolicy ?? 'balanced',
    rtcpMuxPolicy: config?.rtcpMuxPolicy ?? 'require',
  });
}

/** Constraints offered to the remote side when starting a call. */
export const OFFER_CONSTRAINTS: RTCOfferOptions = {
  offerToReceiveAudio: true,
  offerToReceiveVideo: true,
};

/** Constraints for an answer. */
export const ANSWER_CONSTRAINTS: RTCAnswerOptions = {};
