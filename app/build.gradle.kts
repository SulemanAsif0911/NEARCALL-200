plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.nearcall.app"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.nearcall.app"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
    }

    // two apps from one engine: NearCall (numbers, calls, photos) and NearChat (BitChat-style: no accounts, public mesh room)
    flavorDimensions += "app"
    productFlavors {
        create("nearcall") {
            dimension = "app"
            applicationId = "com.nearcall.app"
        }
        create("nearchat") {
            dimension = "app"
            applicationId = "com.nearchat.app"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // signed with the debug key so the APK installs directly
            signingConfig = signingConfigs.getByName("debug")
        }
    }
    lint {
        checkReleaseBuilds = false
        abortOnError = false
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-ktx:1.9.0")
    implementation("androidx.webkit:webkit:1.11.0")
    implementation("com.google.android.gms:play-services-nearby:19.3.0")
}
