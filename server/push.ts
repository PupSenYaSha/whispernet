import { generateVAPIDKeys, setVapidDetails, sendNotification } from 'web-push';
import { getPushSubscriptions, removePushSubscription } from './database.js';

const vapidSubject = process.env.VAPID_SUBJECT || 'mailto:admin@whispernet.local';

let vapidPublicKeyString: string | null = null;
let vapidInitialized = false;

function ensureVapidInitialized(): void {
  if (vapidInitialized) return;
  vapidInitialized = true;

  const vapidPublicKey = process.env.VAPID_PUBLIC_KEY;
  const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;

  if (vapidPublicKey && vapidPrivateKey) {
    setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
    vapidPublicKeyString = vapidPublicKey;
  } else {
    // Generate ephemeral VAPID keys for development
    const generated = generateVAPIDKeys();
    setVapidDetails(vapidSubject, generated.publicKey, generated.privateKey);
    vapidPublicKeyString = generated.publicKey;
    console.log('[push] Generated ephemeral VAPID keys. Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY env vars for production.');
  }
}

export function getVapidPublicKey(): string | null {
  if (!vapidInitialized) ensureVapidInitialized();
  return vapidPublicKeyString;
}

export async function sendPush(userId: string, payload: { title: string; body: string; url?: string; icon?: string }): Promise<void> {
  if (!vapidInitialized) ensureVapidInitialized();
  if (!vapidPublicKeyString) return;

  const subs = await getPushSubscriptions(userId);
  for (const sub of subs) {
    try {
      await sendNotification(
        {
          endpoint: sub.endpoint,
          keys: {
            p256dh: sub.p256dhKey,
            auth: sub.authKey,
          }
        },
        JSON.stringify({
          title: payload.title,
          body: payload.body,
          url: payload.url || '/',
          icon: payload.icon || '/icons/icon-192.png',
          timestamp: Date.now(),
        })
      );
    } catch (e: any) {
      if (e.statusCode === 410 || e.statusCode === 404) {
        try {
          await removePushSubscription(userId, sub.deviceId || '');
        } catch { /* ignore */ }
      }
      console.error('[push] Failed to send notification:', e.message);
    }
  }
}
