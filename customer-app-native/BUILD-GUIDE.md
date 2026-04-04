# Family Laundry — Native App Build Guide

This guide walks you through building the Family Laundry customer app for iOS and Android using Capacitor. The native app wraps the existing customer web app in a native shell, adding push notifications, a proper app icon, and App Store/Google Play presence.

---

## Prerequisites

You'll need these installed on your Mac before starting:

1. **Node.js 20+** — you likely already have this. Check with: `node --version`
2. **Xcode 16+** — download from the Mac App Store (free, ~12 GB)
3. **Android Studio** — download from https://developer.android.com/studio (free)
4. **CocoaPods** — install with: `sudo gem install cocoapods`

---

## First-Time Setup (do this once)

Open Terminal, then run these commands:

```bash
# Navigate to the native app project
cd ~/Projects/WashRoute/customer-app-native

# Install JavaScript dependencies
npm install

# Generate app icons from your existing logo
npm install sharp --save-dev
node scripts/generate-icons.js

# Copy web assets into the native project
npm run build

# Add the iOS and Android platforms
npx cap add ios
npx cap add android

# Sync everything
npx cap sync
```

After `cap add ios`, Capacitor creates an `ios/` folder with a full Xcode project.
After `cap add android`, it creates an `android/` folder with a full Android Studio project.

---

## Building for iOS (iPhone / App Store)

### Test on Simulator

```bash
cd ~/Projects/WashRoute/customer-app-native
npm run sync:ios       # copies latest web app into the iOS project
npx cap open ios       # opens Xcode
```

In Xcode:
1. Select a simulator (e.g., "iPhone 16") from the device dropdown at the top
2. Click the ▶ Play button
3. The app will build and launch in the simulator

### Test on Your Physical iPhone

1. Connect your iPhone via USB
2. In Xcode, select your iPhone from the device dropdown
3. You may need to trust your developer certificate on the phone:
   Settings → General → VPN & Device Management → trust your Apple ID
4. Click ▶ Play

### Submit to the App Store

1. In Xcode: Product → Archive
2. Once the archive builds, the Organizer window opens
3. Click "Distribute App" → "App Store Connect"
4. Follow the prompts (signing, upload)
5. Go to https://appstoreconnect.apple.com to complete the listing:
   - Screenshots (at least iPhone 6.7" and 6.1")
   - App description, keywords, category (Lifestyle)
   - Privacy policy URL (required)
   - Age rating
6. Submit for review (typically 1-3 days)

### Xcode Signing Setup (first time only)

1. Open Xcode → Preferences → Accounts → add your Apple ID
2. In the project navigator, click the "App" target
3. Go to "Signing & Capabilities" tab
4. Check "Automatically manage signing"
5. Select your Team (your Apple Developer account)
6. Set Bundle Identifier to: `com.familylaundry.app`
7. Add the "Push Notifications" capability (click + Capability)

---

## Building for Android (Google Play)

### Test on Emulator

```bash
cd ~/Projects/WashRoute/customer-app-native
npm run sync:android   # copies latest web app into the Android project
npx cap open android   # opens Android Studio
```

In Android Studio:
1. Wait for Gradle sync to complete (first time takes a few minutes)
2. Select a virtual device from the dropdown (or create one via Device Manager)
3. Click the ▶ Run button

### Submit to Google Play

1. In Android Studio: Build → Generate Signed Bundle / APK
2. Choose "Android App Bundle" (AAB)
3. Create or select a keystore (keep this file safe — you need it for every update)
4. Build the release AAB
5. Go to https://play.google.com/console
6. Create a new app, fill in the listing details
7. Upload the AAB to "Production" track
8. Submit for review (typically 1-2 days, faster than Apple)

---

## Updating the App

### Routine updates (web code changes only)

When you make changes to `customer-app/index.html` and push to Vercel:

```bash
cd ~/Projects/WashRoute/customer-app-native
npm run sync        # copies latest web code + syncs to both platforms
npx cap open ios    # or open:android
```

Then rebuild and resubmit. For iOS: Product → Archive → Distribute.
For Android: Build → Generate Signed Bundle.

**Note:** Most of your updates are web code changes. In the future, we can add Capgo (a live-update service) so these changes push to users instantly without going through app store review. That's a phase 2 optimization.

### Native plugin changes

If you add new Capacitor plugins (e.g., camera, geolocation), you must:
1. `npm install @capacitor/camera`
2. `npx cap sync`
3. Rebuild and resubmit to both stores

---

## Project Structure

```
customer-app-native/
├── package.json              ← dependencies + scripts
├── capacitor.config.json     ← Capacitor configuration
├── .gitignore
├── BUILD-GUIDE.md            ← this file
├── scripts/
│   ├── copy-web-assets.js    ← copies customer-app into www/
│   ├── native-bridge.js      ← push notifications, deep links, etc.
│   └── generate-icons.js     ← creates all icon sizes from source
├── www/                      ← (generated) web assets for native app
├── resources/                ← (generated) app icons + splash screen
├── ios/                      ← (generated) Xcode project
└── android/                  ← (generated) Android Studio project
```

The `www/`, `resources/`, `ios/`, and `android/` folders are all generated —
don't edit them directly. Edit the source files and re-sync.

---

## App Store Checklist

Before your first submission, you'll need:

- [ ] **App name:** Family Laundry
- [ ] **Bundle ID:** com.familylaundry.app
- [ ] **App icon:** generated from your existing logo (run generate-icons.js)
- [ ] **Screenshots:** at least 2 sizes for iPhone, 1 for iPad (optional)
- [ ] **App description:** short and long descriptions
- [ ] **Keywords:** laundry, pickup, delivery, wash, fold, dry cleaning
- [ ] **Category:** Lifestyle
- [ ] **Privacy policy URL:** required by both Apple and Google
- [ ] **Support URL:** your website or a contact page
- [ ] **Age rating:** 4+ (no objectionable content)

---

## Troubleshooting

**"No provisioning profile" error in Xcode:**
Make sure Signing & Capabilities has your team selected and "Automatically manage signing" is checked.

**Android Gradle sync fails:**
Try: File → Invalidate Caches → Restart. If still broken, delete `android/.gradle/` and re-sync.

**App rejected by Apple for "minimum functionality":**
This is why we include push notifications, native status bar, and keyboard handling. If still rejected, we can add offline order caching or camera features.

**Web content looks wrong in the app:**
Run `npm run sync` to re-copy the latest web assets, then rebuild.
