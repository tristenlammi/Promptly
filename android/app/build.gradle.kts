import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

// Release signing: a keystore kept OUTSIDE the repo. build-release.ps1 points
// here with -Psigning=<path to keystore.properties>; debug builds don't need it.
val signingProps: Properties? = (findProperty("signing") as String?)?.let { path ->
    Properties().apply { file(path).inputStream().use { load(it) } }
}

android {
    testOptions {
        unitTests.isIncludeAndroidResources = true
        unitTests.all {
            it.systemProperty("pw.stack", System.getProperty("pw.stack") ?: "")
            it.systemProperty("pw.frontend", rootDir.resolve("../frontend").absolutePath)
            it.maxHeapSize = "1g"
        }
    }
    namespace = "org.promptly.sync"
    compileSdk = 37

    defaultConfig {
        // The one Promptly Android app: the home-screen launchers (:suite) plus
        // photo backup (this module, which grew out of PromptlySync — hence
        // the org.promptly.sync code namespace).
        applicationId = "org.promptly.app"
        // 29: the car screen's navigation library needs it.
        minSdk = 29
        targetSdk = 37
        versionCode = 18
        versionName = "1.5.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        if (signingProps != null) {
            create("release") {
                storeFile = file(signingProps.getProperty("storeFile"))
                storePassword = signingProps.getProperty("storePassword")
                keyAlias = signingProps.getProperty("keyAlias")
                keyPassword = signingProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        // The navigation engine is native code. Phones are arm64; x86_64 is only
        // for the emulator, and would add a lot to the download.
        debug {
            ndk { abiFilters += listOf("arm64-v8a", "x86_64") }
        }
        release {
            // -PemulatorAbi: to try a release build on the emulator.
            ndk { abiFilters += if (hasProperty("emulatorAbi")) listOf("arm64-v8a", "x86_64") else listOf("arm64-v8a") }
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (signingProps != null) signingConfig = signingConfigs.getByName("release")
        }
    }

    packaging {
        jniLibs {
            // Compressed, for a smaller download from your server.
            useLegacyPackaging = true
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
        // The navigation libraries use newer java.time on older phones.
        isCoreLibraryDesugaringEnabled = true
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }
}

// The vault's data files are shared with the web client, not forked: copied from
// frontend/src/passwords/core into the APK's assets at build time.
abstract class CopyPasswordAssets : DefaultTask() {
    @get:InputFiles abstract val sources: ConfigurableFileCollection
    @get:OutputDirectory abstract val output: DirectoryProperty

    @TaskAction
    fun copy() {
        val dir = output.get().asFile.resolve("passwords")
        dir.mkdirs()
        sources.files.forEach { it.copyTo(dir.resolve(it.name), overwrite = true) }
    }
}

val passwordCore = rootDir.resolve("../frontend/src/passwords/core")
val copyPasswordAssets = tasks.register<CopyPasswordAssets>("copyPasswordAssets") {
    sources.from(
        passwordCore.resolve("eff_large_wordlist.json"),
        passwordCore.resolve("data/password-rules.json"),
        passwordCore.resolve("data/shared-credentials.json"),
    )
    output.set(layout.buildDirectory.dir("generated/passwordAssets"))
}
val copyPasswordVectors = tasks.register<CopyPasswordAssets>("copyPasswordVectors") {
    sources.from(passwordCore.resolve("vectors.json"))
    output.set(layout.buildDirectory.dir("generated/passwordVectors"))
}
androidComponents {
    onVariants { variant ->
        variant.sources.assets?.addGeneratedSourceDirectory(copyPasswordAssets, CopyPasswordAssets::output)
        // The same shared vectors, read on the device itself by the instrumented tests.
        variant.androidTest?.sources?.assets?.addGeneratedSourceDirectory(copyPasswordVectors, CopyPasswordAssets::output)
    }
}

// The instrumented tests drive this app too: `gradlew :app:connectedDebugAndroidTest`.
tasks.matching { it.name == "connectedDebugAndroidTest" }.configureEach {
    dependsOn(":pwtestapp:installPlainDebug", ":pwtestapp:installBrowserDebug")
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2026.09.00")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.core:core-ktx:1.19.1")
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.11.0")
    implementation("androidx.work:work-runtime-ktx:2.12.0")
    implementation("com.google.android.gms:play-services-code-scanner:16.1.0")
    implementation("com.squareup.okhttp3:okhttp:5.5.0")
    implementation(project(":suite"))
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.5")

    // Passwords: see passwords/ANDROID_NOTES.md. BouncyCastle for X25519, Ed25519,
    // HKDF and the Argon2 fallback; argon2kt (JNI) for the unlock's Argon2id.
    implementation("org.bouncycastle:bcprov-jdk18on:1.86")
    implementation("com.lambdapioneer.argon2kt:argon2kt:1.6.0")
    implementation("androidx.biometric:biometric:1.1.0")
    implementation("androidx.fragment:fragment-ktx:1.8.9")
    implementation("androidx.credentials:credentials:1.6.0")
    implementation("androidx.autofill:autofill:1.3.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.11.0")
    implementation("com.google.android.gms:play-services-auth-api-phone:18.3.1")
    // Drawing QR codes on screen (a joining device, Wi-Fi). Scanning stays with ML Kit.
    implementation("com.google.zxing:core:3.5.3")

    // P Maps' driving screen and Android Auto (see the maps package). Android's
    // own GPS: Ferrostar's google-play-services module is deliberately left out.
    val ferrostar = "0.59.0"
    implementation("com.stadiamaps.ferrostar:core:$ferrostar")
    implementation("com.stadiamaps.ferrostar:ui-compose:$ferrostar")
    implementation("com.stadiamaps.ferrostar:ui-formatters:$ferrostar")
    implementation("com.stadiamaps.ferrostar:ui-maplibre:$ferrostar")
    implementation("com.stadiamaps.ferrostar:car-app:$ferrostar")
    implementation("com.stadiamaps.ferrostar:ui-maplibre-car-app:$ferrostar")
    implementation("org.maplibre.compose:maplibre-compose-android:0.13.0")
    implementation("androidx.car.app:app:1.7.0")
    implementation("io.github.rallista:car-app-compose:0.0.2")

    // The car's rules are checked when a template is built, so build them in a test.
    testImplementation("junit:junit:4.13.2")
    testImplementation("androidx.test:core:1.7.0")
    testImplementation("org.robolectric:robolectric:4.16")
    testImplementation("androidx.car.app:app-testing:1.7.0")

    // Instrumented tests on the emulator, driving the real system services.
    androidTestImplementation("androidx.test:runner:1.7.0")
    androidTestImplementation("androidx.test:rules:1.7.0")
    androidTestImplementation("androidx.test:core:1.7.0")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    androidTestImplementation("androidx.test.uiautomator:uiautomator:2.3.0")
}
