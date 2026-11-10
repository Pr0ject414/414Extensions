# 414 Extensions (Kyle's Chrome Extensions)

[![Manifest V3](https://img.shields.io/badge/Chrome%20Extension-Manifest%20V3-blue.svg)](https://developer.chrome.com/docs/extensions/mv3/)
[![Version: 1.7](https://img.shields.io/badge/Version-1.7-green.svg)](manifest.json)
[![Tests: 39 Suites Passing](https://img.shields.io/badge/Tests-267%20Passing-brightgreen.svg)](../jest.config.js)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE_GPLv3_youtube_auto_hd.txt)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**414 Extensions** is a modular, high-performance Chromium extension (Manifest V3) that bundles automation pipelines, interface decluttering, media enhancements, and transparency tools for everyday web browsing.

All modules operate under a centralized background coordinator with a global master switch, per-module power toggles, customizable popup tab visibility, and an advanced options dashboard.

---

## 🚀 Features & Modules

### 1. 𝕏 (Twitter) Helper, Transparency & Nostr Sync
* **Account Location & Device Transparency:** Uses X's official GraphQL `AboutAccountQuery` transparency metadata to identify account registration countries and posting platforms (iOS, Android, Web/Browser).
* **Country Flags & Platform Badges:** Injects official Twemoji SVG country flags and device icons beside usernames across tweets, threads, and user profile cells.
* **Hovercard Dossier:** Hover over the info badge next to any account to view an account dossier containing country of origin, posting device, account creation date, and raw rest ID.
* **Feed Geo-Filtering & Rules:**
  * **Country Blocking:** Select countries in the extension popup to collapse and hide matching posts in real time.
  * **Device Region Blocking:** Hide posts originating from specific device stores (Apple App Store / Google Play regions).
  * **Display Name Flag & Symbol Blocking:** Filter posts whose author display names contain specific emoji flags or symbols.
* **Stealth Ad & Promoted Content Blocker:**
  * Intercepts timeline GraphQL network traffic (`world: "MAIN"`) to remove promoted/ad entries before DOM hydration.
  * Blocks `/i/api/1.1/promoted_content/log.json` telemetry pings and Sentry error beacons.
  * Collapses residual ad containers in the DOM with zero empty spacing.
* **Dual-Tier Cache:** Combines a local LRU storage cache (`chrome.storage.local`, up to 2,000 users, 60-day expiry) with an asynchronous community Cloudflare Worker cache to avoid platform rate limits.
* **Decentralized Nostr Friends Sync (E2EE):**
  * End-to-end encrypted synchronization over Nostr relays (`wss://nos.lol`, `wss://relay.primal.net`, `wss://nostr.mom`) using NIP-78, secp256k1 keys, and AES-GCM / NIP-44 crypto.
  * **Seen by Friends Checkmarks:** Dwell-time visibility tracking (1.2 seconds at $\ge$60% viewport visibility) syncs read state across friends.
  * **Forced / Shared Posts:** Share or force specific tweets directly to friends' timelines with push notifications, read receipts, and tombstone tracking.
  * **Cross-Device Settings Sync:** Encrypted cloud/relay sync of user preferences (blocked countries, device regions, name flags, audio settings) across desktop and mobile.
* **Media Controls & Downloader:**
  * **Always-Mute Video Enforcement:** Ensures X videos always start muted; intercepts video body clicks to toggle play/pause rather than triggering X's default click-to-unmute behavior.
  * **Video Spacebar Control:** Spacebar play/pause scoped specifically to the focused/clicked video without hijacking page scrolling.
  * **Default Media Volume Slider:** Configurable default volume (0–100%) persisted across sessions.
  * **Video & HLS Stream Downloader:** Right-click videos to download direct MP4s or automatically fetch and stitch multi-fragment M3U8 (HLS fMP4) playlists into a single playable MP4 file.

### 2. 📺 YouTube Helper
* **Auto HD Quality Selector:** Automatically selects and enforces your preferred playback quality (up to 8K / 4320p, 4K / 2160p, 1440p, 1080p, 720p, etc.).
* **Enhanced Bitrate Support:** Automatically selects 1080p Premium Enhanced Bitrate and Super Resolution when available for your account.
* **End-of-Video Suggestion Remover:** Removes obstructive suggestion overlays (`.ytp-ce-element`) that appear during the final seconds of videos.
* **Live Operational Status:** Live status indicator in the popup reflects player attachment and state.

### 3. ⚡ Video Speed Controller (VSC)
* **HTML5 Playback Speed Control:** Speed up, slow down, advance, and rewind any HTML5 video using configurable keyboard shortcuts (`s`, `d`, `r`, `g`, `z`, `x`, `v`).
* **Visual On-Screen Indicator (HUD):** Real-time speed overlay HUD on video players with customizable opacity and button sizing.
* **Site Persistence & Fallbacks:** Remembers playback speeds per domain or enforces a global fallback speed for new sites. Includes hold/override speed toggle.
* **Domain Blacklist:** Exclude domains or regex patterns from speed controller injection, with a quick "Add Current Domain to Blacklist" button in the popup.
* **Audio Pitch Support:** Preserves natural audio pitch when speeding up or slowing down playback.

### 4. 🔊 Volume Booster
* **Up to 600% Audio Boost:** Boosts tab audio up to 6x (600%) using Web Audio API `AudioContext` gain nodes.
* **Shadow DOM & Dynamic Element Piercing:** Intercepts audio across shadow roots, nested iframes, and dynamic media elements via `world: "MAIN"`.
* **Per-Domain Persistence:** Automatically saves and restores custom volume levels for specific websites with preset buttons (100%, 200%, 400%, 600%, Reset).

### 5. 🛍️ FAB Helper (Epic Games / Unreal Engine Marketplace)
* **Hide Owned Items:** Automatically hides owned/claimed assets on Fab browse and search pages to reduce catalog clutter.
* **Auto-Open Free Promotional Assets:** Detects free promotional items (e.g., monthly free assets) and opens their product pages in background tabs with scroll-grace protection.
* **Auto-Claim Free Licenses:** Automatically detects and claims free licenses on product listing pages.
* **Verification Queue & Rate Limit Guard:** Verifies library ownership after tab closing, backs off automatically upon encountering rate limits (`Retry-After`), and pauses processing if verification fails.
* **Advanced Timing Dashboard:** Configure verification delays, tab delays, concurrence limits, scan intervals, and manual queue injection via the options page.

### 6. 🎬 Crunchyroll Helper
* **Auto-Close Recommendation Carousels:** Automatically closes the full-screen recommendations carousel modal after an episode ends when no unwatched episodes remain.
* **Hide Controls on Speed:** Automatically hides on-screen player controls, overlays, and mouse cursor when playing at accelerated speeds (> 1.0x) for an unobstructed viewing experience.

### 7. 🧩 Misc Tweaks
* **Google Gemini Deep Research Markdown Exporter:**
  * Adds a "Download .md" button to message toolbars and a Markdown export option to the "Share & Export" menu on `gemini.google.com`.
  * Exports formatted Gemini chats and Deep Research reports to clean Markdown, preserving tables, code blocks with language identifiers, LaTeX math formulas, nested lists, and citations while pruning UI decoration artifacts.
* **Google Images "Save" Button Overlay Hider:**
  * Hides the floating "Save" / "Saved" bookmark overlay button on Google Images preview tiles across `google.com` image searches to prevent accidental misclicks.
* **Meta Messenger Photo Viewer Inverter:**
  * Reverses the counter-intuitive photo viewer navigation buttons and arrow keys on `messenger.com` and `facebook.com/messages` so that the right button advances to the next photo and the left button goes back.

---

## 🛠️ Architecture

* **Manifest V3 Compliant:** Uses pure ES modules in background service workers, fine-grained alarms API, and isolated content scripts.
* **Dual Execution Worlds:**
  * `world: "MAIN"`: Prototype hijacking (Web Audio gain nodes, video muted/volume property locks, GraphQL request interception and telemetry blocking).
  * `world: "ISOLATED"`: Secure DOM observation, badge rendering, and Chrome extension API access (`chrome.storage`, `chrome.runtime`).
* **Modular Coordinator Pattern:** Centralized event router (`moduleManager.js`) and persistent state manager (`appState.js`) coordinates message delivery, global master switch gating, and exponential backoff across all individual feature modules.
* **Cross-Platform Compatibility:** Shares core cryptography, caching, API definitions, and filtering logic with the **X414** mobile Android companion app (`../X414`).

---

## 📦 Installation & Development

### Load in Google Chrome / Brave / Edge:
1. Clone or download this repository:
   ```bash
   git clone https://github.com/Pr0ject414/414Extenstions.git
   ```
2. Open your browser and navigate to `chrome://extensions/`.
3. Enable **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked** and select this directory (`414Extensions`).

### Running Tests:
From the project root directory:
```bash
npm test
```
*(Runs 39 Jest test suites / 267 unit tests with Node experimental VM modules enabled for ES Modules support).*

### Packaging for Release:
From the project root directory:
```bash
npm run pack
```
*(Creates `414Extensions.zip` ready for distribution).*

---

## 📜 Third-Party Attributions & Open Source Credits

This project incorporates and builds upon several outstanding open-source projects. We gratefully acknowledge and credit the original authors:

| Component / Feature | Original Project | Author / Maintainer | Upstream License | Description |
| :--- | :--- | :--- | :--- | :--- |
| **YouTube Auto HD** | [avi12/youtube-auto-hd](https://github.com/avi12/youtube-auto-hd) | Avi Levin ([@avi12](https://github.com/avi12)) | **GPL-3.0** | Automatic quality enforcement up to 8K, Enhanced Bitrate & Super Resolution logic. Full license text preserved in [LICENSE_GPLv3_youtube_auto_hd.txt](LICENSE_GPLv3_youtube_auto_hd.txt). |
| **X Account Location & Device Info** | [xaitax/x-account-location-device](https://github.com/xaitax/x-account-location-device) | Alexander Hagenah ([@xaitax](https://github.com/xaitax)) | **MIT** | X GraphQL `AboutAccountQuery` extraction, Cloudflare Worker cloud cache client, country flag mapping, and device badges. |
| **Video Speed Controller** | [igrigorik/videospeed](https://github.com/igrigorik/videospeed) | Ilya Grigorik ([@igrigorik](https://github.com/igrigorik)) | **MIT** | HTML5 video speed controller overlay HUD, keyboard shortcuts, rate persistence, and blacklist management. |
| **Twemoji Flag SVGs** | [twitter/twemoji](https://github.com/twitter/twemoji) | Twitter / X Open Source | **CC-BY 4.0** | Vector country flags loaded dynamically via official CDN endpoints (`abs-0.twimg.com/emoji/v2/svg/`). |
| **Noble Cryptography** | [@noble/hashes](https://github.com/paulmillr/noble-hashes) & [@noble/ciphers](https://github.com/paulmillr/noble-ciphers) | Paul Miller ([@paulmillr](https://github.com/paulmillr)) | **MIT** | Cryptographic primitives for secp256k1, SHA-256, and AES-GCM utilized in Nostr synchronization. |

All original modules (FAB Helper, Crunchyroll Helper, Volume Booster, Gemini Markdown Exporter, Google Images Save Hider, Messenger Photo Nav Inverter, X Ad Stealth Blocker, X Video/HLS Downloader, Nostr Friends Sync Engine, and the Unified Extension Coordinator) are authored by **Kyle / Pr0ject414**.

---

## ⚖️ Licensing

* The **YouTube Auto HD** component is licensed under the **GNU General Public License v3.0 (GPLv3)**. See [LICENSE_GPLv3_youtube_auto_hd.txt](LICENSE_GPLv3_youtube_auto_hd.txt) for the complete text.
* The **Video Speed Controller**, **X-Posed Location/Device**, and **Noble Cryptography** components are licensed under the **MIT License**.
* All original code written for this extension suite is released under the **MIT License** unless otherwise required by upstream copyleft licenses.

---

## ⚠️ Disclaimer

This extension is an independent project and is not affiliated with, endorsed by, or sponsored by Epic Games, Google/YouTube, X Corp. (Twitter), Crunchyroll, or Meta Platforms. All trademarks and brand names belong to their respective owners.
