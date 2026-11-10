/**
 * @jest-environment jest-environment-jsdom
 * @jest-environment-options {"url": "https://www.facebook.com/messages/t/987654321"}
 */

import { jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('messengerPhotoNavInverter.js on facebook.com routes', () => {
    const VIEWER_TEMPLATE = (imgSrc) => `
        <div id="fb-viewer-row" class="x78zum5 x1q0g3np">
            <div><div><div aria-label="Previous photo" role="button"><svg></svg></div></div></div>
            <div><img src="${imgSrc}"></div>
            <div><div><div aria-label="Next photo" role="button"><svg></svg></div></div></div>
        </div>
    `;

    beforeEach(() => {
        if (typeof window.__ext414MessengerPhotoNavCleanup === 'function') {
            window.__ext414MessengerPhotoNavCleanup();
        }
        document.documentElement.className = '';
        global.chrome = {
            storage: {
                local: {
                    get: jest.fn((keys, cb) => cb({
                        isGlobalMasterSwitchEnabled: true,
                        isMiscModuleEnabled: true,
                        isMessengerInvertPhotoNavEnabled: true
                    }))
                },
                onChanged: {
                    addListener: jest.fn(),
                    removeListener: jest.fn()
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
        eval(fs.readFileSync(scriptPath, 'utf8'));
    }

    it('should invert photo viewer on facebook.com/messages/* routes', () => {
        window.history.pushState({}, '', '/messages/t/987654321');
        document.body.innerHTML = VIEWER_TEMPLATE('https://scontent.xx.fbcdn.net/v/chat_img.jpg');
        loadScript();

        expect(document.getElementById('fb-viewer-row').classList.contains('ext414-messenger-photo-nav-row')).toBe(true);
    });

    it('should NOT invert standard Facebook post/album photo theater on facebook.com/photo/*', () => {
        window.history.pushState({}, '', '/photo/?fbid=1122334455');
        document.body.innerHTML = VIEWER_TEMPLATE('https://scontent.xx.fbcdn.net/v/post_album.jpg');
        loadScript();

        expect(document.getElementById('fb-viewer-row').classList.contains('ext414-messenger-photo-nav-row')).toBe(false);
    });

    it('should invert Messenger E2EE blob media opened from chat popups on facebook.com/', () => {
        window.history.pushState({}, '', '/');
        document.body.innerHTML = VIEWER_TEMPLATE('blob:https://www.facebook.com/d676da1c-8b24-4b80-93ba-f7d2bd70b7b3');
        loadScript();

        expect(document.getElementById('fb-viewer-row').classList.contains('ext414-messenger-photo-nav-row')).toBe(true);
    });
});
