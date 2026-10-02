import type { CapacitorConfig } from '@capacitor/cli';

const SERVER_URL = process.env.WHISPERNET_URL || 'https://rightfully-nice-ram.cloudpub.ru';

// the shell loads the app from the server, so the WebView is allowed to go there and nowhere else:
// a wildcard would let a link inside a message navigate the app shell to any host it liked
const allowedHost = new URL(SERVER_URL).host;

const config: CapacitorConfig = {
  appId: 'com.whispernet.app',
  appName: 'WhisperNet',
  webDir: 'dist/client',
  server: {
    androidScheme: 'https',
    url: SERVER_URL,
    cleartext: false,
    allowNavigation: [allowedHost],
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: true,
      backgroundColor: '#0c0a14',
      showSpinner: false,
    },
  },
};

export default config;
