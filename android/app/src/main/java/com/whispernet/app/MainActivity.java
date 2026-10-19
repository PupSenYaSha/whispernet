package com.whispernet.app;

import android.os.Bundle;
import android.view.WindowManager;
import android.webkit.WebSettings;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);

        // File and content URIs are switched off, which Capacitor does not do for us.
        //
        // `Bridge.initWebView` sets JavaScript, DOM storage, geolocation and mixed content, and leaves both
        // of these at the platform default of `true`. The page origin here is a remote https host, so this
        // is not exploitable on its own - it would take script execution in the page first. But this app
        // already sets FLAG_SECURE and `allowBackup="false"` because the WebView's storage holds an
        // identity key and a cache of decrypted messages, so leaving the two settings that would let a
        // compromised page read `file://` and `content://` is an inconsistency rather than a decision.
        // The build needs none of it: everything the app loads is over https.
        WebSettings settings = getBridge().getWebView().getSettings();
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
    }
}
