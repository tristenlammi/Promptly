# OkHttp / Okio ship their own consumer rules.

# ML Kit (the QR scanner) finds its parts by name — classes listed in the
# manifest, made with their no-argument constructor. R8 dropped those
# constructors, so GmsBarcodeScanning.getClient crashed on a null.
-keep class * implements com.google.firebase.components.ComponentRegistrar { <init>(); }
-keep class com.google.mlkit.common.internal.** { <init>(...); }
-keep class com.google.mlkit.vision.common.internal.** { <init>(...); }
