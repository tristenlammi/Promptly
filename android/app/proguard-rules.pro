# OkHttp / Okio ship their own consumer rules.

# ML Kit (the QR scanner) finds its parts by name — classes listed in the
# manifest, made with their no-argument constructor. R8 dropped those
# constructors, so GmsBarcodeScanning.getClient crashed on a null.
-keep class * implements com.google.firebase.components.ComponentRegistrar { <init>(); }
-keep class com.google.mlkit.common.internal.** { <init>(...); }
-keep class com.google.mlkit.vision.common.internal.** { <init>(...); }

# The navigation engine's Rust bindings are found by name (JNA), and the car
# library builds its templates by reflection.
-keep class uniffi.ferrostar.** { *; }
-keep class com.sun.jna.** { *; }
-keepclassmembers class * extends com.sun.jna.** { public *; }
-keep class androidx.car.app.** { *; }
-keep class org.maplibre.android.** { *; }
-dontwarn java.awt.**

# Passwords. argon2kt's JNI finds its result class and fields by name. BouncyCastle
# lists optional JCA and LDAP classes this app never uses (only its lightweight API).
-keep class com.lambdapioneer.argon2kt.** { *; }
-dontwarn org.bouncycastle.**
-dontwarn javax.naming.**
