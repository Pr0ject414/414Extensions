// 414Extensions/crunchyroll_extension/content_scripts/crunchyrollControlsHider.js
(function() {
    'use strict';

    const GLOBAL_MASTER_SWITCH_ENABLED_KEY = 'isGlobalMasterSwitchEnabled';
    const CRUNCHYROLL_MODULE_ENABLED_KEY = 'isCrunchyrollModuleEnabled';
    const CRUNCHYROLL_HIDE_CONTROLS_ON_SPEED_KEY = 'isCrunchyrollHideControlsOnSpeedEnabled';

    const HIDE_CLASS = 'cr-speed-controls-hidden';
    const MOUSE_IDLE_TIMEOUT_MS = 1200; // Time after mouse stops moving to re-hide controls

    let isFeatureActive = false;
    let isMouseActive = false;
    let isHoldingVideoMouse = false;
    let isDraggingInteractiveControl = false;
    let mouseTimer = null;
    let checkInterval = null;
    let globalListenersAttached = false;
    let attachedControlsRoot = null;

    function getPlayerControlsContainer() {
        const explicitRoot = document.querySelector('[data-testid="player-controls-root"]') ||
                             document.querySelector('[data-testid="vilos-player"]') ||
                             document.querySelector('.vilos-controls-container');
        if (explicitRoot) return explicitRoot;

        const autohideOverlay = document.querySelector('[data-testid="bottom-controls-autohide"]') ||
                                document.querySelector('[data-testid="top-controls-autohide"]');
        if (autohideOverlay) {
            let curr = autohideOverlay.parentElement;
            while (curr && curr !== document.body && curr !== document.documentElement) {
                if (
                    curr.querySelector('video') ||
                    (curr.querySelector('[data-testid="top-controls-autohide"]') && curr.querySelector('[data-testid="bottom-controls-autohide"]'))
                ) {
                    return curr;
                }
                curr = curr.parentElement;
            }
            return autohideOverlay.parentElement || autohideOverlay;
        }

        return null;
    }

    function isInteractiveControlElement(el) {
        if (!el || typeof el.closest !== 'function') return false;
        if (el.closest(
            'input, select, textarea, a[href], ' +
            '[data-testid="timeline-controls-container"], ' +
            '[data-testid="volume-slider-container"], ' +
            '[data-testid="bottom-left-controls-stack"], ' +
            '[data-testid="bottom-right-controls-stack"], ' +
            '[role="slider"], [role="menu"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], ' +
            '.vsc-controller-host'
        )) {
            return true;
        }
        const btn = el.closest('button, [role="button"]');
        if (btn) {
            const rect = typeof btn.getBoundingClientRect === 'function' ? btn.getBoundingClientRect() : { width: 0, height: 0 };
            if (rect.width <= 300 || rect.height <= 300) {
                return true;
            }
        }
        return false;
    }

    function isAnyVideoSpeedingUp() {
        const videos = document.querySelectorAll('video');
        for (let i = 0; i < videos.length; i++) {
            const video = videos[i];
            if (!video.paused && !video.ended && video.playbackRate > 1.05) {
                return true;
            }
        }
        return false;
    }

    function isMouseHeldForSpeed(e) {
        if (isDraggingInteractiveControl) return false;

        if (typeof window !== 'undefined' && window.VSC && typeof window.VSC.isMouseOverrideActive === 'function') {
            if (window.VSC.isMouseOverrideActive()) {
                return true;
            }
        }

        if (e && typeof e.buttons === 'number') {
            if ((e.buttons & 1) !== 0) {
                return true;
            }
            if (e.isTrusted && (e.buttons & 1) === 0) {
                isHoldingVideoMouse = false;
                return false;
            }
        }

        return isHoldingVideoMouse;
    }

    function onMouseDown(e) {
        if (!e || e.button !== 0) return;
        if (isInteractiveControlElement(e.target)) {
            isDraggingInteractiveControl = true;
            isHoldingVideoMouse = false;
        } else {
            isHoldingVideoMouse = true;
            isDraggingInteractiveControl = false;
        }
    }

    function onMouseRelease(e) {
        if (e && e.type === 'blur' && e.target !== window) return;
        isHoldingVideoMouse = false;
        isDraggingInteractiveControl = false;
    }

    function onPointerMove(e) {
        if (!isFeatureActive) return;
        if (isMouseHeldForSpeed(e) && isAnyVideoSpeedingUp()) {
            if (e && typeof e.buttons === 'number' && (e.buttons & 1) !== 0) {
                e.stopImmediatePropagation();
            }
        }
    }

    function onMouseMove(e) {
        if (isMouseHeldForSpeed(e)) {
            if (mouseTimer) {
                clearTimeout(mouseTimer);
                mouseTimer = null;
            }
            isMouseActive = false;
            if (isFeatureActive && isAnyVideoSpeedingUp() && e && typeof e.buttons === 'number' && (e.buttons & 1) !== 0) {
                e.stopImmediatePropagation();
            }
            checkVideoSpeedAndToggleControls();
            return;
        }

        isMouseActive = true;
        if (mouseTimer) {
            clearTimeout(mouseTimer);
        }
        checkVideoSpeedAndToggleControls();

        mouseTimer = setTimeout(() => {
            isMouseActive = false;
            checkVideoSpeedAndToggleControls();
        }, MOUSE_IDLE_TIMEOUT_MS);
    }

    function onMouseLeave() {
        isMouseActive = false;
        if (mouseTimer) {
            clearTimeout(mouseTimer);
            mouseTimer = null;
        }
        checkVideoSpeedAndToggleControls();
    }

    function attachMouseListeners() {
        if (!globalListenersAttached) {
            globalListenersAttached = true;
            window.addEventListener('mousedown', onMouseDown, true);
            window.addEventListener('mouseup', onMouseRelease, true);
            window.addEventListener('dragend', onMouseRelease, true);
            window.addEventListener('blur', onMouseRelease, true);
            window.addEventListener('pointermove', onPointerMove, true);
            window.addEventListener('mousemove', onMouseMove, true);
            if (document.documentElement) {
                document.documentElement.addEventListener('mouseleave', onMouseLeave, { passive: true });
            }
        }

        const controlsRoot = getPlayerControlsContainer();
        if (controlsRoot !== attachedControlsRoot) {
            if (attachedControlsRoot) {
                attachedControlsRoot.removeEventListener('mouseleave', onMouseLeave);
            }
            attachedControlsRoot = controlsRoot;
            if (attachedControlsRoot) {
                attachedControlsRoot.addEventListener('mouseleave', onMouseLeave, { passive: true });
            }
        }
    }

    function detachMouseListeners() {
        if (globalListenersAttached) {
            globalListenersAttached = false;
            window.removeEventListener('mousedown', onMouseDown, true);
            window.removeEventListener('mouseup', onMouseRelease, true);
            window.removeEventListener('dragend', onMouseRelease, true);
            window.removeEventListener('blur', onMouseRelease, true);
            window.removeEventListener('pointermove', onPointerMove, true);
            window.removeEventListener('mousemove', onMouseMove, true);
            if (document.documentElement) {
                document.documentElement.removeEventListener('mouseleave', onMouseLeave);
            }
        }
        if (attachedControlsRoot) {
            attachedControlsRoot.removeEventListener('mouseleave', onMouseLeave);
            attachedControlsRoot = null;
        }
    }

    function checkVideoSpeedAndToggleControls() {
        const controlsRoot = getPlayerControlsContainer();

        if (!isFeatureActive) {
            if (controlsRoot) controlsRoot.classList.remove(HIDE_CLASS);
            return;
        }

        const isSpeedingUp = isAnyVideoSpeedingUp();

        if (isSpeedingUp && isMouseHeldForSpeed()) {
            if (mouseTimer) {
                clearTimeout(mouseTimer);
                mouseTimer = null;
            }
            isMouseActive = false;
        }

        if (controlsRoot) {
            // Option 1: Hide controls when speeding up unless mouse is actively moving (without holding button)
            if (isSpeedingUp && !isMouseActive) {
                if (!controlsRoot.classList.contains(HIDE_CLASS)) {
                    controlsRoot.classList.add(HIDE_CLASS);
                }
            } else {
                if (controlsRoot.classList.contains(HIDE_CLASS)) {
                    controlsRoot.classList.remove(HIDE_CLASS);
                }
            }
        }
    }

    function attachVideoListeners() {
        const videos = document.querySelectorAll('video');
        videos.forEach(video => {
            if (!video.hasAttribute('data-cr-hider-attached')) {
                video.setAttribute('data-cr-hider-attached', 'true');
                const events = ['ratechange', 'play', 'playing', 'pause', 'timeupdate', 'seeking', 'seeked'];
                events.forEach(evt => {
                    video.addEventListener(evt, checkVideoSpeedAndToggleControls);
                });
            }
        });
    }

    function startMonitoring() {
        attachMouseListeners();
        attachVideoListeners();
        checkVideoSpeedAndToggleControls();

        if (!checkInterval) {
            checkInterval = setInterval(() => {
                attachMouseListeners();
                attachVideoListeners();
                checkVideoSpeedAndToggleControls();
            }, 300);
        }
    }

    function stopMonitoring() {
        if (checkInterval) {
            clearInterval(checkInterval);
            checkInterval = null;
        }
        if (mouseTimer) {
            clearTimeout(mouseTimer);
            mouseTimer = null;
        }
        detachMouseListeners();
        isMouseActive = false;
        isHoldingVideoMouse = false;
        isDraggingInteractiveControl = false;

        const controlsRoot = getPlayerControlsContainer();
        if (controlsRoot) {
            controlsRoot.classList.remove(HIDE_CLASS);
        }
    }

    function updateSettings() {
        chrome.storage.local.get([
            GLOBAL_MASTER_SWITCH_ENABLED_KEY,
            CRUNCHYROLL_MODULE_ENABLED_KEY,
            CRUNCHYROLL_HIDE_CONTROLS_ON_SPEED_KEY
        ], (result) => {
            const globalOn = result[GLOBAL_MASTER_SWITCH_ENABLED_KEY] !== false;
            const moduleOn = result[CRUNCHYROLL_MODULE_ENABLED_KEY] !== false;
            const featureOn = result[CRUNCHYROLL_HIDE_CONTROLS_ON_SPEED_KEY] !== false;

            isFeatureActive = globalOn && moduleOn && featureOn;

            if (isFeatureActive) {
                startMonitoring();
            } else {
                stopMonitoring();
            }
        });
    }

    // Initialize
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', updateSettings);
    } else {
        updateSettings();
    }

    // Storage listener
    chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName === 'local') {
            if (changes[GLOBAL_MASTER_SWITCH_ENABLED_KEY] ||
                changes[CRUNCHYROLL_MODULE_ENABLED_KEY] ||
                changes[CRUNCHYROLL_HIDE_CONTROLS_ON_SPEED_KEY]) {
                updateSettings();
            }
        }
    });

})();
