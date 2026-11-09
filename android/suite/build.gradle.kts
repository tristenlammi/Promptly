plugins {
    id("com.android.library")
}

// The Promptly app's home-screen launchers — a Trusted Web Activity (the
// Promptly website full screen in Chrome) per app: Promptly, P Photos,
// P Rooms, P Workout… Built into the one Promptly Android app (:app, which
// also holds photo backup). Launchers, icons and the manifest are generated
// by ../gen_suite.py; the picker turns each icon on or off on the phone.
// The server's /.well-known/assetlinks.json names org.promptly.app and the
// signing key, or Chrome shows a URL bar.
android {
    namespace = "org.promptly.app"
    compileSdk = 37

    defaultConfig {
        minSdk = 29
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    api("com.google.androidbrowserhelper:androidbrowserhelper:2.7.4")
    api("com.google.androidbrowserhelper:locationdelegation:1.1.2")
    // JVM checks of what gen_suite.py writes (the Porch share target, WP-P1.7).
    testImplementation("junit:junit:4.13.2")
}
