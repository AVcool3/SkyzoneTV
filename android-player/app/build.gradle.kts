import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Release signing: keystore/upload.jks + keystore.properties live ONLY on
// the build machine (gitignored — never commit them). Play App Signing
// escrows the app key, so a lost/compromised upload key is reset through
// Play Console -> Setup -> App signing; see docs/STORE-PUBLISHING.md.
val keystoreProps = Properties().apply {
    val f = rootProject.file("keystore/keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

android {
    namespace = "com.parkcast.player"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.parkcast.player"
        minSdk = 22          // Fire TV Stick (2nd gen+) and all Google TV devices
        targetSdk = 36       // current Google Play target requirement
        versionCode = 6
        versionName = "1.3.1"
        // Fresh installs connect here automatically — no setup screen. The
        // MENU (☰) remote button still opens the address dialog to override
        // it (demos, migrations, a different venue's server).
        buildConfigField("String", "DEFAULT_SERVER_URL", "\"https://parkcast.onrender.com\"")
    }

    buildFeatures { buildConfig = true }

    signingConfigs {
        create("release") {
            storeFile = rootProject.file(keystoreProps.getProperty("storeFile", "keystore/upload.jks"))
            storePassword = keystoreProps.getProperty("storePassword", "")
            keyAlias = keystoreProps.getProperty("keyAlias", "parkcast")
            keyPassword = keystoreProps.getProperty("keyPassword", "")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.webkit:webkit:1.11.0")
}
