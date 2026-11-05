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
        versionCode = 15
        versionName = "1.4.2"
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
}
