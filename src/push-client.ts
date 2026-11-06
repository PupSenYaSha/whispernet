/**
 * Push-уведомления для клиента WhisperNet.
 *
 * Подписывает устройство на веб-уведомления (Web Push API) и отправляет
 * подписку на сервер. Работает в браузере и PWA без необходимости в Apple/FCM.
 */

export async function subscribeToPush(): Promise<PushSubscription | null> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    console.warn('[push] Push API not supported in this browser');
    return null;
  }

  try {
    const registration = await navigator.serviceWorker.ready;
    const existing = await registration.pushManager.getSubscription();

    if (existing) {
      return existing;
    }

    // Получаем VAPID public key с сервера
    const vapidResponse = await fetch(`${window.location.origin}/api/vapid-public-key`);
    if (!vapidResponse.ok) {
      console.warn('[push] Cannot get VAPID public key');
      return null;
    }

    const vapidData = await vapidResponse.json();
    const vapidPublicKey = vapidPublicKeyB64ToUint8Array(vapidData.publicKey);

    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: vapidPublicKey as unknown as BufferSource,
    });

    const keys = (subscription as any).keys;
    if (!keys) {
      console.warn('[push] Subscription keys missing');
      return null;
    }

    // Отправляем подписку на сервер
    await fetch(`${window.location.origin}/api/push-subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        endpoint: subscription.endpoint,
        p256dhKey: btoa(String.fromCharCode(...new Uint8Array(keys.p256dh as ArrayBuffer))),
        authKey: btoa(String.fromCharCode(...new Uint8Array(keys.auth as ArrayBuffer))),
      }),
    });

    return subscription;
  } catch (e) {
    console.error('[push] Failed to subscribe:', e);
    return null;
  }
}

export async function unsubscribeFromPush(): Promise<void> {
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      await subscription.unsubscribe();
    }
    await fetch(`${window.location.origin}/api/push-unsubscribe`, {
      method: 'POST',
    });
  } catch (e) {
    console.error('[push] Failed to unsubscribe:', e);
  }
}

export async function getVapidPublicKey(): Promise<string | null> {
  try {
    const res = await fetch(`${window.location.origin}/api/vapid-public-key`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.publicKey || null;
  } catch {
    return null;
  }
}

function vapidPublicKeyB64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding)
    .replace(/-/g, '+')
    .replace(/_/g, '/');

  const raw = atob(base64);
  const result = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    result[i] = raw.charCodeAt(i);
  }
  return result;
}
