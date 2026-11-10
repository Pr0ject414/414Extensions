# 414 Extensions

[![Manifest V3](https://img.shields.io/badge/Chrome%20Extension-Manifest%20V3-blue.svg)](https://developer.chrome.com/docs/extensions/mv3/)
[![Version: 1.7](https://img.shields.io/badge/Version-1.7-green.svg)](414Extensions/manifest.json)
[![React Native: 0.76](https://img.shields.io/badge/React%20Native-0.76-61DAFB.svg)](X414/package.json)
[![Expo: ~52.0](https://img.shields.io/badge/Expo-~52.0-000020.svg)](X414/package.json)
[![Tests: 42 Suites Passing](https://img.shields.io/badge/Tests-279%20Passing-brightgreen.svg)](jest.config.js)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](414Extensions/LICENSE_GPLv3_youtube_auto_hd.txt)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**414 Extensions** is a high-performance productivity, automation, and privacy engineering ecosystem designed to streamline web browsing and mobile interaction. The project consists of two core applications:

1. **414 Extensions (Chromium MV3 Extension):** A modular browser extension providing transparency badges, media enhancements, automation pipelines, and decluttering tweaks across 𝕏 (Twitter), YouTube, Epic Games Fab, Crunchyroll, Google Gemini, Google Images, and Meta Messenger.
2. **X414 (Android / Google Pixel Mobile Companion):** A native React Native / Expo companion app running an embedded, passkey-compatible 𝕏 client backed by native background Nostr sync, push notifications, and HLS/MP4 media downloaders.

All desktop modules operate under a centralized background coordinator with a global master switch, per-module toggles, customizable popup tabs, and an options dashboard.

---

## 📂 Repository Structure

```
.
├── 414Extensions/                  # Manifest V3 Chromium Extension (Chrome / Brave / Edge)
│   ├── manifest.json               # MV3 extension manifest (v1.7)
│   ├── background.js               # Service worker coordinator & action dispatcher
│   ├── x_extension/                # 𝕏 transparency, Nostr sync, ad stealth & media tools
│   ├── youtube_extension/          # YouTube Auto HD (up to 8K) & overlay removers
│   ├── video_speed_controller/     # Universal HTML5 speed controller HUD & hotkeys
│   ├── volume_controller/          # 600% Web Audio gain booster & element piercing
│   ├── fab_extension/              # Epic Games Fab auto-claim & library verification
│   ├── crunchyroll_extension/      # Crunchyroll carousel closer & speed control hider
│   ├── misc_extension/             # Gemini Markdown exporter, Google Images & Messenger tweaks
│   ├── popup/                      # Extension popup UI, quick-toggles & tab visibility
│   ├── settings/                   # Full-page options dashboard (timings, keymaps, backoff)
│   ├── shared_modules/             # Coordinator, AppState, storage utils & network helpers
│   └── tests/                      # 39 Jest unit test suites (267 tests)
│
├── X414/                           # React Native / Expo Android Companion App (Google Pixel)
│   ├── App.js                      # Root app entry, WebView host & navigation handler
│   ├── app.json                    # Expo project configuration & Android permissions
│   ├── src/
│   │   ├── bridge/                 # XHostCoordinator bidirectional native-to-web bridge
│   │   ├── services/               # BackgroundSyncTask (Nostr alarm) & VideoDownloader
│   │   ├── components/             # SettingsBottomSheet UI (Nostr identity, filters)
│   │   └── shared/                 # Bundled modules & webviewInjectedBundle.js
│   ├── scripts/sync-from-desktop.js# Single-source-of-truth build tool syncing desktop to mobile
│   ├── launch-pixel-sim.ps1        # Pixel simulator launch automation script
│   ├── x414-pixel-release.apk      # Standalone release APK for Android
│   └── tests/                      # 3 Jest test suites (12 tests)
│
├── scripts/
│   ├── pack.js                     # Production packager generating 414Extensions.zip
│   └── generate_icons.js           # Multi-resolution PNG icon generator
│
├── jest.config.js                  # Root Jest configuration (ES Modules & JSDOM)
└── package.json                    # Root npm scripts & developer dependencies
```

---

## 🚀 Features & Modules

### 1. 𝕏 (Twitter) Helper, Location Transparency & Nostr Sync
* **Account Location & Device Transparency:** Uses X's official GraphQL `AboutAccountQuery` to extract and display verified account registration country and posting platform (iOS, Android, Web/Browser).
* **Twemoji Badges & Hovercard Dossier:** Renders official Twemoji SVG country flags and device icons beside usernames across feeds, tweet threads, and user cells. Hovering over the badge opens a dossier showing country of origin, posting device, account creation date, and rest ID.
* **Dual-Tier Cache Engine:** Integrates a local LRU cache in `chrome.storage.local` (up to 2,000 entries, 60-day expiry) with an asynchronous community Cloudflare Worker cache to prevent API rate limiting.
* **Multi-Vector Feed Filtering:**
  * **Country Blocking:** Select one or more countries to automatically collapse and hide matching posts in real time.
  * **Device Region Blocking:** Block posts based on device store origin (e.g., Apple App Store / Google Play regions).
  * **Display Name Flag & Symbol Filtering:** Block posts whose author display names contain specific emoji flags or symbols.
* **Stealth Ad & Promoted Post Blocker:**
  * Intercepts timeline GraphQL network traffic (`world: "MAIN"`) to remove promoted/ad entries before DOM hydration.
  * Drops `/i/api/1.1/promoted_content/log.json` telemetry requests and Sentry error beacons.
  * Collapses any residual ad containers in the DOM seamlessly with zero empty spacing.
* **Decentralized Nostr-Based Friends Sync (E2EE):**
  * End-to-end encrypted synchronization over public Nostr relays (`wss://nos.lol`, `wss://relay.primal.net`, `wss://nostr.mom`).
  * Uses NIP-78 parameterized replaceable events, secp256k1 keys, and AES-GCM / NIP-44 encrypted payloads.
  * Private friend discovery using hashed identity derivation (`deriveInboxInfo`, `derivePairwiseInfo`).
  * **Seen by Friends Checkmarks:** Dwell-time visibility tracking (1.2 seconds at $\ge$60% viewport visibility) syncs read state across devices.
  * **Forced / Shared Posts:** Share or force specific tweets directly to friends' timelines with push notifications, read receipts, and tombstone tracking.
  * **Cross-Device Settings Sync:** Encrypted cloud/relay sync of user preferences (blocked countries, device regions, name flags, audio settings) across desktop and mobile.
* **Media Enhancements & Downloader:**
  * **Always-Mute Video Enforcement:** Forces all X videos to start muted; intercepts video body clicks to toggle play/pause rather than unmuting.
  * **Video Spacebar Control:** Spacebar play/pause scoped specifically to the focused/clicked video without triggering page scrolling.
  * **Default Media Volume Slider:** Granular volume slider (0–100%) stored across sessions.
  * **Right-Click Video & HLS Downloader:** Downloads direct MP4s or parses HLS playlists (`.m3u8`), downloads encrypted/segmented fMP4 chunks, and stitches them in browser memory into a playable MP4 file.

### 2. 📺 YouTube Helper
* **Auto HD Quality Selector:** Enforces user-selected playback resolutions up to 8K (4320p), 4K (2160p), 1440p, 1080p, 720p, and lower.
* **Enhanced Bitrate Support:** Automatically activates 1080p Premium Enhanced Bitrate and Super Resolution when available.
* **End-of-Video Suggestion Remover:** Strips intrusive recommendation cards (`.ytp-ce-element`) that clutter the final seconds of videos.
* **Live Operational Status:** Monitors YouTube player lifecycle and reports status to the extension popup.

### 3. ⚡ Video Speed Controller (VSC)
* **Universal HTML5 Playback Speed Control:** Real-time speed adjustment across all HTML5 video elements via configurable keyboard shortcuts (`s`, `d`, `r`, `g`, `z`, `x`, `v`).
* **Visual On-Screen Indicator (HUD):** Non-intrusive overlay showing current playback rate with adjustable opacity and button sizing.
* **Smart Speeds & Persistence:** Remembers playback rate per domain, provides a global fallback speed for new sites, and supports a temporary hold/override speed toggle.
* **Domain Blacklist:** Exclude specific domains or regex patterns from speed controller injection, with a quick "Add Current Domain to Blacklist" button in the popup.
* **Audio Pitch Correction:** Preserves natural audio pitch when speeding up or slowing down playback.

### 4. 🔊 Volume Booster
* **Up to 600% Audio Boost:** Amplifies tab audio up to 6x (600%) using Web Audio API `AudioContext` and `GainNode`.
* **Deep Element & Shadow DOM Piercing:** Injected into `world: "MAIN"` to intercept media elements inside shadow roots, custom Web Components, and nested iframes.
* **Domain Persistence & Presets:** Saves volume levels per domain and provides quick preset buttons (100%, 200%, 400%, 600%, Reset).

### 5. 🛒 FAB Helper (Epic Games / Unreal Engine Marketplace)
* **Catalog Decluttering:** Hides owned and claimed assets from Fab search and browse pages.
* **Auto-Open Free Promotional Assets:** Detects free promotional items (e.g., monthly sponsored content) and opens product pages in background tabs with configurable scroll-grace cycles.
* **Auto-Claim Free Licenses:** Automatically detects and claims free item licenses on product listing pages.
* **Verification Queue & Rate Limit Guard:** Verifies library ownership after tab closing, pauses with exponential backoff on HTTP 429 rate limits, and halts on verification failures.
* **Advanced Timing & Manual Queue:** Configure scan intervals, tab delays, concurrence limits, or manually inject listing URLs via the options dashboard.

### 6. 🎬 Crunchyroll Helper
* **Auto-Dismiss End-Slate Carousel:** Automatically closes full-screen recommendation carousels after an episode finishes when no unwatched episodes remain.
* **Hide Controls on Speed-Up:** Hides on-screen player controls, overlays, and mouse cursor when playback speed is above 1.0x for distraction-free viewing.

### 7. 🧩 Misc Tweaks
* **Google Gemini Deep Research Markdown Exporter:**
  * Injects a one-click "Download .md" button on message action toolbars and adds a Markdown export option to the "Share & Export" menu on `gemini.google.com`.
  * Exports formatted Gemini chats and Deep Research reports to clean Markdown, preserving tables, code blocks with language identifiers, LaTeX math formulas, nested lists, and citations while pruning UI decoration.
* **Google Images "Save" Button Overlay Hider:**
  * Hides the floating "Save" / "Saved" bookmark overlay button on Google Images preview tiles across `google.com` image searches to eliminate accidental misclicks.
* **Meta Messenger Photo Viewer Inverter:**
  * Reverses the counter-intuitive photo viewer navigation buttons and arrow keys on `messenger.com` and `facebook.com/messages` so that the right arrow advances chronologically forward (newer photo) and the left arrow goes backward.

### 8. 📱 X414 Mobile App (Android / Google Pixel)
* **Architecture:** Standalone React Native (v0.76) / Expo (v52) Android application located in `X414/`.
* **Clean Chrome User-Agent:** Spoofs a clean Google Pixel 9 Pro Chrome User-Agent (`Mozilla/5.0 (Linux; Android 15; Pixel 9 Pro)...`) without the `; wv` WebView tag, ensuring full passkey, Google OAuth, and X web authentication compatibility.
* **Bidirectional Host Bridge (`XHostCoordinator`):** Bridges native Android system capabilities with the synchronized desktop X web bundle (`webviewInjectedBundle.js`).
* **Background Sync Daemon (`BackgroundSyncTask`):** Periodically wakes via `expo-background-fetch` and `expo-task-manager` to query Nostr relays for friends' updates and forced tweets, triggering native Android push notifications (`expo-notifications`).
* **Native Media Downloader (`VideoDownloader`):** Downloads MP4 and segmented HLS streams directly to device storage, registers them with the Android Media Library (`expo-media-library`), and supports native sharing (`expo-sharing`).
* **Settings Bottom Sheet:** Native mobile UI for managing Nostr identities, friend invitations, country blocklists, device region filters, and media options.
* **Single-Source Build Synchronization:** `npm run sync-shared` runs `scripts/sync-from-desktop.js` to automatically bundle desktop crypto, API, and UI modules directly into the mobile bundle.

---

## 🛠️ Architecture & Core Principles

```
+---------------------------------------------------------------------------------------+
|                                414 EXTENSIONS ECOSYSTEM                               |
+---------------------------------------------------------------------------------------+
                                           |
         +---------------------------------+---------------------------------+
         |                                                                   |
         v                                                                   v
+-------------------------------+                         +-----------------------------+
|    Chromium MV3 Extension     |                         |     X414 Android (Pixel)    |
+-------------------------------+                         +-----------------------------+
| • Service Worker Coordinator  |                         | • Expo 52 / React Native 76 |
| • ModuleManager & AppState    |                         | • Injected WebView Bundle   |
| • Dual Execution Worlds:      |                         | • XHostCoordinator Bridge  |
|   - MAIN: Prototypes, Net     |                         | • BackgroundSyncTask Alarm  |
|   - ISOLATED: DOM, Badges     |                         | • Native Video Downloader   |
+-------------------------------+                         +-----------------------------+
         |                                                                   |
         +---------------------------------+---------------------------------+
                                           |
                                           v
                       +---------------------------------------+
                       |       Nostr Decentralized Relays      |
                       |    (wss://nos.lol, primal.net, mom)   |
                       +---------------------------------------+
                       | • NIP-78 Replaceable App Data Events  |
                       | • NIP-44 / NIP-04 E2EE Encrypted Data |
                       | • Cross-Device Seen & Forced Tweets   |
                       | • Encrypted User Preferences Sync     |
                       +---------------------------------------+
```

* **Manifest V3 Compliant:** Pure ES modules in background service workers, fine-grained alarms API, and non-blocking asynchronous message routing.
* **Dual Execution Worlds:**
  * `world: "MAIN"`: Executes in page context for prototype hijacking (Web Audio gain routing, HTMLMediaElement muted/volume property locks, and GraphQL network request filtering).
  * `world: "ISOLATED"`: Executes in secure extension context for DOM observation, Twemoji SVG injection, and direct Chrome extension API access (`chrome.storage`, `chrome.runtime`).
* **Centralized Coordinator Pattern:** Background events flow through `moduleManager.js` and `appState.js` to ensure coherent state persistence, global master switch gating, and exponential backoff handling across all modules.

---

## 📦 Installation & Setup

### Loading the Chromium Extension (Chrome / Brave / Edge)
1. Clone this repository:
   ```bash
   git clone https://github.com/Pr0ject414/414Extenstions.git
   cd 414Extenstions
   ```
2. Open your browser and navigate to `chrome://extensions/` (or `brave://extensions/`, `edge://extensions/`).
3. Enable **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked** and select the `414Extensions` directory.

### Running the Test Suites
The project includes comprehensive test suites across both the Chromium extension and the mobile application.

```bash
# Run all 39 Chromium extension test suites (267 tests)
npm test

# Run all 3 X414 mobile app test suites (12 tests)
npm --prefix X414 test
```

### Packaging for Release
To build a clean distribution archive excluding development artifacts, test files, and system files:

```bash
npm run pack
```
This executes `scripts/pack.js`, staging production files and creating a validated `414Extensions.zip` ready for deployment or sideloading.

### Running X414 Android Companion App
```bash
cd X414

# Install dependencies and sync shared modules from desktop
npm install
npm run sync-shared

# Launch on Android simulator or connected device
npm run android

# Alternatively, launch using the automated Pixel simulator script
powershell -NoProfile -ExecutionPolicy Bypass -File launch-pixel-sim.ps1
```
A pre-built standalone APK is also available at `X414/x414-pixel-release.apk`.

---

## 📜 Third-Party Attributions & Open Source Credits

This project incorporates and builds upon several outstanding open-source projects. We gratefully acknowledge and credit the original authors:

| Component / Feature | Original Project | Author / Maintainer | Upstream License | Description |
| :--- | :--- | :--- | :--- | :--- |
| **YouTube Auto HD** | [avi12/youtube-auto-hd](https://github.com/avi12/youtube-auto-hd) | Avi Levin ([@avi12](https://github.com/avi12)) | **GPL-3.0** | Automatic quality enforcement up to 8K, Enhanced Bitrate & Super Resolution logic. Full license text preserved in [LICENSE_GPLv3_youtube_auto_hd.txt](414Extensions/LICENSE_GPLv3_youtube_auto_hd.txt). |
| **X Account Location & Device Info** | [xaitax/x-account-location-device](https://github.com/xaitax/x-account-location-device) | Alexander Hagenah ([@xaitax](https://github.com/xaitax)) | **MIT** | X GraphQL `AboutAccountQuery` extraction, Cloudflare Worker cloud cache client, country flag mapping, and device badges. |
| **Video Speed Controller** | [igrigorik/videospeed](https://github.com/igrigorik/videospeed) | Ilya Grigorik ([@igrigorik](https://github.com/igrigorik)) | **MIT** | HTML5 video speed controller overlay HUD, keyboard shortcuts, rate persistence, and blacklist management. |
| **Twemoji Flag SVGs** | [twitter/twemoji](https://github.com/twitter/twemoji) | Twitter / X Open Source | **CC-BY 4.0** | Vector country flags loaded dynamically via official CDN endpoints (`abs-0.twimg.com/emoji/v2/svg/`). |
| **Noble Cryptography** | [@noble/hashes](https://github.com/paulmillr/noble-hashes) & [@noble/ciphers](https://github.com/paulmillr/noble-ciphers) | Paul Miller ([@paulmillr](https://github.com/paulmillr)) | **MIT** | Zero-dependency cryptographic primitives for secp256k1, SHA-256, and AES-GCM utilized in Nostr synchronization. |

All original modules (FAB Helper, Crunchyroll Helper, Volume Booster, Gemini Markdown Exporter, Google Images Save Hider, Messenger Photo Nav Inverter, X Ad Stealth Blocker, X Video/HLS Downloader, Nostr Friends Sync Engine, X414 Android Companion App, and the Unified Extension Coordinator) are authored by **Kyle / Pr0ject414**.

---

## ⚖️ Licensing

* The **YouTube Auto HD** component is licensed under the **GNU General Public License v3.0 (GPLv3)**. See [LICENSE_GPLv3_youtube_auto_hd.txt](414Extensions/LICENSE_GPLv3_youtube_auto_hd.txt) for the complete text.
* The **Video Speed Controller**, **X-Posed Location/Device**, and **Noble Cryptography** components are licensed under the **MIT License**.
* All original code written for the **414 Extensions & X414 Suite** is released under the **MIT License** unless otherwise required by upstream copyleft licenses.

---

## ⚠️ Disclaimer

This project is an independent open-source suite and is not affiliated with, endorsed by, or sponsored by Epic Games, Google/YouTube, X Corp. (Twitter), Crunchyroll, or Meta Platforms. All trademarks, service marks, and company names are the property of their respective owners.
