import type { CapacitorConfig } from '@capacitor/cli';

const SERVER_URL = process.env.WHISPERNET_URL || 'https://rightfully-nice-ram.cloudpub.ru';

const config: CapacitorConfig = {
  appId: 'com.whispernet.app',
  appName: 'WhisperNet',
  webDir: 'dist/client',
  server: {
    androidScheme: 'https',
    url: SERVER_URL,
    cleartext: false,
    allowNavigation: ['*'],
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
