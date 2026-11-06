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
        // The "Hey Promptly" wake word library is only published here.
        maven { url = uri("https://jitpack.io"); content { includeGroup("com.github.k2-fsa.sherpa-onnx") } }
    }
}
rootProject.name = "Promptly"
include(":app")
include(":suite")
include(":pwtestapp")
