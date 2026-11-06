plugins {
    id("com.android.application")
}

// A small test app for the Passwords instrumented tests: never shipped. Two copies, so the
// tests can see both sides of the browser rule: `plain` is any old app with a WebView, whose
// claimed web domain isn't believed; `browser` stands in for a browser on the allowlist
// (a debug-only hook in :app's src/debug, absent from release builds).
android {
    namespace = "org.promptly.pwtest"
    compileSdk = 37

    defaultConfig {
        minSdk = 29
        targetSdk = 37
        versionCode = 1
        versionName = "1.0"
    }

    flavorDimensions += "role"
    productFlavors {
        create("plain") {
            dimension = "role"
            applicationId = "org.promptly.pwtest"
        }
        create("browser") {
            dimension = "role"
            applicationId = "org.promptly.pwtest.browser"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation("androidx.credentials:credentials:1.6.0")
    implementation("androidx.core:core:1.19.1")
}

// Debug only: `gradlew assembleRelease` (what build-release.ps1 runs) shouldn't build this.
androidComponents {
    beforeVariants(selector().withBuildType("release")) { it.enable = false }
}
