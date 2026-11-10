// KylesChromeExtensions/misc_extension/content_scripts/messengerPhotoNavInverter.js
(function () {
    'use strict';

    if (typeof window.__ext414MessengerPhotoNavCleanup === 'function') {
        window.__ext414MessengerPhotoNavCleanup();
    }

    const GLOBAL_MASTER_SWITCH_ENABLED_KEY = 'isGlobalMasterSwitchEnabled';
    const MISC_MODULE_ENABLED_KEY = 'isMiscModuleEnabled';
    const MESSENGER_INVERT_PHOTO_NAV_KEY = 'isMessengerInvertPhotoNavEnabled';

    const ROOT_ACTIVE_CLASS = 'ext414-invert-messenger-photo-nav';
    const ROW_INVERT_CLASS = 'ext414-messenger-photo-nav-row';

    const NAV_BUTTON_SELECTOR = [
        '[role="button"][aria-label="Previous photo"]',
        '[role="button"][aria-label="Next photo"]',
        '[role="button"][aria-label="Previous media"]',
        '[role="button"][aria-label="Next media"]'
    ].join(', ');

    const swappedKeyboardEvents = new WeakSet();
    let isFeatureActive = false;
    let observer = null;
    let keydownAttached = false;

    function isMessengerViewerContext(rowEl) {
        const host = (window.location.hostname || '').toLowerCase();
        const pathname = window.location.pathname || '';

        if (host === 'messenger.com' || host.endsWith('.messenger.com')) {
            return true;
        }

        if (host === 'facebook.com' || host.endsWith('.facebook.com')) {
            // Do not invert standard Facebook post/profile photo albums (already normal left-to-right order)
            if (pathname.startsWith('/photo') || /\/photos(\/|$)/.test(pathname)) {
                return false;
            }
            if (pathname.startsWith('/messages')) {
                return true;
            }
            if (rowEl && typeof rowEl.querySelector === 'function' && rowEl.querySelector('img[src^="blob:"]')) {
                return true;
            }
            return false;
        }

        return false;
    }

    function findViewerRow(btn) {
        if (!btn || !(btn instanceof Element)) return null;

        let branch = btn;
        let parent = btn.parentElement;
        let depth = 0;

        while (parent && parent !== document.body && parent !== document.documentElement && depth < 6) {
            const children = parent.children;
            if (children.length >= 2) {
                for (let i = 0; i < children.length; i++) {
                    const sibling = children[i];
                    if (sibling === branch) continue;
                    if (
                        sibling.matches('img, video') ||
                        sibling.querySelector('img, video') ||
                        sibling.matches(NAV_BUTTON_SELECTOR) ||
                        sibling.querySelector(NAV_BUTTON_SELECTOR)
                    ) {
                        return parent;
                    }
                }
            }
            branch = parent;
            parent = parent.parentElement;
            depth++;
        }

        return null;
    }

    function clearInvertedRows() {
        const existingRows = document.querySelectorAll(`.${ROW_INVERT_CLASS}`);
        existingRows.forEach((row) => {
            row.classList.remove(ROW_INVERT_CLASS);
        });
    }

    function syncViewerRows() {
        if (!isFeatureActive) {
            if (document.documentElement) {
                document.documentElement.classList.remove(ROOT_ACTIVE_CLASS);
            }
            clearInvertedRows();
            return;
        }

        if (document.documentElement) {
            document.documentElement.classList.add(ROOT_ACTIVE_CLASS);
        }

        const validRows = new Set();
        const buttons = document.querySelectorAll(NAV_BUTTON_SELECTOR);
        buttons.forEach((btn) => {
            const row = findViewerRow(btn);
            if (row && isMessengerViewerContext(row)) {
                validRows.add(row);
                row.classList.add(ROW_INVERT_CLASS);
            }
        });

        const existingRows = document.querySelectorAll(`.${ROW_INVERT_CLASS}`);
        existingRows.forEach((row) => {
            if (!validRows.has(row)) {
                row.classList.remove(ROW_INVERT_CLASS);
            }
        });
    }

    function isElementVisible(el) {
        if (!el || !document.contains(el) || el.hidden) return false;
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden';
    }

    function isEditableElement(el) {
        if (!el || !(el instanceof Element)) return false;
        const tag = el.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
        if (el.isContentEditable) return true;
        const contentEditableAttr = el.getAttribute('contenteditable');
        if (contentEditableAttr && contentEditableAttr.toLowerCase() !== 'false') return true;
        if (typeof el.closest === 'function' && el.closest('[contenteditable="true"], [role="textbox"]')) {
            return true;
        }
        return false;
    }

    function hasOpenMessengerViewer() {
        const buttons = document.querySelectorAll(NAV_BUTTON_SELECTOR);
        for (let i = 0; i < buttons.length; i++) {
            const btn = buttons[i];
            if (!isElementVisible(btn)) continue;
            const row = findViewerRow(btn);
            if (row && isElementVisible(row) && isMessengerViewerContext(row)) {
                row.classList.add(ROW_INVERT_CLASS);
                return true;
            }
        }
        return false;
    }

    function handleKeyDown(event) {
        if (!isFeatureActive) return;
        if (swappedKeyboardEvents.has(event)) return;
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        if (isEditableElement(event.target) || isEditableElement(document.activeElement)) return;
        if (!hasOpenMessengerViewer()) return;

        const targetKey = event.key === 'ArrowRight' ? 'ArrowLeft' : 'ArrowRight';
        const targetKeyCode = targetKey === 'ArrowLeft' ? 37 : 39;

        event.preventDefault();
        event.stopImmediatePropagation();

        const syntheticEvent = new KeyboardEvent('keydown', {
            key: targetKey,
            code: targetKey,
            keyCode: targetKeyCode,
            which: targetKeyCode,
            bubbles: true,
            cancelable: true,
            composed: true
        });

        if (syntheticEvent.keyCode !== targetKeyCode) {
            Object.defineProperty(syntheticEvent, 'keyCode', { get: () => targetKeyCode });
        }
        if (syntheticEvent.which !== targetKeyCode) {
            Object.defineProperty(syntheticEvent, 'which', { get: () => targetKeyCode });
        }

        swappedKeyboardEvents.add(syntheticEvent);
        (event.target || document).dispatchEvent(syntheticEvent);
    }

    function attachKeyListener() {
        if (keydownAttached) return;
        window.addEventListener('keydown', handleKeyDown, true);
        keydownAttached = true;
    }

    function detachKeyListener() {
        if (!keydownAttached) return;
        window.removeEventListener('keydown', handleKeyDown, true);
        keydownAttached = false;
    }

    function startObserver() {
        syncViewerRows();
        attachKeyListener();

        if (observer || typeof MutationObserver === 'undefined') return;
        const target = document.body || document.documentElement;
        if (!target) return;

        observer = new MutationObserver(() => {
            if (!isFeatureActive) return;
            syncViewerRows();
        });

        observer.observe(target, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['aria-label', 'src']
        });
    }

    function stopObserver() {
        if (observer) {
            observer.disconnect();
            observer = null;
        }
        detachKeyListener();
        syncViewerRows();
    }

    function updateSettings() {
        chrome.storage.local.get([
            GLOBAL_MASTER_SWITCH_ENABLED_KEY,
            MISC_MODULE_ENABLED_KEY,
            MESSENGER_INVERT_PHOTO_NAV_KEY
        ], (result) => {
            const globalOn = result[GLOBAL_MASTER_SWITCH_ENABLED_KEY] !== false;
            const moduleOn = result[MISC_MODULE_ENABLED_KEY] !== false;
            // Default to ON (true) unless explicitly disabled
            const invertOn = result[MESSENGER_INVERT_PHOTO_NAV_KEY] !== false;

            isFeatureActive = globalOn && moduleOn && invertOn;

            if (isFeatureActive) {
                startObserver();
            } else {
                stopObserver();
            }
        });
    }

    function handleStorageChanged(changes, area) {
        if (area !== 'local') return;
        if (
            changes[GLOBAL_MASTER_SWITCH_ENABLED_KEY] ||
            changes[MISC_MODULE_ENABLED_KEY] ||
            changes[MESSENGER_INVERT_PHOTO_NAV_KEY]
        ) {
            updateSettings();
        }
    }

    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        updateSettings();
        if (chrome.storage.onChanged) {
            chrome.storage.onChanged.addListener(handleStorageChanged);
        }
    }

    window.__ext414MessengerPhotoNavCleanup = function () {
        isFeatureActive = false;
        stopObserver();
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged && chrome.storage.onChanged.removeListener) {
            chrome.storage.onChanged.removeListener(handleStorageChanged);
        }
    };
})();
