pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
        // The "Hey Promptly" wake word library is only published here; so is the
        // LiveKit SDK's audio routing (Twilio AudioSwitch, Apache-2.0, a pinned commit).
        maven { url = uri("https://jitpack.io"); content { includeGroup("com.github.k2-fsa.sherpa-onnx"); includeGroup("com.github.davidliu") } }
    }
}
rootProject.name = "Promptly"
include(":app")
include(":suite")
include(":pwtestapp")
