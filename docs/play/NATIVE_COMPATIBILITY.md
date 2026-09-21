# Native Code / 64-bit / 16 KB Page-Size Compatibility — ParkCast Player

**App:** `com.parkcast.player` v1.3 (versionCode 5) · minSdk 22 · targetSdk 36 · compileSdk 36
**Audit date:** 2026-09-21
**Requirements assessed:** Google Play 64-bit requirement, and the 16 KB memory-page-size compatibility requirement that applies to apps targeting Android 15+ (and therefore to this targetSdk 36 app) on 16 KB-page devices.

## 1. Verification performed (evidence, not assertion)

Three independent checks, all run against the working tree and the actual release artifacts on 2026-09-21:

1. **Source tree scan.** `find android-player -name "*.so" -o -name jniLibs -type d` → **zero results.** `app/src/main` contains exactly: `AndroidManifest.xml`, `java/com/parkcast/player/{MainActivity.kt,BootReceiver.kt}`, `res/values/{strings.xml,themes.xml}`, `res/drawable/{banner.png,icon.png}`. No `jniLibs/`, no CMake/ndk-build config anywhere in the module, no `ndkVersion`/`externalNativeBuild`/`abiFilters` in `app/build.gradle.kts` (read in full — lines 1–59).
2. **Release APK inspection.** `unzip -l app/build/outputs/apk/release/app-release.apk | grep -E '\.so|lib/'` → **no matches** across all **439 entries**. The APK contains no `lib/` directory and no ELF objects of any ABI.
3. **Release AAB inspection.** Same grep on `app/build/outputs/bundle/release/app-release.aab` → **no matches.** Play cannot derive a native-code split from this bundle because none exists.

## 2. Full resolved dependency graph (from the release lint model, `app/build/intermediates/lint_vital_report_lint_model/release/generateReleaseLintVitalReportModel/release-artifact-dependencies.xml`)

Declared directly (`app/build.gradle.kts:56-59`): `androidx.appcompat:appcompat:1.7.0`, `androidx.webkit:webkit:1.11.0`.

Resolved transitively (complete list):

```
androidx.activity:activity:1.7.0                     androidx.lifecycle:lifecycle-viewmodel:2.6.2
androidx.annotation:annotation-experimental:1.4.0    androidx.lifecycle:lifecycle-viewmodel-savedstate:2.6.2
androidx.annotation:annotation-jvm:1.6.0             androidx.loader:loader:1.0.0
androidx.appcompat:appcompat:1.7.0                   androidx.profileinstaller:profileinstaller:1.3.1
androidx.appcompat:appcompat-resources:1.7.0         androidx.resourceinspection:resourceinspection-annotation:1.0.1
androidx.arch.core:core-common:2.2.0                 androidx.savedstate:savedstate:1.2.1
androidx.arch.core:core-runtime:2.2.0                androidx.startup:startup-runtime:1.1.1
androidx.collection:collection:1.1.0                 androidx.tracing:tracing:1.0.0
androidx.concurrent:concurrent-futures:1.1.0         androidx.vectordrawable:vectordrawable:1.1.0
androidx.core:core:1.13.0                            androidx.vectordrawable:vectordrawable-animated:1.1.0
androidx.core:core-ktx:1.13.0                        androidx.versionedparcelable:versionedparcelable:1.1.1
androidx.cursoradapter:cursoradapter:1.0.0           androidx.viewpager:viewpager:1.0.0
androidx.customview:customview:1.0.0                 androidx.webkit:webkit:1.11.0
androidx.drawerlayout:drawerlayout:1.0.0             com.google.guava:listenablefuture:1.0  (empty stub jar)
androidx.emoji2:emoji2:1.3.0                         org.jetbrains:annotations:13.0
androidx.emoji2:emoji2-views-helper:1.3.0            org.jetbrains.kotlin:kotlin-stdlib:2.0.20
androidx.fragment:fragment:1.5.4                     org.jetbrains.kotlin:kotlin-stdlib-jdk7:1.8.0
androidx.interpolator:interpolator:1.0.0             org.jetbrains.kotlin:kotlin-stdlib-jdk8:1.8.0
androidx.lifecycle:lifecycle-common:2.6.2            org.jetbrains.kotlinx:kotlinx-coroutines-android:1.6.4
androidx.lifecycle:lifecycle-livedata:2.6.2          org.jetbrains.kotlinx:kotlinx-coroutines-core-jvm:1.6.4
androidx.lifecycle:lifecycle-livedata-core:2.6.2
androidx.lifecycle:lifecycle-process:2.6.2
androidx.lifecycle:lifecycle-runtime:2.6.2
```

Every artifact is JVM bytecode (`@jar`) or an Android library (`@aar`) that ships Dalvik-targeted classes and resources only — none of these androidx/Kotlin artifacts contains native code, which check §1.2/§1.3 proves empirically for this exact build: the packaged output has **zero** `.so` files.

## 3. Conclusions

| Requirement | Verdict | Basis |
|---|---|---|
| **Play 64-bit requirement** | **COMPLIANT (by construction).** | An app with no native libraries is 64-bit compatible by definition: all code is DEX executed by ART, which is 64-bit on every 64-bit device. Play's 64-bit check only inspects `lib/` ABI folders; there are none. |
| **16 KB page-size requirement (targetSdk 35+ era, in force for this targetSdk 36 app)** | **COMPLIANT (by construction).** | The 16 KB requirement concerns ELF objects: native libraries must be built with 16 KB-aligned load segments, and the APK must zip-align `.so` files accordingly. With zero ELF objects in APK and AAB, there is nothing to align; pure-Kotlin/Java apps are automatically 16 KB-page-size compatible. The system WebView the app renders through is platform-provided and is the device vendor's compliance responsibility, not this app's. |
| **`extractNativeLibs="true"` in the merged manifest** | Harmless no-op. | Injected by AGP because minSdk 22 < 23 (`merged_manifest/.../AndroidManifest.xml`, application attribute). With no native libs there is nothing to extract; no size or compatibility effect. No action. |

## 4. Guardrail for future changes

This compliance is a property of the current dependency set, not a permanent fact. It is lost the moment any dependency shipping native code is added (typical offenders: ExoPlayer/media3 extensions with codecs, sqlite/room-bundled-sqlite, Firebase/Play-services with native components, image codecs, crash reporters with NDK handlers, `androidx.webkit` staying safe but a switch to GeckoView not). **Before adding any new dependency:** run `unzip -l app-release.apk | grep '\.so$'` after the build; if any `.so` appears, verify (a) `arm64-v8a` (and `x86_64` if x86 is shipped) folders exist alongside any 32-bit ones, and (b) each `.so` passes 16 KB alignment (`llvm-readelf -l` LOAD segments aligned to 0x4000, or the `check_elf_alignment.sh` script from the Android NDK docs), then update this document.
