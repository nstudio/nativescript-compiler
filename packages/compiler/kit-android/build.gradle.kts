plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "org.nativescript.kit"
    compileSdk = 36

    defaultConfig {
        minSdk = 24
        consumerProguardFiles("consumer-rules.pro")
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) }
}

// -PnativescriptKitStrict (CI): a warning in the kit fails its build, and lint checks its thread annotations
// (@UiThread on the main-thread-only modules, threading.ts) against the Android APIs' own.
if (providers.gradleProperty("nativescriptKitStrict").isPresent) {
    kotlin { compilerOptions { allWarningsAsErrors.set(true) } }
    android.lint {
        checkOnly += setOf("WrongThread", "WrongThreadInterprocedural")
        abortOnError = true
    }
}

// generated/kotlin: the kit generated from core (tools/kit/generate-android.mts), on the runtime and the hand-written files
// under src/main that the generated code calls (modules.mts' counterparts).
// src/fromcore: what compiled apps call (the code generator's vocabulary) over the generated classes, as kit-apple's CoreBridge.swift.
android.sourceSets["main"].java.srcDir("generated/kotlin")
android.sourceSets["main"].java.srcDir("src/fromcore/kotlin")
// -PkitOverlay: an app's overlay (the compiler's kit-overlay.ts), whose files stand in for the generated ones -PkitOverlayReplaces names.
val overlay = providers.gradleProperty("kitOverlay").orNull
val replaced = providers.gradleProperty("kitOverlayReplaces").orNull?.split(",")?.toSet() ?: emptySet()
val generatedDir = file("generated/kotlin/org/nativescript/kit")
if (overlay != null) android.sourceSets["main"].java.srcDir("$overlay/kotlin")
tasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile>().configureEach {
    exclude { !it.isDirectory && it.file.parentFile == generatedDir && it.file.name in replaced }
}

// -PkitAdapterSources: the Kotlin of the app's framework adapter (folders, comma-separated), compiled into the kit
// because it uses the kit's internal members.
providers.gradleProperty("kitAdapterSources").orNull?.split(",")?.forEach { android.sourceSets["main"].java.srcDir(it) }

// The app's own @nativescript/core widgets AAR: the layout code NativeScript runs on Android.
val widgetsAar: String = providers.gradleProperty("nativescriptWidgetsAar").get()

// The AndroidX versions a NativeScript 9.1 release build resolves, so shared widgets look the same.
dependencies {
    api(files(widgetsAar))
    api("androidx.appcompat:appcompat:1.7.0")
    api("androidx.activity:activity:1.8.1")
    api("androidx.fragment:fragment:1.8.5")
    api("androidx.core:core:1.13.0")
    implementation("androidx.transition:transition:1.5.1")
    implementation("androidx.exifinterface:exifinterface:1.3.7")
}
