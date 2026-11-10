import { jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * @jest-environment jest-environment-jsdom
 */

describe('crunchyrollControlsHider.js (Option 1)', () => {
    let mockStorageGet;
    let mockOnChangedListener;

    beforeEach(() => {
        document.body.innerHTML = '';
        jest.useFakeTimers();

        mockStorageGet = jest.fn((keys, callback) => callback({
            isGlobalMasterSwitchEnabled: true,
            isCrunchyrollModuleEnabled: true,
            isCrunchyrollHideControlsOnSpeedEnabled: true
        }));
        mockOnChangedListener = jest.fn();

        global.chrome = {
            storage: {
                local: {
                    get: mockStorageGet
                },
                onChanged: {
                    addListener: mockOnChangedListener
                }
            }
        };
    });

    afterEach(() => {
        // Trigger clean teardown of previously evaluated IIFE listeners
        mockStorageGet.mockImplementation((keys, cb) => cb({
            isGlobalMasterSwitchEnabled: false,
            isCrunchyrollModuleEnabled: false,
            isCrunchyrollHideControlsOnSpeedEnabled: false
        }));
        mockOnChangedListener.mock.calls.forEach(([fn]) => {
            fn({ isCrunchyrollModuleEnabled: { newValue: false } }, 'local');
        });
        delete window.VSC;
        jest.useRealTimers();
    });

    function loadScript() {
        const scriptPath = path.resolve(__dirname, '../../crunchyroll_extension/content_scripts/crunchyrollControlsHider.js');
        const scriptContent = fs.readFileSync(scriptPath, 'utf8');
        eval(scriptContent);
    }

    it('should add cr-speed-controls-hidden when speeding up and mouse is idle', () => {
        const controlsRoot = document.createElement('div');
        controlsRoot.setAttribute('data-testid', 'player-controls-root');
        document.body.appendChild(controlsRoot);

        const video = document.createElement('video');
        Object.defineProperty(video, 'paused', { value: false, writable: true });
        Object.defineProperty(video, 'ended', { value: false, writable: true });
        Object.defineProperty(video, 'playbackRate', { value: 1.5, writable: true });
        document.body.appendChild(video);

        loadScript();
        jest.advanceTimersByTime(350);

        expect(controlsRoot.classList.contains('cr-speed-controls-hidden')).toBe(true);
    });

    it('should reveal controls when mouse moves and hide them again when mouse stops', () => {
        const controlsRoot = document.createElement('div');
        controlsRoot.setAttribute('data-testid', 'player-controls-root');
        document.body.appendChild(controlsRoot);

        const video = document.createElement('video');
        Object.defineProperty(video, 'paused', { value: false, writable: true });
        Object.defineProperty(video, 'ended', { value: false, writable: true });
        Object.defineProperty(video, 'playbackRate', { value: 2.0, writable: true });
        document.body.appendChild(video);

        loadScript();
        jest.advanceTimersByTime(350);
        expect(controlsRoot.classList.contains('cr-speed-controls-hidden')).toBe(true);

        // Simulate mouse move over controls (button NOT held down)
        controlsRoot.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, buttons: 0 }));
        expect(controlsRoot.classList.contains('cr-speed-controls-hidden')).toBe(false);

        // Advance past idle timeout (1200ms)
        jest.advanceTimersByTime(1300);
        expect(controlsRoot.classList.contains('cr-speed-controls-hidden')).toBe(true);
    });

    it('should keep controls hidden when moving the mouse while holding down the left mouse button to speed up', () => {
        // Use Katamari bottom-controls-autohide structure without player-controls-root
        const playerShell = document.createElement('div');
        const video = document.createElement('video');
        Object.defineProperty(video, 'paused', { value: false, writable: true });
        Object.defineProperty(video, 'ended', { value: false, writable: true });
        Object.defineProperty(video, 'playbackRate', { value: 1.0, writable: true });

        const bottomControls = document.createElement('div');
        bottomControls.setAttribute('data-testid', 'bottom-controls-autohide');
        bottomControls.setAttribute('data-overlay-visible', 'false');

        playerShell.appendChild(video);
        playerShell.appendChild(bottomControls);
        document.body.appendChild(playerShell);

        const playerMouseMoveSpy = jest.fn();
        playerShell.addEventListener('mousemove', playerMouseMoveSpy);

        loadScript();

        // User moves mouse onto video before pressing -> mouse is active initially
        playerShell.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, buttons: 0 }));

        // User presses and holds left mouse button on video surface
        video.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, buttons: 1 }));

        // After 500ms hold, VSC speeds video up to 2.0x
        video.playbackRate = 2.0;
        video.dispatchEvent(new Event('ratechange'));

        // Controls must hide immediately even though mouse moved < 1200ms ago
        expect(playerShell.classList.contains('cr-speed-controls-hidden')).toBe(true);

        playerMouseMoveSpy.mockClear();

        // User moves mouse while STILL holding down left mouse button
        playerShell.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, buttons: 1 }));
        expect(playerShell.classList.contains('cr-speed-controls-hidden')).toBe(true);
        expect(playerMouseMoveSpy).not.toHaveBeenCalled();

        // User releases mouse button, while video continues at 1.5x -> moving mouse freely now reveals controls
        video.playbackRate = 1.5;
        video.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, buttons: 0 }));
        expect(playerShell.classList.contains('cr-speed-controls-hidden')).toBe(true);

        playerShell.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, buttons: 0 }));
        expect(playerShell.classList.contains('cr-speed-controls-hidden')).toBe(false);
    });

    it('should allow controls to stay visible when dragging the timeline slider while sped up', () => {
        const playerShell = document.createElement('div');
        const video = document.createElement('video');
        Object.defineProperty(video, 'paused', { value: false, writable: true });
        Object.defineProperty(video, 'ended', { value: false, writable: true });
        Object.defineProperty(video, 'playbackRate', { value: 1.5, writable: true });

        const bottomControls = document.createElement('div');
        bottomControls.setAttribute('data-testid', 'bottom-controls-autohide');
        const timelineContainer = document.createElement('div');
        timelineContainer.setAttribute('data-testid', 'timeline-controls-container');
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.className = 'timeline-slider';
        timelineContainer.appendChild(slider);
        bottomControls.appendChild(timelineContainer);
        playerShell.appendChild(video);
        playerShell.appendChild(bottomControls);
        document.body.appendChild(playerShell);

        loadScript();
        jest.advanceTimersByTime(350);
        expect(playerShell.classList.contains('cr-speed-controls-hidden')).toBe(true);

        // Move mouse to reveal controls, then drag timeline slider
        playerShell.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, buttons: 0 }));
        expect(playerShell.classList.contains('cr-speed-controls-hidden')).toBe(false);

        slider.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, buttons: 1 }));
        slider.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, buttons: 1 }));
        expect(playerShell.classList.contains('cr-speed-controls-hidden')).toBe(false);
    });

    it('should remove cr-speed-controls-hidden when video speed is 1.0', () => {
        const controlsRoot = document.createElement('div');
        controlsRoot.setAttribute('data-testid', 'player-controls-root');
        controlsRoot.classList.add('cr-speed-controls-hidden');
        document.body.appendChild(controlsRoot);

        const video = document.createElement('video');
        Object.defineProperty(video, 'paused', { value: false, writable: true });
        Object.defineProperty(video, 'ended', { value: false, writable: true });
        Object.defineProperty(video, 'playbackRate', { value: 1.0, writable: true });
        document.body.appendChild(video);

        loadScript();
        jest.advanceTimersByTime(350);

        expect(controlsRoot.classList.contains('cr-speed-controls-hidden')).toBe(false);
    });
});
