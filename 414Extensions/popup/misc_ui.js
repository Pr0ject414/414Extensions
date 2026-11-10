// 414Extensions/popup/misc_ui.js
document.addEventListener('DOMContentLoaded', () => {
    const miscModulePowerToggle = document.getElementById('miscModulePowerToggle');
    const googleImagesHideSaveToggle = document.getElementById('googleImagesHideSaveToggle');
    const geminiMarkdownExportToggle = document.getElementById('geminiMarkdownExportToggle');
    const messengerInvertPhotoNavToggle = document.getElementById('messengerInvertPhotoNavToggle');

    const MISC_MODULE_ENABLED_KEY = 'isMiscModuleEnabled';
    const GOOGLE_IMAGES_HIDE_SAVE_KEY = 'isGoogleImagesHideSaveEnabled';
    const GEMINI_MARKDOWN_EXPORT_KEY = 'isGeminiMarkdownExportEnabled';
    const MESSENGER_INVERT_PHOTO_NAV_KEY = 'isMessengerInvertPhotoNavEnabled';

    if (miscModulePowerToggle) {
        chrome.storage.local.get([
            MISC_MODULE_ENABLED_KEY,
            GOOGLE_IMAGES_HIDE_SAVE_KEY,
            GEMINI_MARKDOWN_EXPORT_KEY,
            MESSENGER_INVERT_PHOTO_NAV_KEY
        ], (result) => {
            miscModulePowerToggle.checked = result[MISC_MODULE_ENABLED_KEY] !== false;
            if (googleImagesHideSaveToggle) {
                // Default to OFF (false) unless explicitly enabled
                googleImagesHideSaveToggle.checked = result[GOOGLE_IMAGES_HIDE_SAVE_KEY] === true;
            }
            if (geminiMarkdownExportToggle) {
                // Default to ON (true) unless explicitly disabled
                geminiMarkdownExportToggle.checked = result[GEMINI_MARKDOWN_EXPORT_KEY] !== false;
            }
            if (messengerInvertPhotoNavToggle) {
                // Default to ON (true) unless explicitly disabled
                messengerInvertPhotoNavToggle.checked = result[MESSENGER_INVERT_PHOTO_NAV_KEY] !== false;
            }
        });

        miscModulePowerToggle.addEventListener('change', () => {
            const isEnabled = miscModulePowerToggle.checked;
            chrome.storage.local.set({ [MISC_MODULE_ENABLED_KEY]: isEnabled });
            chrome.runtime.sendMessage({ action: "setMiscModuleEnabled", enabled: isEnabled });
        });

        if (googleImagesHideSaveToggle) {
            googleImagesHideSaveToggle.addEventListener('change', () => {
                const isEnabled = googleImagesHideSaveToggle.checked;
                chrome.storage.local.set({ [GOOGLE_IMAGES_HIDE_SAVE_KEY]: isEnabled });
            });
        }

        if (geminiMarkdownExportToggle) {
            geminiMarkdownExportToggle.addEventListener('change', () => {
                const isEnabled = geminiMarkdownExportToggle.checked;
                chrome.storage.local.set({ [GEMINI_MARKDOWN_EXPORT_KEY]: isEnabled });
            });
        }

        if (messengerInvertPhotoNavToggle) {
            messengerInvertPhotoNavToggle.addEventListener('change', () => {
                const isEnabled = messengerInvertPhotoNavToggle.checked;
                chrome.storage.local.set({ [MESSENGER_INVERT_PHOTO_NAV_KEY]: isEnabled });
            });
        }
    }
});
