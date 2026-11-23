import { jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Mock chrome API before importing modules
let messageListener;
global.chrome = {
    runtime: {
        onMessage: {
            addListener: jest.fn((listener) => {
                messageListener = listener;
            })
        },
        onStartup: { addListener: jest.fn() },
        onInstalled: { addListener: jest.fn() }
    },
    tabs: {
        query: jest.fn((_, cb) => cb && cb([])),
        sendMessage: jest.fn(),
        onRemoved: { addListener: jest.fn() },
        onActivated: { addListener: jest.fn() },
        onUpdated: { addListener: jest.fn() }
    },
    alarms: {
        onAlarm: { addListener: jest.fn() },
        create: jest.fn(),
        get: jest.fn()
    },
    storage: {
        local: {
            get: jest.fn((keys, cb) => {
                const res = {};
                if (cb) cb(res);
                return Promise.resolve(res);
            }),
            set: jest.fn((items, cb) => {
                if (cb) cb();
                return Promise.resolve();
            }),
            remove: jest.fn((keys, cb) => {
                if (cb) cb();
                return Promise.resolve();
            })
        }
    },
    webRequest: {
        onHeadersReceived: {
            addListener: jest.fn(),
            removeListener: jest.fn()
        }
    },
    contextMenus: {
        remove: jest.fn((_, cb) => cb && cb()),
        create: jest.fn((_, cb) => cb && cb()),
        onClicked: { addListener: jest.fn() }
    },
    action: {
        setBadgeText: jest.fn(),
        setBadgeBackgroundColor: jest.fn()
    }
};

global.console = {
    ...console,
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
};

// Import background.js which attaches listeners
await import('../background.js');
import * as AppState from '../shared_modules/appState.js';
import { moduleManager } from '../shared_modules/moduleManager.js';

describe('background coordinator message routing', () => {
    beforeEach(() => {
        AppState.setGlobalMasterSwitchEnabled(true);
    });

    test('should register message listener', () => {
        expect(messageListener).toBeDefined();
    });

    test('setGlobalMasterSwitch message updates AppState', () => {
        const sendResponse = jest.fn();
        messageListener({ action: 'setGlobalMasterSwitch', enabled: false }, {}, sendResponse);
        expect(AppState.globalMasterSwitchEnabled).toBe(false);
        expect(sendResponse).toHaveBeenCalledWith({ success: true });
    });

    test('module toggles update corresponding AppState properties', () => {
        const sendResponse = jest.fn();

        messageListener({ action: 'setXModuleEnabled', enabled: false }, {}, sendResponse);
        expect(AppState.xModuleEnabled).toBe(false);

        messageListener({ action: 'setCrunchyrollModuleEnabled', enabled: false }, {}, sendResponse);
        expect(AppState.crunchyrollModuleEnabled).toBe(false);

        messageListener({ action: 'setMiscModuleEnabled', enabled: false }, {}, sendResponse);
        expect(AppState.miscModuleEnabled).toBe(false);

        messageListener({ action: 'setVolumeModuleEnabled', enabled: false }, {}, sendResponse);
        expect(AppState.volumeModuleEnabled).toBe(false);

        messageListener({ action: 'setVscModuleEnabled', enabled: false }, {}, sendResponse);
        expect(AppState.vscModuleEnabled).toBe(false);

        messageListener({ action: 'setFabModuleEnabled', enabled: false }, {}, sendResponse);
        expect(AppState.fabModuleEnabled).toBe(false);

        messageListener({ action: 'setYouTubeModuleEnabled', enabled: false }, {}, sendResponse);
        expect(AppState.youTubeModuleEnabled).toBe(false);
    });

    test('getGlobalAppState message returns complete state snapshot', () => {
        const sendResponse = jest.fn();
        messageListener({ action: 'getGlobalAppState' }, {}, sendResponse);
        expect(sendResponse).toHaveBeenCalledWith(expect.objectContaining({
            globalMasterSwitchEnabled: expect.any(Boolean),
            fabModuleEnabled: expect.any(Boolean),
            youTubeModuleEnabled: expect.any(Boolean),
            xModuleEnabled: expect.any(Boolean),
            crunchyrollModuleEnabled: expect.any(Boolean),
            volumeModuleEnabled: expect.any(Boolean),
            vscModuleEnabled: expect.any(Boolean),
        }));
    });

    test('routes X_ADD_FORCE_COMMENT and X_DELETE_FORCE_COMMENT to XBackground instead of dropping them', async () => {
        const addSendResponse = jest.fn();
        const addResult = messageListener({
            action: 'X_ADD_FORCE_COMMENT',
            payload: { tweetId: '1850000000000009999', text: 'Test comment' }
        }, {}, addSendResponse);

        expect(addResult).toBe(true);
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(addSendResponse).toHaveBeenCalledWith({
            success: false,
            error: expect.any(String)
        });

        const delSendResponse = jest.fn();
        const delResult = messageListener({
            action: 'X_DELETE_FORCE_COMMENT',
            payload: { tweetId: '1850000000000009999', commentId: 'c_missing' }
        }, {}, delSendResponse);

        expect(delResult).toBe(true);
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(delSendResponse).toHaveBeenCalledWith(expect.objectContaining({
            success: true,
            deleted: false
        }));
    });

    test('every X action handled in xBackground.js is registered in background.js moduleManager', () => {
        const __dirname = path.dirname(fileURLToPath(import.meta.url));
        const xBgPath = path.resolve(__dirname, '..', 'x_extension', 'xBackground.js');
        const xBgSource = fs.readFileSync(xBgPath, 'utf8');
        const actionMatches = Array.from(xBgSource.matchAll(/request\.action\s*===\s*["']([^"']+)["']/g))
            .map(m => m[1]);
        expect(actionMatches.length).toBeGreaterThan(0);

        for (const action of actionMatches) {
            const isRegistered = moduleManager.modules.some(m => m.actions.has(action));
            expect({ action, isRegistered }).toEqual({ action, isRegistered: true });
        }
    });
});
