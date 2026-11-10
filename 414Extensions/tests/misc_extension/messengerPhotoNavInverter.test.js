/**
 * @jest-environment jest-environment-jsdom
 * @jest-environment-options {"url": "https://www.messenger.com/t/123456789"}
 */

import { jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('messengerPhotoNavInverter.js', () => {
    let mockStorageData;
    let mockOnChangedListeners;

    const MESSENGER_LIGHTBOX_HTML = `
        <div id="messenger-viewer-row" class="x9f619 x1ja2u2z x78zum5 x1n2onr6 x1r8uery x1iyjqo2 xs83m0k xeuugli x1qughib x1qjc9v5 xozqiw3 x1q0g3np xyri2b x1c1uobl x18d9i69 xexx8yu x4cne27 xifccgj x2lwn1j x193iq5w x6ikm8r x10wlt62">
            <div id="left-col" class="x9f619 x1n2onr6 x1ja2u2z x78zum5 xdt5ytf x2lah0s x193iq5w xeuugli x10b6aqq x1yrsyyn">
                <div class="x6s0dn4 x78zum5 xl56j7k x1hc1fzr x1n2onr6 x1ebt8du x1jl3cmp x1dhq9h xfwg19i x1vjfegm x5yr21d">
                    <div aria-label="Previous photo" class="x1i10hfl x1qjc9v5" role="button" tabindex="-1">
                        <div class="xsqj5wx" style="--x-transform: scale(1);">
                            <svg viewBox="0 0 16 16" width="20" height="20" fill="currentColor" aria-hidden="true">
                                <path d="M10.957 2.043a1 1 0 0 0-1.414 0L7.776 3.806z"></path>
                            </svg>
                        </div>
                    </div>
                </div>
            </div>
            <div id="center-col" class="x9f619 x1n2onr6 x1ja2u2z x78zum5 xdt5ytf x193iq5w xeuugli x1r8uery x1iyjqo2">
                <div aria-hidden="true" class="x6s0dn4 x78zum5 x5yr21d xl56j7k xh8yej3">
                    <img height="100%" width="100%" class="x19kjcj4" alt="" src="blob:https://www.messenger.com/d676da1c-8b24-4b80-93ba-f7d2bd70b7b3">
                </div>
            </div>
            <div id="right-col" class="x9f619 x1n2onr6 x1ja2u2z x78zum5 xdt5ytf x2lah0s x193iq5w xeuugli x10b6aqq x1yrsyyn">
                <div class="x6s0dn4 x78zum5 xl56j7k x1hc1fzr x1n2onr6 x1ebt8du x1jl3cmp x1dhq9h xfwg19i x1vjfegm x5yr21d">
                    <div aria-label="Next photo" class="x1i10hfl x1qjc9v5" role="button" tabindex="-1">
                        <div class="xsqj5wx" style="--x-transform: scale(1);">
                            <svg viewBox="0 0 16 16" width="20" height="20" fill="currentColor" aria-hidden="true">
                                <path d="M5.043 2.043a1 1 0 0 1 1.414 0l1.767 1.763z"></path>
                            </svg>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;

    beforeEach(() => {
        if (typeof window.__ext414MessengerPhotoNavCleanup === 'function') {
            window.__ext414MessengerPhotoNavCleanup();
        }
        document.documentElement.className = '';
        document.body.innerHTML = MESSENGER_LIGHTBOX_HTML;
        mockOnChangedListeners = [];

        mockStorageData = {
            isGlobalMasterSwitchEnabled: true,
            isMiscModuleEnabled: true
            // isMessengerInvertPhotoNavEnabled intentionally omitted to verify default is ON (true)
        };

        global.chrome = {
            storage: {
                local: {
                    get: jest.fn((keys, callback) => {
                        const res = {};
                        keys.forEach((k) => {
                            res[k] = mockStorageData[k];
                        });
                        callback(res);
                    })
                },
                onChanged: {
                    addListener: jest.fn((fn) => {
                        mockOnChangedListeners.push(fn);
                    }),
                    removeListener: jest.fn((fn) => {
                        mockOnChangedListeners = mockOnChangedListeners.filter((l) => l !== fn);
                    })
                }
            }
        };
    });

    afterEach(() => {
        if (typeof window.__ext414MessengerPhotoNavCleanup === 'function') {
            window.__ext414MessengerPhotoNavCleanup();
        }
    });

    function loadScript() {
        const scriptPath = path.resolve(__dirname, '../../misc_extension/content_scripts/messengerPhotoNavInverter.js');
        const scriptContent = fs.readFileSync(scriptPath, 'utf8');
        eval(scriptContent);
    }

    it('should default to ON and mark only the 3-column viewer flex row for CSS row-reverse', () => {
        loadScript();

        const viewerRow = document.getElementById('messenger-viewer-row');
        const leftCol = document.getElementById('left-col');
        const rightCol = document.getElementById('right-col');

        expect(document.documentElement.classList.contains('ext414-invert-messenger-photo-nav')).toBe(true);
        expect(viewerRow.classList.contains('ext414-messenger-photo-nav-row')).toBe(true);
        expect(leftCol.classList.contains('ext414-messenger-photo-nav-row')).toBe(false);
        expect(rightCol.classList.contains('ext414-messenger-photo-nav-row')).toBe(false);
    });

    it('should handle single-button boundary states when at the newest or oldest photo', () => {
        // Remove "Previous photo" button as happens at the boundary of a thread
        const prevBtn = document.querySelector('[aria-label="Previous photo"]');
        prevBtn.remove();

        loadScript();

        const viewerRow = document.getElementById('messenger-viewer-row');
        expect(viewerRow.classList.contains('ext414-messenger-photo-nav-row')).toBe(true);
    });

    it('should swap ArrowRight and ArrowLeft keydown events while the photo viewer is open', () => {
        loadScript();

        const receivedKeys = [];
        const docListener = (e) => {
            receivedKeys.push({ key: e.key, keyCode: e.keyCode });
        };
        document.addEventListener('keydown', docListener);

        document.body.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'ArrowRight',
            code: 'ArrowRight',
            keyCode: 39,
            bubbles: true,
            cancelable: true
        }));

        document.body.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'ArrowLeft',
            code: 'ArrowLeft',
            keyCode: 37,
            bubbles: true,
            cancelable: true
        }));

        document.removeEventListener('keydown', docListener);

        expect(receivedKeys).toEqual([
            { key: 'ArrowLeft', keyCode: 37 },
            { key: 'ArrowRight', keyCode: 39 }
        ]);
    });

    it('should NOT swap arrow keys when typing in inputs/contenteditable or pressing modifier keys', () => {
        loadScript();

        const input = document.createElement('input');
        input.type = 'text';
        document.body.appendChild(input);
        input.focus();

        const receivedKeys = [];
        const docListener = (e) => {
            receivedKeys.push(e.key);
        };
        document.addEventListener('keydown', docListener);

        // Inside text input -> must remain ArrowRight
        input.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'ArrowRight',
            bubbles: true,
            cancelable: true
        }));

        // Blur input, press Alt+ArrowLeft (browser Back shortcut) -> must remain ArrowLeft
        input.blur();
        document.body.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'ArrowLeft',
            altKey: true,
            bubbles: true,
            cancelable: true
        }));

        document.removeEventListener('keydown', docListener);

        expect(receivedKeys).toEqual(['ArrowRight', 'ArrowLeft']);
    });

    it('should dynamically toggle OFF and ON when storage settings change and detect newly mounted viewers', async () => {
        loadScript();
        const viewerRow = document.getElementById('messenger-viewer-row');
        expect(viewerRow.classList.contains('ext414-messenger-photo-nav-row')).toBe(true);

        // Toggle feature OFF
        mockStorageData.isMessengerInvertPhotoNavEnabled = false;
        mockOnChangedListeners.forEach((fn) =>
            fn({ isMessengerInvertPhotoNavEnabled: { newValue: false } }, 'local')
        );

        expect(document.documentElement.classList.contains('ext414-invert-messenger-photo-nav')).toBe(false);
        expect(viewerRow.classList.contains('ext414-messenger-photo-nav-row')).toBe(false);

        // Toggle feature back ON with dynamically mounted lightbox
        document.body.innerHTML = '';
        mockStorageData.isMessengerInvertPhotoNavEnabled = true;
        mockOnChangedListeners.forEach((fn) =>
            fn({ isMessengerInvertPhotoNavEnabled: { newValue: true } }, 'local')
        );

        const wrapper = document.createElement('div');
        wrapper.innerHTML = MESSENGER_LIGHTBOX_HTML;
        document.body.appendChild(wrapper);

        await Promise.resolve();

        const newViewerRow = document.getElementById('messenger-viewer-row');
        expect(newViewerRow.classList.contains('ext414-messenger-photo-nav-row')).toBe(true);
    });
});
