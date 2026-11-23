// 414Extensions/x_extension/xFriendsSync.js
import { FRIEND_SYNC_CONFIG } from './xLocationConstants.js';
import { X_FRIENDS_STATE_KEY, X_FRIENDS_SYNC_ENABLED_KEY } from '../shared_modules/coreConstants.js';
import {
    generateSecretKeyHex,
    getPublicKeyHex,
    generateRandomBytesHex,
    signEvent,
    verifyEvent,
    normalizeIdentifier,
    deriveInboxInfo,
    derivePairwiseInfo,
    deriveSelfSyncInfo,
    encryptJson,
    decryptJson
} from './xNostrCrypto.js';

const TWITTER_EPOCH_MS = 1288834974657n;
const MIN_SNOWFLAKE_ID = 300000000000000n;

export const SELF_SYNC_PREF_KEYS = [
    'blockedCountries',
    'blockedDeviceRegions',
    'blockedNameFlags',
    'isXLocationEnabled',
    'isXHideAdsEnabled',
    'isXAlwaysMuteEnabled',
    'isXFriendsSyncEnabled',
    'xVolumeLevel'
];

export class XFriendsSyncManager {
    constructor(options = {}) {
        this.relays = options.relays || FRIEND_SYNC_CONFIG.RELAYS;
        this.hasCustomWebSocketFactory = typeof options.webSocketFactory === 'function';
        this.webSocketFactory = options.webSocketFactory || ((url) => {
            try {
                return new WebSocket(url);
            } catch (e) {
                return null;
            }
        });
        this.fetchFn = options.fetchFn || ((...args) => globalThis.fetch(...args));
        this.enableNip11Preflight = options.enableNip11Preflight !== undefined
            ? Boolean(options.enableNip11Preflight)
            : !this.hasCustomWebSocketFactory;
        this.preflightMaxRetries = options.preflightMaxRetries !== undefined
            ? Number(options.preflightMaxRetries)
            : (FRIEND_SYNC_CONFIG.RELAY_PREFLIGHT_MAX_RETRIES ?? 2);
        this.preflightRetryDelayMs = options.preflightRetryDelayMs !== undefined
            ? Number(options.preflightRetryDelayMs)
            : (FRIEND_SYNC_CONFIG.RELAY_PREFLIGHT_RETRY_DELAY_MS ?? 600);
        this.batchMaxRetries = options.batchMaxRetries !== undefined
            ? Number(options.batchMaxRetries)
            : 1;
        this.batchRetryDelayMs = options.batchRetryDelayMs !== undefined
            ? Number(options.batchRetryDelayMs)
            : (FRIEND_SYNC_CONFIG.RELAY_BATCH_RETRY_DELAY_MS ?? 800);
        this.onNotification = options.onNotification || null;
        this.isLoaded = false;
        this._initPromise = null;
        this.isSyncing = false;
        this.pendingSyncRequested = false;
        this.lastSyncTime = null;
        this.lastPublishedCreatedAtSec = 0;
        this.flushTimeout = null;
        this.inflightHydrations = new Map();
        this.failedHydrationUntil = new Map();
        this.snowflakeTimeCache = new Map();
        this.lastSyncNotifications = { newInvites: [], newForcedPosts: [], newForceComments: [] };

        this.state = {
            identity: null, // { email, displayName, passphrase, privKeyHex, pubkeyHex, seenFeedKeyHex, identityCreatedAt }
            friends: {},    // { [email]: { email, displayName, status, pubkeyHex, seenFeedKeyHex, addedAt, lastSyncedAt, seenCount } }
            removedFriends: {}, // { [email]: removedAtMs }
            mySeenIds: [],  // string[]
            friendSeenMap: {}, // { [email]: string[] }
            postMetaMap: {},   // { [tweetId]: TweetMeta }
            myForcedMap: {},   // { [tweetId]: { id, forcedAt } }
            unforcedMap: {},   // { [tweetId]: unforcedAtMs }
            friendForcedMap: {}, // { [email]: Array<{ id, forcedAt }> }
            myForcedCommentsMap: {}, // { [tweetId]: Array<{ id, text, createdAt }> }
            deletedCommentsMap: {},  // { [commentId]: deletedAtMs }
            friendCommentsMap: {},   // { [email]: { [tweetId]: Array<{ id, text, createdAt }> } }
            dismissedForcedIds: [], // string[]
            notifiedForcedIds: [],  // string[]
            dismissedCommentIds: [], // string[]
            notifiedCommentIds: [],  // string[]
            notifiedInviteEmails: [], // string[]
            preferencesUpdatedAt: 0,
            lastKnownPrefsJson: '',
            selfSyncLastSyncedAt: null,
            relayHealth: {} // { [relayUrl]: { failures, cooldownUntil, updatedAt } }
        };

        this.mySeenSet = new Set();
        this.dismissedForcedSet = new Set();
        this.notifiedForcedSet = new Set();
        this.dismissedCommentSet = new Set();
        this.notifiedCommentSet = new Set();
        this.notifiedInviteSet = new Set();
        this.tweetToFriendsMap = new Map(); // tweetId -> string[] of friend labels
        this.tweetToForcedByMap = new Map(); // tweetId -> Array<{ label, email, forcedAt }>
        this.tweetToCommentsMap = new Map(); // tweetId -> Array<{ id, tweetId, text, createdAt, authorEmail, authorName, authorLabel, isMe }>
        this.wsPool = new Map();            // relayUrl -> pooled connection entry
        this.relayCooldownUntil = new Map(); // relayUrl -> timestamp ms
        this.relayFailureCounts = new Map(); // relayUrl -> consecutive failure count
        this.relayPreflightOkUntil = new Map(); // relayUrl -> timestamp ms
        this.inflightPreflights = new Map(); // relayUrl -> Promise<boolean>
        this.relayHealthDirty = false;
    }

    async init() {
        if (this.isLoaded) return;
        if (this._initPromise) return this._initPromise;
        this._initPromise = (async () => {
            try {
                const stored = await chrome.storage.local.get([X_FRIENDS_STATE_KEY]);
                if (stored && stored[X_FRIENDS_STATE_KEY]) {
                    const loaded = stored[X_FRIENDS_STATE_KEY];
                    this.state.identity = loaded.identity || null;
                    this.state.friends = loaded.friends || {};
                    this.state.removedFriends = (loaded.removedFriends && typeof loaded.removedFriends === 'object') ? loaded.removedFriends : {};
                    this.state.mySeenIds = Array.isArray(loaded.mySeenIds) ? loaded.mySeenIds : [];
                    this.state.friendSeenMap = loaded.friendSeenMap || {};
                    this.state.postMetaMap = (loaded.postMetaMap && typeof loaded.postMetaMap === 'object') ? loaded.postMetaMap : {};
                    this.state.myForcedMap = (loaded.myForcedMap && typeof loaded.myForcedMap === 'object') ? loaded.myForcedMap : {};
                    this.state.unforcedMap = (loaded.unforcedMap && typeof loaded.unforcedMap === 'object') ? loaded.unforcedMap : {};
                    this.state.friendForcedMap = (loaded.friendForcedMap && typeof loaded.friendForcedMap === 'object') ? loaded.friendForcedMap : {};
                    this.state.myForcedCommentsMap = (loaded.myForcedCommentsMap && typeof loaded.myForcedCommentsMap === 'object') ? loaded.myForcedCommentsMap : {};
                    this.state.deletedCommentsMap = (loaded.deletedCommentsMap && typeof loaded.deletedCommentsMap === 'object') ? loaded.deletedCommentsMap : {};
                    this.state.friendCommentsMap = (loaded.friendCommentsMap && typeof loaded.friendCommentsMap === 'object') ? loaded.friendCommentsMap : {};
                    this.state.dismissedForcedIds = Array.isArray(loaded.dismissedForcedIds) ? loaded.dismissedForcedIds : [];
                    this.state.notifiedForcedIds = Array.isArray(loaded.notifiedForcedIds) ? loaded.notifiedForcedIds : [];
                    this.state.dismissedCommentIds = Array.isArray(loaded.dismissedCommentIds) ? loaded.dismissedCommentIds : [];
                    this.state.notifiedCommentIds = Array.isArray(loaded.notifiedCommentIds) ? loaded.notifiedCommentIds : [];
                    this.state.notifiedInviteEmails = Array.isArray(loaded.notifiedInviteEmails) ? loaded.notifiedInviteEmails : [];
                    this.state.hasUnpublishedSeen = Boolean(loaded.hasUnpublishedSeen);
                    this.state.preferencesUpdatedAt = Number(loaded.preferencesUpdatedAt) || 0;
                    this.state.lastKnownPrefsJson = typeof loaded.lastKnownPrefsJson === 'string' ? loaded.lastKnownPrefsJson : '';
                    this.state.selfSyncLastSyncedAt = loaded.selfSyncLastSyncedAt || null;
                    this.state.relayHealth = (loaded.relayHealth && typeof loaded.relayHealth === 'object') ? loaded.relayHealth : {};
                }
            } catch (err) {
                console.warn('X Friends Sync: Failed to load state from storage', err);
            }

            this.restoreRelayHealthFromState();
            this.pruneMySeenIds();
            this.rebuildIndex();
            this.isLoaded = true;
        })();

        try {
            return await this._initPromise;
        } finally {
            this._initPromise = null;
        }
    }

    restoreRelayHealthFromState() {
        const rawHealth = this.state.relayHealth;
        if (!rawHealth || typeof rawHealth !== 'object') return;
        const now = Date.now();
        const maxRetentionMs = (FRIEND_SYNC_CONFIG.RELAY_MAX_COOLDOWN_MS || (30 * 60 * 1000)) * 2;

        for (const [relayUrl, info] of Object.entries(rawHealth)) {
            if (!relayUrl || !info || typeof info !== 'object') continue;
            const updatedAt = Number(info.updatedAt) || 0;
            if (updatedAt > 0 && (now - updatedAt) > maxRetentionMs) continue;

            const failures = Number(info.failures) || 0;
            if (failures > 0 && !this.relayFailureCounts.has(relayUrl)) {
                this.relayFailureCounts.set(relayUrl, failures);
            }

            const cooldownUntil = Number(info.cooldownUntil) || 0;
            if (cooldownUntil > now && !this.relayCooldownUntil.has(relayUrl)) {
                this.relayCooldownUntil.set(relayUrl, cooldownUntil);
            }
        }
    }

    syncRelayHealthToState() {
        const now = Date.now();
        const nextHealth = {};
        const allUrls = new Set([
            ...this.relayFailureCounts.keys(),
            ...this.relayCooldownUntil.keys()
        ]);

        for (const relayUrl of allUrls) {
            const failures = this.relayFailureCounts.get(relayUrl) || 0;
            const cooldownUntil = this.relayCooldownUntil.get(relayUrl) || 0;
            if (failures > 0 || cooldownUntil > now) {
                nextHealth[relayUrl] = {
                    failures,
                    cooldownUntil: cooldownUntil > now ? cooldownUntil : 0,
                    updatedAt: now
                };
            }
        }

        this.state.relayHealth = nextHealth;
    }

    async saveState() {
        try {
            this.state.mySeenIds = Array.from(this.mySeenSet);
            this.state.dismissedForcedIds = Array.from(this.dismissedForcedSet);
            this.state.notifiedForcedIds = Array.from(this.notifiedForcedSet);
            this.state.dismissedCommentIds = Array.from(this.dismissedCommentSet);
            this.state.notifiedCommentIds = Array.from(this.notifiedCommentSet);
            this.state.notifiedInviteEmails = Array.from(this.notifiedInviteSet);
            this.syncRelayHealthToState();
            this.relayHealthDirty = false;
            await chrome.storage.local.set({
                [X_FRIENDS_STATE_KEY]: this.state
            });
        } catch (err) {
            console.warn('X Friends Sync: Failed to save state', err);
        }
    }

    isValidRecentTweetId(tweetId) {
        if (!tweetId || typeof tweetId !== 'string') return false;
        const trimmed = tweetId.trim();
        return /^\d{1,22}$/.test(trimmed);
    }

    getSnowflakeTimestampMs(tweetId) {
        if (!this.isValidRecentTweetId(tweetId)) return 0;
        const trimmed = tweetId.trim();
        const cached = this.snowflakeTimeCache.get(trimmed);
        if (cached !== undefined) return cached;
        try {
            const idBig = BigInt(trimmed);
            const ms = idBig >= MIN_SNOWFLAKE_ID
                ? Number((idBig >> 22n) + TWITTER_EPOCH_MS)
                : 0;
            if (this.snowflakeTimeCache.size >= 4000) {
                const oldest = this.snowflakeTimeCache.keys().next().value;
                if (oldest !== undefined) this.snowflakeTimeCache.delete(oldest);
            }
            this.snowflakeTimeCache.set(trimmed, ms);
            return ms;
        } catch (e) {
            return 0;
        }
    }

    isSnowflakeWithinAge(tweetId, nowMs = Date.now(), maxAgeMs = FRIEND_SYNC_CONFIG.MAX_AGE_MS) {
        if (!this.isValidRecentTweetId(tweetId)) return false;
        try {
            const idBig = BigInt(tweetId.trim());
            if (idBig >= MIN_SNOWFLAKE_ID) {
                const createdMs = Number((idBig >> 22n) + TWITTER_EPOCH_MS);
                if (createdMs <= nowMs && (nowMs - createdMs) > maxAgeMs) {
                    return false;
                }
            }
            return true;
        } catch (e) {
            return false;
        }
    }

    getMediaAssetKey(url) {
        if (!url || typeof url !== 'string') return '';
        const noQuery = url.split('?')[0].trim();
        const mediaMatch = noQuery.match(/\/media\/([A-Za-z0-9_-]+)/);
        if (mediaMatch && mediaMatch[1]) return `media:${mediaMatch[1]}`;
        const videoMatch = noQuery.match(/\/(?:ext_tw_video|amplify_video|tweet_video)\/(\d+)/);
        if (videoMatch && videoMatch[1]) return `video:${videoMatch[1]}`;
        return noQuery.replace(/\.(jpg|jpeg|png|webp|gif|mp4)$/i, '');
    }

    sanitizeForceCommentText(rawText) {
        if (typeof rawText !== 'string') return '';
        const maxLen = FRIEND_SYNC_CONFIG.MAX_COMMENT_LENGTH || 500;
        return rawText.trim().slice(0, maxLen);
    }

    sanitizeForceCommentEntry(raw, fallbackTime = Date.now()) {
        if (!raw || typeof raw !== 'object') return null;
        const id = String(raw.id || '').trim().slice(0, 80);
        const text = this.sanitizeForceCommentText(raw.text);
        if (!id || !text) return null;
        const rawTime = Number(raw.createdAt);
        const createdAt = (Number.isFinite(rawTime) && rawTime > 0) ? rawTime : (Number(fallbackTime) || Date.now());
        return { id, text, createdAt };
    }

    sanitizeTweetMeta(tweetId, rawMeta) {
        if (!this.isValidRecentTweetId(tweetId) || !rawMeta || typeof rawMeta !== 'object') return null;
        const id = String(tweetId).trim();
        const existing = this.state.postMetaMap[id] || {};

        if (rawMeta.isUnavailable) {
            const hasExistingContent = Boolean(
                existing.screenName ||
                existing.text ||
                (Array.isArray(existing.media) && existing.media.length > 0) ||
                existing.quotedTweet ||
                existing.parentTweet
            );
            if (hasExistingContent) {
                return {
                    ...existing,
                    isHydrated: true,
                    hydrationVersion: 4,
                    updatedAt: rawMeta.updatedAt || existing.updatedAt || Date.now()
                };
            }
            return {
                id,
                isUnavailable: true,
                isHydrated: true,
                hydrationVersion: 4,
                updatedAt: rawMeta.updatedAt || existing.updatedAt || Date.now()
            };
        }

        // Do not let unhydrated relay/DOM snapshots overwrite already-hydrated authoritative metadata
        const keepExistingHydrated = Boolean(existing.isHydrated && !rawMeta.isHydrated);

        const screenName = keepExistingHydrated && existing.screenName
            ? existing.screenName
            : ((typeof rawMeta.screenName === 'string' && rawMeta.screenName.trim())
                ? rawMeta.screenName.trim().replace(/^@/, '').slice(0, 30)
                : (existing.screenName || ''));
        const authorName = keepExistingHydrated && existing.authorName
            ? existing.authorName
            : ((typeof rawMeta.authorName === 'string' && rawMeta.authorName.trim())
                ? rawMeta.authorName.trim().slice(0, 80)
                : (existing.authorName || screenName || ''));
        const avatarUrl = keepExistingHydrated && existing.avatarUrl
            ? existing.avatarUrl
            : ((typeof rawMeta.avatarUrl === 'string' && rawMeta.avatarUrl.startsWith('http'))
                ? rawMeta.avatarUrl.trim().slice(0, 350)
                : (existing.avatarUrl || ''));
        const isVerified = keepExistingHydrated
            ? Boolean(existing.isVerified || rawMeta.isVerified)
            : Boolean(rawMeta.isVerified ?? existing.isVerified);
        const text = keepExistingHydrated
            ? (existing.text || '')
            : ((rawMeta.isHydrated && typeof rawMeta.text === 'string')
                ? rawMeta.text.trim().slice(0, 1000)
                : ((typeof rawMeta.text === 'string' && rawMeta.text.trim())
                    ? rawMeta.text.trim().slice(0, 1000)
                    : (existing.text || '')));
        const createdAt = (keepExistingHydrated && existing.createdAt)
            ? existing.createdAt
            : (rawMeta.createdAt || existing.createdAt || null);
        const favoriteCount = typeof rawMeta.favoriteCount === 'number' && rawMeta.favoriteCount > 0
            ? Math.max(rawMeta.favoriteCount, existing.favoriteCount || 0)
            : (existing.favoriteCount || 0);
        const replyCount = typeof rawMeta.replyCount === 'number' && rawMeta.replyCount > 0
            ? Math.max(rawMeta.replyCount, existing.replyCount || 0)
            : (existing.replyCount || 0);
        const retweetCount = typeof rawMeta.retweetCount === 'number' && rawMeta.retweetCount > 0
            ? Math.max(rawMeta.retweetCount, existing.retweetCount || 0)
            : (existing.retweetCount || 0);
        const viewCount = typeof rawMeta.viewCount === 'number' && rawMeta.viewCount > 0
            ? Math.max(rawMeta.viewCount, existing.viewCount || 0)
            : (existing.viewCount || 0);
        const isHydrated = Boolean(rawMeta.isHydrated || existing.isHydrated);
        const hydrationVersion = rawMeta.isHydrated
            ? (rawMeta.hydrationVersion || 3)
            : (existing.hydrationVersion || rawMeta.hydrationVersion || 0);
        const permalink = (typeof rawMeta.permalink === 'string' && rawMeta.permalink.startsWith('http'))
            ? rawMeta.permalink.trim().slice(0, 200)
            : (existing.permalink || (screenName ? `https://x.com/${screenName}/status/${id}` : `https://x.com/i/status/${id}`));

        const normalizeMediaArray = (rawArr, prevArr = [], isAuthoritative = false) => {
            if (!Array.isArray(rawArr) || rawArr.length === 0) {
                return isAuthoritative ? [] : prevArr;
            }
            return rawArr
                .filter(m => m && typeof m === 'object' && (m.url || m.posterUrl || m.videoUrl))
                .slice(0, 4)
                .map((m, idx) => {
                    const prev = prevArr[idx] || {};
                    const isVid = m.type === 'video' || m.type === 'animated_gif';
                    return {
                        type: isVid ? m.type : 'photo',
                        url: typeof m.url === 'string' && m.url ? m.url.slice(0, 450) : (prev.url || ''),
                        posterUrl: typeof m.posterUrl === 'string' && m.posterUrl ? m.posterUrl.slice(0, 450) : (prev.posterUrl || ''),
                        videoUrl: typeof m.videoUrl === 'string' && m.videoUrl ? m.videoUrl.slice(0, 500) : (prev.videoUrl || '')
                    };
                });
        };

        let quotedTweet = existing.quotedTweet || null;
        if (!keepExistingHydrated && rawMeta.quotedTweet && typeof rawMeta.quotedTweet === 'object') {
            const prevQ = existing.quotedTweet || {};
            const qId = typeof rawMeta.quotedTweet.id === 'string' && rawMeta.quotedTweet.id.trim()
                ? rawMeta.quotedTweet.id.trim()
                : (prevQ.id || '');
            const qScreenName = typeof rawMeta.quotedTweet.screenName === 'string' && rawMeta.quotedTweet.screenName.trim()
                ? rawMeta.quotedTweet.screenName.trim().replace(/^@/, '').slice(0, 30)
                : (prevQ.screenName || '');
            const qAuthorName = typeof rawMeta.quotedTweet.authorName === 'string' && rawMeta.quotedTweet.authorName.trim()
                ? rawMeta.quotedTweet.authorName.trim().slice(0, 80)
                : (prevQ.authorName || qScreenName || '');
            const qAvatarUrl = typeof rawMeta.quotedTweet.avatarUrl === 'string' && rawMeta.quotedTweet.avatarUrl.startsWith('http')
                ? rawMeta.quotedTweet.avatarUrl.trim().slice(0, 350)
                : (prevQ.avatarUrl || '');
            const qText = (rawMeta.isHydrated && typeof rawMeta.quotedTweet.text === 'string')
                ? rawMeta.quotedTweet.text.trim().slice(0, 500)
                : ((typeof rawMeta.quotedTweet.text === 'string' && rawMeta.quotedTweet.text.trim())
                    ? rawMeta.quotedTweet.text.trim().slice(0, 500)
                    : (prevQ.text || ''));
            const qMedia = normalizeMediaArray(rawMeta.quotedTweet.media, prevQ.media || [], Boolean(rawMeta.isHydrated));
            const qCreatedAt = rawMeta.quotedTweet.createdAt || prevQ.createdAt || null;
            const qInReplyTo = typeof rawMeta.quotedTweet.inReplyToScreenName === 'string' && rawMeta.quotedTweet.inReplyToScreenName.trim()
                ? rawMeta.quotedTweet.inReplyToScreenName.trim().replace(/^@/, '').slice(0, 30)
                : (prevQ.inReplyToScreenName || '');
            if (qScreenName || qAuthorName || qText || qMedia.length > 0) {
                quotedTweet = {
                    id: qId,
                    screenName: qScreenName,
                    authorName: qAuthorName,
                    avatarUrl: qAvatarUrl,
                    isVerified: Boolean(rawMeta.quotedTweet.isVerified ?? prevQ.isVerified),
                    createdAt: qCreatedAt,
                    inReplyToScreenName: qInReplyTo,
                    text: qText,
                    media: qMedia
                };
            }
        }

        const rawOuterMedia = keepExistingHydrated
            ? (existing.media || [])
            : normalizeMediaArray(rawMeta.media, existing.media || [], Boolean(rawMeta.isHydrated));

        const quoteAssetKeys = new Set(
            (quotedTweet && Array.isArray(quotedTweet.media))
                ? quotedTweet.media.map(m => this.getMediaAssetKey(m.url || m.posterUrl)).filter(Boolean)
                : []
        );
        const media = quoteAssetKeys.size > 0
            ? rawOuterMedia.filter(m => !quoteAssetKeys.has(this.getMediaAssetKey(m.url || m.posterUrl)))
            : rawOuterMedia;

        let parentTweet = existing.parentTweet || null;
        if (!keepExistingHydrated && rawMeta.parentTweet && typeof rawMeta.parentTweet === 'object') {
            const prevP = existing.parentTweet || {};
            const pId = typeof rawMeta.parentTweet.id === 'string' && rawMeta.parentTweet.id.trim()
                ? rawMeta.parentTweet.id.trim()
                : (prevP.id || '');
            const pScreenName = typeof rawMeta.parentTweet.screenName === 'string' && rawMeta.parentTweet.screenName.trim()
                ? rawMeta.parentTweet.screenName.trim().replace(/^@/, '').slice(0, 30)
                : (prevP.screenName || '');
            const pAuthorName = typeof rawMeta.parentTweet.authorName === 'string' && rawMeta.parentTweet.authorName.trim()
                ? rawMeta.parentTweet.authorName.trim().slice(0, 80)
                : (prevP.authorName || pScreenName || '');
            const pAvatarUrl = typeof rawMeta.parentTweet.avatarUrl === 'string' && rawMeta.parentTweet.avatarUrl.startsWith('http')
                ? rawMeta.parentTweet.avatarUrl.trim().slice(0, 350)
                : (prevP.avatarUrl || '');
            const pText = (rawMeta.isHydrated && typeof rawMeta.parentTweet.text === 'string')
                ? rawMeta.parentTweet.text.trim().slice(0, 500)
                : ((typeof rawMeta.parentTweet.text === 'string' && rawMeta.parentTweet.text.trim())
                    ? rawMeta.parentTweet.text.trim().slice(0, 500)
                    : (prevP.text || ''));
            const pMedia = normalizeMediaArray(rawMeta.parentTweet.media, prevP.media || [], Boolean(rawMeta.isHydrated));
            const pCreatedAt = rawMeta.parentTweet.createdAt || prevP.createdAt || null;
            const pInReplyTo = typeof rawMeta.parentTweet.inReplyToScreenName === 'string' && rawMeta.parentTweet.inReplyToScreenName.trim()
                ? rawMeta.parentTweet.inReplyToScreenName.trim().replace(/^@/, '').slice(0, 30)
                : (prevP.inReplyToScreenName || '');
            if (pScreenName || pAuthorName || pText || pMedia.length > 0) {
                parentTweet = {
                    id: pId,
                    screenName: pScreenName,
                    authorName: pAuthorName,
                    avatarUrl: pAvatarUrl,
                    isVerified: Boolean(rawMeta.parentTweet.isVerified ?? prevP.isVerified),
                    createdAt: pCreatedAt,
                    inReplyToScreenName: pInReplyTo,
                    text: pText,
                    media: pMedia
                };
            }
        }

        const inReplyToScreenName = keepExistingHydrated
            ? (existing.inReplyToScreenName || '')
            : (typeof rawMeta.inReplyToScreenName === 'string' && rawMeta.inReplyToScreenName.trim()
                ? rawMeta.inReplyToScreenName.trim().replace(/^@/, '').slice(0, 30)
                : (existing.inReplyToScreenName || ''));

        if (!screenName && !authorName && !text && media.length === 0 && !quotedTweet && !parentTweet) {
            return existing.id ? existing : null;
        }

        return {
            id,
            screenName,
            authorName,
            avatarUrl,
            isVerified,
            inReplyToScreenName,
            text,
            media,
            quotedTweet,
            parentTweet,
            createdAt,
            favoriteCount,
            replyCount,
            retweetCount,
            viewCount,
            isHydrated,
            hydrationVersion,
            permalink,
            updatedAt: rawMeta.updatedAt || existing.updatedAt || Date.now()
        };
    }

    cleanSyndicationText(rawText, entities = {}, quotedId = '', displayTextRange = null) {
        if (typeof rawText !== 'string' || !rawText) return '';
        let text = rawText;

        // Strip leading reply @mentions that precede display_text_range[0]
        if (Array.isArray(displayTextRange) && typeof displayTextRange[0] === 'number' && displayTextRange[0] > 0) {
            const codePoints = Array.from(text);
            const prefix = codePoints.slice(0, displayTextRange[0]).join('').trim();
            if (prefix && /^(?:@[a-zA-Z0-9_]{1,15}\s*)+$/.test(prefix)) {
                text = codePoints.slice(displayTextRange[0]).join('');
            }
        }

        if (Array.isArray(entities.urls)) {
            for (const u of entities.urls) {
                if (u && u.url) {
                    const expanded = u.expanded_url || '';
                    const display = u.display_url || '';
                    const isQuotedLink = quotedId && (expanded.includes(`/status/${quotedId}`) || display.includes(`/status/${quotedId}`));
                    const replacement = isQuotedLink ? '' : (display || expanded || u.url);
                    text = text.split(u.url).join(replacement);
                }
            }
        }

        if (Array.isArray(entities.media)) {
            for (const m of entities.media) {
                if (m && m.url) {
                    text = text.split(m.url).join('');
                }
            }
        }

        if (quotedId) {
            text = text
                .replace(new RegExp(`https?:\\/\\/[^\\s]*\\/status\\/${quotedId}[^\\s]*`, 'gi'), '')
                .replace(/https?:\/\/t\.co\/[a-zA-Z0-9]+\s*$/g, '');
        }

        return text
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .trim();
    }

    extractSyndicationMedia(tweetObj) {
        if (!tweetObj || typeof tweetObj !== 'object') return [];
        const details = Array.isArray(tweetObj.mediaDetails) ? tweetObj.mediaDetails : [];
        const media = [];

        if (details.length > 0) {
            for (const m of details.slice(0, 4)) {
                if (!m || typeof m !== 'object') continue;
                if (m.type === 'video' || m.type === 'animated_gif') {
                    const variants = Array.isArray(m.video_info?.variants)
                        ? m.video_info.variants.filter(v => v && v.content_type === 'video/mp4' && v.url)
                        : [];
                    variants.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
                    const bestMp4 = variants[0]?.url || '';
                    const poster = m.media_url_https || '';
                    if (poster || bestMp4) {
                        media.push({
                            type: m.type,
                            url: poster || bestMp4,
                            posterUrl: poster,
                            videoUrl: bestMp4
                        });
                    }
                } else {
                    const photoUrl = m.media_url_https || m.url || '';
                    if (photoUrl) {
                        media.push({
                            type: 'photo',
                            url: photoUrl,
                            posterUrl: '',
                            videoUrl: ''
                        });
                    }
                }
            }
        } else if (Array.isArray(tweetObj.photos)) {
            for (const p of tweetObj.photos.slice(0, 4)) {
                if (p && p.url) {
                    media.push({
                        type: 'photo',
                        url: p.url,
                        posterUrl: '',
                        videoUrl: ''
                    });
                }
            }
        }

        return media;
    }

    parseSyndicationTweet(tweetId, data) {
        const id = String(tweetId || '').trim();
        if (!this.isValidRecentTweetId(id)) return null;

        if (!data || typeof data !== 'object' || data.__typename === 'TweetTombstone' || (!data.user && !data.text)) {
            return this.sanitizeTweetMeta(id, {
                isUnavailable: true,
                isHydrated: true,
                updatedAt: Date.now()
            });
        }

        const user = data.user || {};
        const screenName = user.screen_name || '';
        const authorName = user.name || screenName || '';
        const avatarUrl = (user.profile_image_url_https || '').replace('_normal.', '_bigger.');
        const isVerified = Boolean(user.is_blue_verified || user.verified || user.verified_type);
        const inReplyToScreenName = data.in_reply_to_screen_name || '';
        const quotedId = data.quoted_tweet?.id_str || '';
        const text = this.cleanSyndicationText(data.text || '', data.entities, quotedId, data.display_text_range);
        const media = this.extractSyndicationMedia(data);

        let quotedTweet = null;
        if (data.quoted_tweet && typeof data.quoted_tweet === 'object' && data.quoted_tweet.user) {
            const q = data.quoted_tweet;
            const qUser = q.user || {};
            quotedTweet = {
                id: q.id_str || '',
                screenName: qUser.screen_name || '',
                authorName: qUser.name || qUser.screen_name || '',
                avatarUrl: (qUser.profile_image_url_https || '').replace('_normal.', '_bigger.'),
                isVerified: Boolean(qUser.is_blue_verified || qUser.verified || qUser.verified_type),
                createdAt: q.created_at || null,
                inReplyToScreenName: q.in_reply_to_screen_name || '',
                text: this.cleanSyndicationText(q.text || '', q.entities, '', q.display_text_range),
                media: this.extractSyndicationMedia(q)
            };
        }

        let parentTweet = null;
        if (data.parent && typeof data.parent === 'object' && data.parent.user) {
            const p = data.parent;
            const pUser = p.user || {};
            parentTweet = {
                id: p.id_str || '',
                screenName: pUser.screen_name || '',
                authorName: pUser.name || pUser.screen_name || '',
                avatarUrl: (pUser.profile_image_url_https || '').replace('_normal.', '_bigger.'),
                isVerified: Boolean(pUser.is_blue_verified || pUser.verified || pUser.verified_type),
                createdAt: p.created_at || null,
                inReplyToScreenName: p.in_reply_to_screen_name || '',
                text: this.cleanSyndicationText(p.text || '', p.entities, '', p.display_text_range),
                media: this.extractSyndicationMedia(p)
            };
        }

        return this.sanitizeTweetMeta(id, {
            screenName,
            authorName,
            avatarUrl,
            isVerified,
            inReplyToScreenName,
            text,
            media,
            quotedTweet,
            parentTweet,
            createdAt: data.created_at || null,
            favoriteCount: typeof data.favorite_count === 'number' ? data.favorite_count : 0,
            replyCount: typeof data.conversation_count === 'number' ? data.conversation_count : 0,
            isHydrated: true,
            hydrationVersion: 4,
            permalink: screenName ? `https://x.com/${screenName}/status/${id}` : `https://x.com/i/status/${id}`,
            updatedAt: Date.now()
        });
    }

    needsTweetHydration(tweetId) {
        const meta = this.state.postMetaMap[tweetId];
        if (!meta) return true;
        if (meta.isUnavailable) return false;
        if (!meta.isHydrated || meta.hydrationVersion !== 4) return true;
        return false;
    }

    async hydrateTweets(tweetIds = []) {
        await this.init();
        if (!Array.isArray(tweetIds) || tweetIds.length === 0 || typeof this.fetchFn !== 'function') {
            return { hydrated: {} };
        }

        const uniqueIds = Array.from(new Set(
            tweetIds
                .map(id => String(id || '').trim())
                .filter(id => this.isValidRecentTweetId(id))
        )).slice(0, 25);

        const nowMs = Date.now();
        const toFetch = uniqueIds.filter(id => {
            if (!this.needsTweetHydration(id)) return false;
            const cooldownUntil = this.failedHydrationUntil.get(id);
            if (cooldownUntil && nowMs < cooldownUntil) return false;
            return true;
        });
        let changed = false;

        const fetchOne = async (id) => {
            if (this.inflightHydrations.has(id)) {
                return this.inflightHydrations.get(id);
            }
            const promise = (async () => {
                try {
                    const url = `https://cdn.syndication.twimg.com/tweet-result?id=${encodeURIComponent(id)}&token=x`;
                    const resp = await this.fetchFn(url, { credentials: 'omit' });
                    if (resp && resp.status === 404) {
                        this.failedHydrationUntil.delete(id);
                        const meta = this.parseSyndicationTweet(id, null);
                        if (meta) {
                            this.state.postMetaMap[id] = meta;
                            changed = true;
                        }
                        return;
                    }
                    if (!resp || !resp.ok) {
                        this.failedHydrationUntil.set(id, Date.now() + 5 * 60 * 1000);
                        return;
                    }
                    const data = await resp.json();
                    const meta = this.parseSyndicationTweet(id, data);
                    if (meta) {
                        this.failedHydrationUntil.delete(id);
                        this.state.postMetaMap[id] = meta;
                        changed = true;
                    }
                } catch (err) {
                    this.failedHydrationUntil.set(id, Date.now() + 5 * 60 * 1000);
                } finally {
                    this.inflightHydrations.delete(id);
                }
            })();

            this.inflightHydrations.set(id, promise);
            return promise;
        };

        // Run with bounded concurrency of 6
        const concurrency = 6;
        for (let i = 0; i < toFetch.length; i += concurrency) {
            const chunk = toFetch.slice(i, i + concurrency);
            await Promise.allSettled(chunk.map(id => fetchOne(id)));
        }

        if (changed) {
            await this.saveState();
        }

        const hydrated = {};
        for (const id of uniqueIds) {
            if (this.state.postMetaMap[id]) {
                hydrated[id] = this.state.postMetaMap[id];
            }
        }

        return { hydrated };
    }

    pruneMySeenIds() {
        const now = Date.now();
        const maxAgeMs = FRIEND_SYNC_CONFIG.MAX_AGE_MS || (14 * 24 * 60 * 60 * 1000);
        const maxSeenCap = FRIEND_SYNC_CONFIG.MAX_SEEN_IDS || 1000;
        const maxForcedCap = FRIEND_SYNC_CONFIG.MAX_FORCED_IDS || 100;
        const maxCommentsPerTweet = FRIEND_SYNC_CONFIG.MAX_COMMENTS_PER_TWEET || 25;
        const maxTotalMyComments = FRIEND_SYNC_CONFIG.MAX_TOTAL_MY_COMMENTS || 200;
        const maxTombstoneCap = FRIEND_SYNC_CONFIG.MAX_TOMBSTONE_ENTRIES || 200;
        const maxDismissedCap = FRIEND_SYNC_CONFIG.MAX_DISMISSED_IDS || 1000;

        // 1. Cap mySeenIds (1,000 rolling window)
        const combinedSeen = new Set([
            ...(Array.isArray(this.state.mySeenIds) ? this.state.mySeenIds : []),
            ...(this.mySeenSet instanceof Set ? Array.from(this.mySeenSet) : [])
        ]);
        const valid = Array.from(combinedSeen).filter(id => this.isValidRecentTweetId(id));
        const capped = valid.slice(-maxSeenCap);
        this.state.mySeenIds = capped;
        this.mySeenSet = new Set(capped);

        // 2. Prune & cap myForcedMap (14-day TTL + 100 cap)
        if (this.state.myForcedMap && typeof this.state.myForcedMap === 'object') {
            const forcedEntries = Object.values(this.state.myForcedMap)
                .filter(item => {
                    if (!item || !this.isValidRecentTweetId(item.id)) return false;
                    const fAt = Number(item.forcedAt) || 0;
                    if (fAt > 0 && fAt <= now && (now - fAt) > maxAgeMs) return false;
                    return true;
                })
                .sort((a, b) => (a.forcedAt || 0) - (b.forcedAt || 0))
                .slice(-maxForcedCap);
            this.state.myForcedMap = {};
            for (const entry of forcedEntries) {
                this.state.myForcedMap[entry.id] = entry;
            }
        } else {
            this.state.myForcedMap = {};
        }

        // 3. Prune & cap friendSeenMap and friendForcedMap per friend (before dismissed/notified so active forced IDs are never evicted)
        if (this.state.friendSeenMap && typeof this.state.friendSeenMap === 'object') {
            for (const [fEmail, list] of Object.entries(this.state.friendSeenMap)) {
                if (Array.isArray(list)) {
                    this.state.friendSeenMap[fEmail] = list
                        .filter(id => this.isValidRecentTweetId(id))
                        .slice(-maxSeenCap);
                }
            }
        }
        const activeFriendForcedIds = new Set();
        if (this.state.friendForcedMap && typeof this.state.friendForcedMap === 'object') {
            for (const [fEmail, list] of Object.entries(this.state.friendForcedMap)) {
                if (Array.isArray(list)) {
                    const filteredForced = list
                        .filter(item => {
                            const fid = typeof item === 'string' ? item : item?.id;
                            if (!this.isValidRecentTweetId(fid)) return false;
                            const fAt = typeof item === 'object' ? (Number(item?.forcedAt) || 0) : 0;
                            if (fAt > 0 && fAt <= now && (now - fAt) > maxAgeMs) return false;
                            return true;
                        })
                        .slice(-maxForcedCap);
                    this.state.friendForcedMap[fEmail] = filteredForced;
                    for (const item of filteredForced) {
                        const fid = typeof item === 'string' ? item : item?.id;
                        if (fid) activeFriendForcedIds.add(fid);
                    }
                }
            }
        }

        const activeForcedCircleIds = new Set([
            ...Object.keys(this.state.myForcedMap || {}),
            ...activeFriendForcedIds
        ]);

        // 3b. Prune & cap deletedCommentsMap, myForcedCommentsMap, and friendCommentsMap
        if (this.state.deletedCommentsMap && typeof this.state.deletedCommentsMap === 'object') {
            const deletedEntries = Object.entries(this.state.deletedCommentsMap)
                .filter(([cid, ts]) => {
                    if (!cid) return false;
                    const t = Number(ts) || 0;
                    return !(t > 0 && t <= now && (now - t) > maxAgeMs);
                })
                .sort((a, b) => (Number(a[1]) || 0) - (Number(b[1]) || 0))
                .slice(-maxTombstoneCap);
            this.state.deletedCommentsMap = Object.fromEntries(deletedEntries);
        } else {
            this.state.deletedCommentsMap = {};
        }

        const nextMyComments = {};
        const flatMyComments = [];
        if (this.state.myForcedCommentsMap && typeof this.state.myForcedCommentsMap === 'object') {
            for (const [rawTid, rawList] of Object.entries(this.state.myForcedCommentsMap)) {
                const tid = String(rawTid || '').trim();
                if (!this.isValidRecentTweetId(tid) || !Array.isArray(rawList)) continue;
                const isPinnedForced = activeForcedCircleIds.has(tid);
                const byId = new Map();
                for (const rawC of rawList) {
                    const cleanC = this.sanitizeForceCommentEntry(rawC, now);
                    if (!cleanC) continue;
                    if (this.state.deletedCommentsMap[cleanC.id]) continue;
                    if (!isPinnedForced && cleanC.createdAt > 0 && cleanC.createdAt <= now && (now - cleanC.createdAt) > maxAgeMs) {
                        continue;
                    }
                    const prev = byId.get(cleanC.id);
                    if (!prev || cleanC.createdAt >= prev.createdAt) {
                        byId.set(cleanC.id, cleanC);
                    }
                }
                const sorted = Array.from(byId.values())
                    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0) || String(a.id).localeCompare(String(b.id)))
                    .slice(-maxCommentsPerTweet);
                for (const entry of sorted) {
                    flatMyComments.push({ tid, entry });
                }
            }
        }
        if (flatMyComments.length > maxTotalMyComments) {
            flatMyComments.sort((a, b) => (a.entry.createdAt || 0) - (b.entry.createdAt || 0));
            const keptFlat = flatMyComments.slice(-maxTotalMyComments);
            for (const { tid, entry } of keptFlat) {
                if (!nextMyComments[tid]) nextMyComments[tid] = [];
                nextMyComments[tid].push(entry);
            }
        } else {
            for (const { tid, entry } of flatMyComments) {
                if (!nextMyComments[tid]) nextMyComments[tid] = [];
                nextMyComments[tid].push(entry);
            }
        }
        for (const tid of Object.keys(nextMyComments)) {
            nextMyComments[tid].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0) || String(a.id).localeCompare(String(b.id)));
        }
        this.state.myForcedCommentsMap = nextMyComments;

        const activeFriendCommentIds = new Set();
        if (this.state.friendCommentsMap && typeof this.state.friendCommentsMap === 'object') {
            const cleanedFriendComments = {};
            for (const [fEmail, tweetMap] of Object.entries(this.state.friendCommentsMap)) {
                if (!tweetMap || typeof tweetMap !== 'object') continue;
                const cleanedTweetMap = {};
                for (const [rawTid, rawList] of Object.entries(tweetMap)) {
                    const tid = String(rawTid || '').trim();
                    if (!this.isValidRecentTweetId(tid) || !Array.isArray(rawList)) continue;
                    const isPinnedForced = activeForcedCircleIds.has(tid);
                    const byId = new Map();
                    for (const rawC of rawList) {
                        const cleanC = this.sanitizeForceCommentEntry(rawC, now);
                        if (!cleanC) continue;
                        if (!isPinnedForced && cleanC.createdAt > 0 && cleanC.createdAt <= now && (now - cleanC.createdAt) > maxAgeMs) {
                            continue;
                        }
                        const prev = byId.get(cleanC.id);
                        if (!prev || cleanC.createdAt >= prev.createdAt) {
                            byId.set(cleanC.id, cleanC);
                        }
                    }
                    const sorted = Array.from(byId.values())
                        .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0) || String(a.id).localeCompare(String(b.id)))
                        .slice(-maxCommentsPerTweet);
                    if (sorted.length > 0) {
                        cleanedTweetMap[tid] = sorted;
                        for (const entry of sorted) {
                            activeFriendCommentIds.add(entry.id);
                        }
                    }
                }
                cleanedFriendComments[fEmail] = cleanedTweetMap;
            }
            this.state.friendCommentsMap = cleanedFriendComments;
        } else {
            this.state.friendCommentsMap = {};
        }

        // 4. Cap dismissedForcedIds, notifiedForcedIds, dismissedCommentIds, notifiedCommentIds & notifiedInviteEmails
        // Always preserve IDs still present in any friend's active friendForcedMap / friendCommentsMap so dismissed items never resurrect.
        const capWithActivePriority = (stateArr, memSet, activeSet = activeFriendForcedIds, validateFn = (id) => this.isValidRecentTweetId(id)) => {
            const combined = new Set([
                ...(Array.isArray(stateArr) ? stateArr : []),
                ...(memSet instanceof Set ? Array.from(memSet) : [])
            ]);
            const inactive = [];
            const active = [];
            for (const id of combined) {
                if (!validateFn(id)) continue;
                if (activeSet.has(id)) {
                    active.push(id);
                } else {
                    inactive.push(id);
                }
            }
            const keepCount = Math.max(maxDismissedCap, active.length);
            return [...inactive, ...active].slice(-keepCount);
        };

        const validDismissed = capWithActivePriority(this.state.dismissedForcedIds, this.dismissedForcedSet);
        this.state.dismissedForcedIds = validDismissed;
        this.dismissedForcedSet = new Set(validDismissed);

        const validNotifiedForced = capWithActivePriority(this.state.notifiedForcedIds, this.notifiedForcedSet);
        this.state.notifiedForcedIds = validNotifiedForced;
        this.notifiedForcedSet = new Set(validNotifiedForced);

        const isValidCommentId = (cid) => typeof cid === 'string' && cid.trim().length > 0;
        const validDismissedComments = capWithActivePriority(this.state.dismissedCommentIds, this.dismissedCommentSet, activeFriendCommentIds, isValidCommentId);
        this.state.dismissedCommentIds = validDismissedComments;
        this.dismissedCommentSet = new Set(validDismissedComments);

        const validNotifiedComments = capWithActivePriority(this.state.notifiedCommentIds, this.notifiedCommentSet, activeFriendCommentIds, isValidCommentId);
        this.state.notifiedCommentIds = validNotifiedComments;
        this.notifiedCommentSet = new Set(validNotifiedComments);

        const combinedNotifiedInvites = new Set([
            ...(Array.isArray(this.state.notifiedInviteEmails) ? this.state.notifiedInviteEmails : []),
            ...(this.notifiedInviteSet instanceof Set ? Array.from(this.notifiedInviteSet) : [])
        ]);
        const validNotifiedInvites = Array.from(combinedNotifiedInvites)
            .filter(e => typeof e === 'string' && e.trim().length > 0)
            .slice(-maxTombstoneCap);
        this.state.notifiedInviteEmails = validNotifiedInvites;
        this.notifiedInviteSet = new Set(validNotifiedInvites);

        // 5. Prune & cap unforcedMap and removedFriends tombstones (14-day TTL + 200 cap)
        if (this.state.unforcedMap && typeof this.state.unforcedMap === 'object') {
            const unforcedEntries = Object.entries(this.state.unforcedMap)
                .filter(([tid, ts]) => {
                    if (!this.isValidRecentTweetId(tid)) return false;
                    const t = Number(ts) || 0;
                    return !(t > 0 && t <= now && (now - t) > maxAgeMs);
                })
                .sort((a, b) => (Number(a[1]) || 0) - (Number(b[1]) || 0))
                .slice(-maxTombstoneCap);
            this.state.unforcedMap = Object.fromEntries(unforcedEntries);
        } else {
            this.state.unforcedMap = {};
        }

        if (this.state.removedFriends && typeof this.state.removedFriends === 'object') {
            const removedEntries = Object.entries(this.state.removedFriends)
                .filter(([email, ts]) => {
                    if (!email) return false;
                    const t = Number(ts) || 0;
                    return !(t > 0 && t <= now && (now - t) > maxAgeMs);
                })
                .sort((a, b) => (Number(a[1]) || 0) - (Number(b[1]) || 0))
                .slice(-maxTombstoneCap);
            this.state.removedFriends = Object.fromEntries(removedEntries);
        } else {
            this.state.removedFriends = {};
        }

        // 6. Prune & cap postMetaMap locally (250 LRU cap + 14-day TTL) while preserving forced posts
        const maxLocalMeta = FRIEND_SYNC_CONFIG.MAX_LOCAL_POST_META || 250;
        if (this.state.postMetaMap && typeof this.state.postMetaMap === 'object') {
            const allMeta = Object.values(this.state.postMetaMap).filter(m => {
                if (!m || !this.isValidRecentTweetId(m.id)) return false;
                const isPinnedForced = Boolean(this.state.myForcedMap[m.id] || activeFriendForcedIds.has(m.id));
                if (isPinnedForced) return true;
                const uAt = Number(m.updatedAt) || 0;
                if (uAt > 0 && uAt <= now && (now - uAt) > maxAgeMs) return false;
                return true;
            });

            if (allMeta.length > maxLocalMeta) {
                allMeta.sort((a, b) => {
                    const aForced = Boolean(this.state.myForcedMap[a.id] || activeFriendForcedIds.has(a.id));
                    const bForced = Boolean(this.state.myForcedMap[b.id] || activeFriendForcedIds.has(b.id));
                    if (aForced !== bForced) return aForced ? 1 : -1;
                    return (a.updatedAt || 0) - (b.updatedAt || 0);
                });
            }
            const keptMeta = allMeta.slice(-maxLocalMeta);
            this.state.postMetaMap = {};
            for (const m of keptMeta) {
                this.state.postMetaMap[m.id] = m;
            }
        } else {
            this.state.postMetaMap = {};
        }
    }

    rebuildIndex() {
        this.tweetToFriendsMap.clear();
        this.tweetToForcedByMap.clear();
        this.tweetToCommentsMap.clear();

        for (const [email, friend] of Object.entries(this.state.friends)) {
            if (friend.status !== 'connected') continue;
            const seenList = this.state.friendSeenMap[email] || [];
            const forcedList = this.state.friendForcedMap[email] || [];
            const label = friend.displayName && friend.displayName !== email
                ? `${friend.displayName} (${email})`
                : email;

            const addSeen = (tweetId) => {
                let list = this.tweetToFriendsMap.get(tweetId);
                if (!list) {
                    list = [];
                    this.tweetToFriendsMap.set(tweetId, list);
                }
                if (!list.includes(label)) {
                    list.push(label);
                }
            };

            for (const tweetId of seenList) {
                addSeen(tweetId);
            }

            for (const forcedItem of forcedList) {
                const tweetId = typeof forcedItem === 'string' ? forcedItem : forcedItem?.id;
                if (!tweetId) continue;
                addSeen(tweetId);

                let forcedByList = this.tweetToForcedByMap.get(tweetId);
                if (!forcedByList) {
                    forcedByList = [];
                    this.tweetToForcedByMap.set(tweetId, forcedByList);
                }
                if (!forcedByList.some(f => f.email === email)) {
                    forcedByList.push({
                        email,
                        label,
                        forcedAt: forcedItem?.forcedAt || 0
                    });
                }
            }
        }

        // Build chronological comment threads strictly scoped to posts in our active forced circle
        const activeForcedCircleIds = new Set([
            ...Object.keys(this.state.myForcedMap || {}),
            ...this.tweetToForcedByMap.keys()
        ]);
        const myEmail = this.state.identity?.email || 'me';
        const myDisplayName = this.state.identity?.displayName;
        const myLabel = myDisplayName ? `${myDisplayName} (You)` : 'You';

        for (const tweetId of activeForcedCircleIds) {
            const byId = new Map();
            const myList = (this.state.myForcedCommentsMap && Array.isArray(this.state.myForcedCommentsMap[tweetId]))
                ? this.state.myForcedCommentsMap[tweetId]
                : [];
            for (const rawC of myList) {
                const cleanC = this.sanitizeForceCommentEntry(rawC);
                if (!cleanC || (this.state.deletedCommentsMap && this.state.deletedCommentsMap[cleanC.id])) continue;
                byId.set(cleanC.id, {
                    id: cleanC.id,
                    tweetId,
                    text: cleanC.text,
                    createdAt: cleanC.createdAt,
                    authorEmail: myEmail,
                    authorName: 'You',
                    authorLabel: myLabel,
                    isMe: true
                });
            }

            for (const [email, friend] of Object.entries(this.state.friends)) {
                if (friend.status !== 'connected') continue;
                const fList = this.state.friendCommentsMap?.[email]?.[tweetId];
                if (!Array.isArray(fList)) continue;
                const fDisplay = friend.displayName || email;
                const fLabel = friend.displayName && friend.displayName !== email
                    ? `${friend.displayName} (${email})`
                    : email;
                for (const rawC of fList) {
                    const cleanC = this.sanitizeForceCommentEntry(rawC);
                    if (!cleanC) continue;
                    const existing = byId.get(cleanC.id);
                    if (!existing || cleanC.createdAt >= existing.createdAt) {
                        byId.set(cleanC.id, {
                            id: cleanC.id,
                            tweetId,
                            text: cleanC.text,
                            createdAt: cleanC.createdAt,
                            authorEmail: email,
                            authorName: fDisplay,
                            authorLabel: fLabel,
                            isMe: false
                        });
                    }
                }
            }

            if (byId.size > 0) {
                const sorted = Array.from(byId.values()).sort(
                    (a, b) => (a.createdAt || 0) - (b.createdAt || 0) || String(a.id).localeCompare(String(b.id))
                );
                this.tweetToCommentsMap.set(tweetId, sorted);
            }
        }
    }

    getCommentsForTweet(tweetId) {
        const id = String(tweetId || '').trim();
        return id ? (this.tweetToCommentsMap.get(id) || []) : [];
    }

    dismissCommentsForTweet(tweetId) {
        const id = String(tweetId || '').trim();
        if (!id) return [];
        const comments = this.tweetToCommentsMap.get(id) || [];
        const dismissedIds = [];
        for (const c of comments) {
            if (!c.isMe && c.id) {
                this.dismissedCommentSet.add(c.id);
                this.notifiedCommentSet.add(c.id);
                dismissedIds.push(c.id);
            }
        }
        return dismissedIds;
    }

    getPublicState() {
        const friendsArray = Object.values(this.state.friends).map(f => ({
            email: f.email,
            displayName: f.displayName || f.email,
            status: f.status,
            addedAt: f.addedAt,
            lastSyncedAt: f.lastSyncedAt || null,
            seenCount: (this.state.friendSeenMap[f.email] || []).length
        }));
        const pendingIncomingCount = friendsArray.filter(f => f.status === 'pending_incoming').length;

        return {
            identity: this.state.identity ? {
                email: this.state.identity.email,
                displayName: this.state.identity.displayName || this.state.identity.email,
                pubkeyHex: this.state.identity.pubkeyHex
            } : null,
            friends: friendsArray,
            pendingIncomingCount,
            mySeenCount: this.mySeenSet.size,
            lastSyncTime: this.lastSyncTime,
            selfSyncLastSyncedAt: this.state.selfSyncLastSyncedAt || null,
            isSyncing: this.isSyncing
        };
    }

    async setIdentity(email, displayName = '', passphrase = '') {
        await this.init();
        const normEmail = normalizeIdentifier(email);
        if (!normEmail || normEmail.length < 3) {
            throw new Error('Please enter a valid email or alias (min 3 characters).');
        }

        const cleanName = (displayName || '').trim() || normEmail.split('@')[0];
        const existing = this.state.identity;

        if (existing && existing.email === normEmail) {
            existing.displayName = cleanName;
            if (passphrase !== undefined) existing.passphrase = passphrase;
        } else {
            const privKeyHex = existing?.privKeyHex || generateSecretKeyHex();
            const pubkeyHex = getPublicKeyHex(privKeyHex);
            const seenFeedKeyHex = existing?.seenFeedKeyHex || generateRandomBytesHex(32);
            const nowMs = Date.now();

            this.state.identity = {
                email: normEmail,
                displayName: cleanName,
                privKeyHex,
                pubkeyHex,
                seenFeedKeyHex,
                identityCreatedAt: existing?.identityCreatedAt || nowMs,
                feedKeyUpdatedAt: existing?.feedKeyUpdatedAt || nowMs,
                passphrase: passphrase || ''
            };
        }

        // Pull any existing self-sync snapshot from relays for this email so a second device
        // or reinstalled client automatically adopts the canonical keypair, friends, seen/forced posts, and preferences.
        await this.pullSelfSyncFromRelays(normEmail, passphrase || '', {
            adoptIdentityKeys: true,
            explicitDisplayName: Boolean((displayName || '').trim()) ? cleanName : ''
        }).catch(() => {});

        await this.saveState();
        // Publish seen snapshot, self-sync snapshot, and re-announce handshakes for any existing friends
        await this.publishAllHandshakes().catch(() => {});
        await this.publishMySeenSnapshot().catch(() => {});
        await this.syncWithRelays().catch(() => {});
        return this.getPublicState();
    }

    async addFriend(friendEmail, friendDisplayName = '') {
        await this.init();
        if (!this.state.identity) {
            throw new Error('Set your own email/alias first before adding friends.');
        }

        const normFriend = normalizeIdentifier(friendEmail);
        if (!normFriend || normFriend.length < 3) {
            throw new Error('Please enter a valid friend email or alias.');
        }
        if (normFriend === this.state.identity.email) {
            throw new Error('You cannot add yourself as a friend.');
        }

        const existing = this.state.friends[normFriend];
        if (existing && existing.status === 'pending_incoming') {
            // Mutual match! Accept immediately
            return this.acceptFriend(normFriend);
        }

        if (this.state.removedFriends && this.state.removedFriends[normFriend]) {
            delete this.state.removedFriends[normFriend];
        }

        this.state.friends[normFriend] = {
            email: normFriend,
            displayName: (friendDisplayName || '').trim() || existing?.displayName || normFriend,
            status: existing?.status === 'connected' ? 'connected' : 'pending_outgoing',
            pubkeyHex: existing?.pubkeyHex || null,
            seenFeedKeyHex: existing?.seenFeedKeyHex || null,
            addedAt: Date.now(),
            lastSyncedAt: existing?.lastSyncedAt || null,
            seenCount: (this.state.friendSeenMap[normFriend] || []).length
        };

        await this.saveState();
        await this.publishHandshakeForFriend(normFriend).catch(() => {});
        await this.publishSelfSyncSnapshot().catch(() => {});
        await this.syncWithRelays().catch(() => {});
        return this.getPublicState();
    }

    async acceptFriend(friendEmail) {
        await this.init();
        if (!this.state.identity) {
            throw new Error('Identity not configured.');
        }

        const normFriend = normalizeIdentifier(friendEmail);
        const friend = this.state.friends[normFriend];
        if (!friend) {
            throw new Error('Friend request not found.');
        }

        friend.status = friend.pubkeyHex && friend.seenFeedKeyHex ? 'connected' : 'pending_outgoing';
        await this.saveState();

        await this.publishHandshakeForFriend(normFriend).catch(() => {});
        await this.publishMySeenSnapshot().catch(() => {});
        await this.syncWithRelays().catch(() => {});
        return this.getPublicState();
    }

    async removeFriend(friendEmail) {
        await this.init();
        const normFriend = normalizeIdentifier(friendEmail);
        const wasConnected = this.state.friends[normFriend]?.status === 'connected';

        if (!this.state.removedFriends) this.state.removedFriends = {};
        this.state.removedFriends[normFriend] = Date.now();

        delete this.state.friends[normFriend];
        delete this.state.friendSeenMap[normFriend];
        delete this.state.friendForcedMap[normFriend];
        if (this.state.friendCommentsMap) {
            delete this.state.friendCommentsMap[normFriend];
        }
        this.rebuildIndex();

        if (wasConnected && this.state.identity) {
            // Rotate feed key so removed friend can no longer decrypt future snapshots
            this.state.identity.seenFeedKeyHex = generateRandomBytesHex(32);
            this.state.identity.feedKeyUpdatedAt = Date.now();
            await this.saveState();
            await this.publishAllHandshakes().catch(() => {});
            await this.publishMySeenSnapshot().catch(() => {});
        } else {
            await this.saveState();
            await this.publishSelfSyncSnapshot().catch(() => {});
        }

        return this.getPublicState();
    }

    async markTweetsSeen(tweetIds, tweetMetaMap = {}) {
        await this.init();
        if (!Array.isArray(tweetIds) || tweetIds.length === 0) return { added: 0 };

        let added = 0;
        let metaUpdated = 0;
        const now = Date.now();
        for (const rawId of tweetIds) {
            const id = String(rawId).trim();
            if (!this.isValidRecentTweetId(id, now)) continue;

            if (!this.mySeenSet.has(id)) {
                this.mySeenSet.add(id);
                added++;
            }

            if (tweetMetaMap && typeof tweetMetaMap === 'object' && tweetMetaMap[id]) {
                const prevMeta = this.state.postMetaMap[id];
                const sanitized = this.sanitizeTweetMeta(id, tweetMetaMap[id]);
                if (sanitized) {
                    const isMeaningfulUpdate = !prevMeta
                        || (!prevMeta.isHydrated && (
                            sanitized.isHydrated
                            || sanitized.text !== prevMeta.text
                            || sanitized.screenName !== prevMeta.screenName
                            || (sanitized.media?.length || 0) > (prevMeta.media?.length || 0)
                        ));
                    this.state.postMetaMap[id] = sanitized;
                    if (isMeaningfulUpdate) {
                        metaUpdated++;
                    }
                }
            }
        }

        if (added > 0 || metaUpdated > 0) {
            if (this.mySeenSet.size > FRIEND_SYNC_CONFIG.MAX_SEEN_IDS) {
                const arr = Array.from(this.mySeenSet).slice(-FRIEND_SYNC_CONFIG.MAX_SEEN_IDS);
                this.mySeenSet = new Set(arr);
            }
            this.state.hasUnpublishedSeen = true;
            await this.saveState();
            this.scheduleSnapshotFlush();
        }

        return { added, totalSeen: this.mySeenSet.size };
    }

    async forceTweetToFriends(tweetId, meta = null) {
        await this.init();
        const id = String(tweetId || '').trim();
        if (!this.isValidRecentTweetId(id)) {
            throw new Error('Invalid tweet ID.');
        }

        const now = Date.now();
        this.mySeenSet.add(id);
        if (this.state.unforcedMap && this.state.unforcedMap[id]) {
            delete this.state.unforcedMap[id];
        }
        this.state.myForcedMap[id] = {
            id,
            forcedAt: now
        };

        if (meta && typeof meta === 'object') {
            const sanitized = this.sanitizeTweetMeta(id, { ...meta, updatedAt: now });
            if (sanitized) {
                this.state.postMetaMap[id] = sanitized;
            }
        }

        this.state.hasUnpublishedSeen = true;
        this.pruneMySeenIds();
        this.rebuildIndex();
        await this.saveState();
        this.broadcastSeenUpdateToTabs();

        if (this.flushTimeout) {
            clearTimeout(this.flushTimeout);
            this.flushTimeout = null;
        }
        await this.publishMySeenSnapshot().catch(() => {});
        this.broadcastSeenUpdateToTabs();

        return {
            forced: true,
            tweetId: id,
            totalForced: Object.keys(this.state.myForcedMap).length,
            comments: this.getCommentsForTweet(id)
        };
    }

    async unforceTweet(tweetId) {
        await this.init();
        const id = String(tweetId || '').trim();
        if (!id) return { forced: false, tweetId: id, comments: [] };

        const hadForced = Boolean(this.state.myForcedMap && this.state.myForcedMap[id]);
        const hadMyComments = Boolean(
            this.state.myForcedCommentsMap &&
            Array.isArray(this.state.myForcedCommentsMap[id]) &&
            this.state.myForcedCommentsMap[id].length > 0
        );

        if (hadForced || hadMyComments) {
            const now = Date.now();
            if (hadForced) {
                delete this.state.myForcedMap[id];
                if (!this.state.unforcedMap) this.state.unforcedMap = {};
                this.state.unforcedMap[id] = now;
            }
            if (hadMyComments) {
                if (!this.state.deletedCommentsMap) this.state.deletedCommentsMap = {};
                for (const c of this.state.myForcedCommentsMap[id]) {
                    if (c && c.id) {
                        this.state.deletedCommentsMap[c.id] = now;
                    }
                }
                delete this.state.myForcedCommentsMap[id];
            }
            this.state.hasUnpublishedSeen = true;
            this.pruneMySeenIds();
            this.rebuildIndex();
            await this.saveState();
            this.broadcastSeenUpdateToTabs();

            if (this.flushTimeout) {
                clearTimeout(this.flushTimeout);
                this.flushTimeout = null;
            }
            await this.publishMySeenSnapshot().catch(() => {});
            this.broadcastSeenUpdateToTabs();
        }

        return {
            forced: false,
            tweetId: id,
            totalForced: Object.keys(this.state.myForcedMap || {}).length,
            comments: this.getCommentsForTweet(id)
        };
    }

    async addForceComment(tweetId, text, meta = null) {
        await this.init();
        const id = String(tweetId || '').trim();
        if (!this.isValidRecentTweetId(id)) {
            throw new Error('Invalid tweet ID.');
        }
        const cleanText = this.sanitizeForceCommentText(text);
        if (!cleanText) {
            throw new Error('Comment cannot be empty.');
        }

        const isForcedInCircle = Boolean(
            (this.state.myForcedMap && this.state.myForcedMap[id]) ||
            this.tweetToForcedByMap.has(id)
        );
        if (!isForcedInCircle) {
            throw new Error('Post must be forced before commenting.');
        }

        const now = Date.now();
        this.mySeenSet.add(id);
        if (meta && typeof meta === 'object') {
            const sanitized = this.sanitizeTweetMeta(id, { ...meta, updatedAt: now });
            if (sanitized) {
                this.state.postMetaMap[id] = sanitized;
            }
        }

        if (!this.state.myForcedCommentsMap || typeof this.state.myForcedCommentsMap !== 'object') {
            this.state.myForcedCommentsMap = {};
        }
        if (!Array.isArray(this.state.myForcedCommentsMap[id])) {
            this.state.myForcedCommentsMap[id] = [];
        }

        const commentEntry = {
            id: `c_${now}_${generateRandomBytesHex(4)}`,
            text: cleanText,
            createdAt: now
        };
        this.state.myForcedCommentsMap[id].push(commentEntry);

        this.state.hasUnpublishedSeen = true;
        this.pruneMySeenIds();
        this.rebuildIndex();
        await this.saveState();
        this.broadcastSeenUpdateToTabs();

        if (this.flushTimeout) {
            clearTimeout(this.flushTimeout);
            this.flushTimeout = null;
        }
        await this.publishMySeenSnapshot().catch(() => {});
        this.broadcastSeenUpdateToTabs();

        const comments = this.getCommentsForTweet(id);
        const enriched = comments.find(c => c.id === commentEntry.id) || {
            ...commentEntry,
            tweetId: id,
            authorEmail: this.state.identity?.email || 'me',
            authorName: 'You',
            authorLabel: 'You',
            isMe: true
        };
        return {
            tweetId: id,
            comment: enriched,
            comments
        };
    }

    async deleteForceComment(tweetId, commentId) {
        await this.init();
        const id = String(tweetId || '').trim();
        const cid = String(commentId || '').trim();
        if (!this.isValidRecentTweetId(id) || !cid) {
            return { deleted: false, tweetId: id, commentId: cid, comments: this.getCommentsForTweet(id) };
        }

        const list = this.state.myForcedCommentsMap && Array.isArray(this.state.myForcedCommentsMap[id])
            ? this.state.myForcedCommentsMap[id]
            : [];
        const nextList = list.filter(c => c && c.id !== cid);
        const didRemove = nextList.length !== list.length;

        if (didRemove) {
            if (nextList.length > 0) {
                this.state.myForcedCommentsMap[id] = nextList;
            } else {
                delete this.state.myForcedCommentsMap[id];
            }
            if (!this.state.deletedCommentsMap || typeof this.state.deletedCommentsMap !== 'object') {
                this.state.deletedCommentsMap = {};
            }
            this.state.deletedCommentsMap[cid] = Date.now();
            this.state.hasUnpublishedSeen = true;
            this.pruneMySeenIds();
            this.rebuildIndex();
            await this.saveState();
            this.broadcastSeenUpdateToTabs();

            if (this.flushTimeout) {
                clearTimeout(this.flushTimeout);
                this.flushTimeout = null;
            }
            await this.publishMySeenSnapshot().catch(() => {});
            this.broadcastSeenUpdateToTabs();
        }

        return {
            deleted: didRemove,
            tweetId: id,
            commentId: cid,
            comments: this.getCommentsForTweet(id)
        };
    }

    async dismissForcedTweet(tweetId) {
        await this.init();
        if (Array.isArray(tweetId)) {
            const validIds = tweetId.map(id => String(id || '').trim()).filter(id => this.isValidRecentTweetId(id));
            if (validIds.length === 0) return { dismissed: false };
            const dismissedCommentIdsMap = {};
            for (const id of validIds) {
                this.dismissedForcedSet.add(id);
                this.mySeenSet.add(id);
                const cIds = this.dismissCommentsForTweet(id);
                if (cIds.length > 0) {
                    dismissedCommentIdsMap[id] = cIds;
                }
            }
            this.state.hasUnpublishedSeen = true;
            this.scheduleSnapshotFlush();
            await this.saveState();
            this.broadcastDismissUpdateToTabs(validIds, dismissedCommentIdsMap);
            return { dismissed: true, tweetId: validIds[0], tweetIds: validIds, dismissedCommentIdsMap };
        }

        const id = String(tweetId || '').trim();
        if (!this.isValidRecentTweetId(id)) return { dismissed: false };

        this.dismissedForcedSet.add(id);
        this.mySeenSet.add(id);
        const dismissedCommentIds = this.dismissCommentsForTweet(id);
        const dismissedCommentIdsMap = dismissedCommentIds.length > 0 ? { [id]: dismissedCommentIds } : {};
        this.state.hasUnpublishedSeen = true;
        this.scheduleSnapshotFlush();
        await this.saveState();
        this.broadcastDismissUpdateToTabs(id, dismissedCommentIdsMap);

        return { dismissed: true, tweetId: id, dismissedCommentIds };
    }

    checkTweetsSeen(tweetIds) {
        if (!Array.isArray(tweetIds) || tweetIds.length === 0) return {};
        const results = {};
        for (const rawId of tweetIds) {
            const id = String(rawId).trim();
            const seenBy = this.tweetToFriendsMap.get(id);
            if (seenBy && seenBy.length > 0) {
                results[id] = seenBy;
            }
        }
        return results;
    }

    checkTweetsSyncStatus(tweetIds) {
        if (!Array.isArray(tweetIds) || tweetIds.length === 0) {
            return { seenMap: {}, forcedMap: {}, myForcedIds: [], commentsMap: {} };
        }
        const seenMap = {};
        const forcedMap = {};
        const myForcedIds = [];
        const commentsMap = {};

        for (const rawId of tweetIds) {
            const id = String(rawId).trim();
            const seenBy = this.tweetToFriendsMap.get(id);
            if (seenBy && seenBy.length > 0) {
                seenMap[id] = seenBy;
            }
            const forcedByEntries = this.tweetToForcedByMap.get(id);
            if (forcedByEntries && forcedByEntries.length > 0) {
                forcedMap[id] = forcedByEntries.map(e => (typeof e === 'object' && e ? (e.label || e.email || e.displayName) : e));
            }
            if (this.state.myForcedMap && this.state.myForcedMap[id]) {
                myForcedIds.push(id);
            }
            const comments = this.tweetToCommentsMap.get(id);
            if (comments && comments.length > 0) {
                commentsMap[id] = comments;
            }
        }

        return { seenMap, forcedMap, myForcedIds, commentsMap };
    }

    getFriendsTimelineData() {
        const allIds = new Set();
        for (const id of this.tweetToFriendsMap.keys()) {
            allIds.add(id);
        }
        for (const id of this.tweetToForcedByMap.keys()) {
            allIds.add(id);
        }
        for (const id of Object.keys(this.state.myForcedMap || {})) {
            if (this.isValidRecentTweetId(id)) {
                allIds.add(id);
            }
        }

        const timelinePosts = [];
        const unseenForcedPosts = [];

        for (const tweetId of allIds) {
            const meta = this.state.postMetaMap[tweetId] || null;
            const seenBy = this.tweetToFriendsMap.get(tweetId) || [];
            const forcedEntries = this.tweetToForcedByMap.get(tweetId) || [];
            const forcedBy = forcedEntries.map(e => e.label);
            const myForcedObj = this.state.myForcedMap ? this.state.myForcedMap[tweetId] : null;
            const forcedByMe = Boolean(myForcedObj);
            const comments = this.tweetToCommentsMap.get(tweetId) || [];
            const friendComments = comments.filter(c => !c.isMe);
            const unreadFriendCommentIds = friendComments
                .filter(c => c.id && !this.dismissedCommentSet.has(c.id))
                .map(c => c.id);
            const hasUnreadFriendComments = unreadFriendCommentIds.length > 0;
            const friendCommentAuthors = Array.from(new Set(friendComments.map(c => c.authorName).filter(Boolean)));
            const latestFriendCommentAt = friendComments.reduce((max, c) => Math.max(max, c.createdAt || 0), 0);
            const latestMyCommentAt = comments.filter(c => c.isMe).reduce((max, c) => Math.max(max, c.createdAt || 0), 0);

            // Only treat a post as incoming-forced if at least one friend forced it to you
            const isForced = forcedBy.length > 0;
            // Posts forced ONLY by you (not seen, forced, or commented on by any friend) are kept for the "Sent" filter tab only
            const isSentOnly = forcedByMe && forcedBy.length === 0 && seenBy.length === 0 && friendComments.length === 0;
            if (meta && meta.isUnavailable && !isForced && !forcedByMe && friendComments.length === 0) {
                continue;
            }
            const myForcedAt = myForcedObj?.forcedAt || 0;
            const friendForcedAt = forcedEntries.reduce((max, e) => Math.max(max, e.forcedAt || 0), 0);
            const latestForcedAt = Math.max(friendForcedAt, latestFriendCommentAt) || myForcedAt || latestMyCommentAt;
            const isSeenByMe = this.mySeenSet.has(tweetId);
            const isDismissed = (isForced ? this.dismissedForcedSet.has(tweetId) : true) && !hasUnreadFriendComments;
            const snowflakeTimeMs = this.getSnowflakeTimestampMs(tweetId);
            const sortTimestamp = latestForcedAt || meta?.updatedAt || snowflakeTimeMs || 0;

            const postItem = {
                tweetId,
                seenBy,
                forcedBy,
                forcedByMe,
                isForced,
                isSentOnly,
                myForcedAt,
                latestForcedAt,
                latestFriendCommentAt,
                hasUnreadFriendComments,
                unreadFriendCommentIds,
                friendCommentAuthors,
                comments,
                isSeenByMe,
                isDismissed,
                snowflakeTimeMs,
                sortTimestamp,
                meta
            };

            timelinePosts.push(postItem);

            if (!isDismissed && (isForced || hasUnreadFriendComments)) {
                unseenForcedPosts.push(postItem);
            }
        }

        // Sort timeline posts: friends' forced/re-forced posts first (newest activity), then seen posts (newest snowflake / updatedAt)
        timelinePosts.sort((a, b) => {
            const aActive = a.isForced || a.hasUnreadFriendComments;
            const bActive = b.isForced || b.hasUnreadFriendComments;
            if (aActive !== bActive) return aActive ? -1 : 1;
            if (aActive && bActive && a.latestForcedAt !== b.latestForcedAt) {
                return b.latestForcedAt - a.latestForcedAt;
            }
            if (a.isSentOnly !== b.isSentOnly) return a.isSentOnly ? 1 : -1;
            if (a.snowflakeTimeMs !== b.snowflakeTimeMs) {
                return b.snowflakeTimeMs - a.snowflakeTimeMs;
            }
            return b.sortTimestamp - a.sortTimestamp;
        });

        const maxTimelineItems = FRIEND_SYNC_CONFIG.MAX_TIMELINE_ITEMS || 300;
        let cappedTimelinePosts = timelinePosts;
        if (timelinePosts.length > maxTimelineItems) {
            const pinnedOrSent = timelinePosts.filter(p => p.isForced || p.forcedByMe || p.hasUnreadFriendComments);
            const regularSeen = timelinePosts.filter(p => !p.isForced && !p.forcedByMe && !p.hasUnreadFriendComments);
            const remainingBudget = Math.max(0, maxTimelineItems - pinnedOrSent.length);
            cappedTimelinePosts = [
                ...pinnedOrSent.filter(p => !p.isSentOnly),
                ...regularSeen.slice(0, remainingBudget),
                ...pinnedOrSent.filter(p => p.isSentOnly)
            ];
        }

        unseenForcedPosts.sort((a, b) => (b.latestForcedAt || b.sortTimestamp) - (a.latestForcedAt || a.sortTimestamp));

        const connectedFriends = Object.values(this.state.friends)
            .filter(f => f.status === 'connected')
            .map(f => ({
                email: f.email,
                displayName: f.displayName || f.email,
                label: f.displayName && f.displayName !== f.email ? `${f.displayName} (${f.email})` : f.email
            }));

        return {
            timelinePosts: cappedTimelinePosts,
            unseenForcedPosts,
            connectedFriends
        };
    }

    scheduleSnapshotFlush() {
        if (!this.state.identity) return;
        if (this.flushTimeout) clearTimeout(this.flushTimeout);
        this.flushTimeout = setTimeout(() => {
            this.flushTimeout = null;
            this.publishMySeenSnapshot().catch(() => {});
        }, FRIEND_SYNC_CONFIG.BATCH_FLUSH_DELAY_MS);
    }

    // --- Nostr Event Builders & Publishers ---

    async buildHandshakeEvents(friendEmail) {
        const id = this.state.identity;
        if (!id) return [];

        const normFriend = normalizeIdentifier(friendEmail);
        const { inboxTag, inboxKeyHex } = await deriveInboxInfo(normFriend);
        const { pairKeyHex, outgoingTag } = await derivePairwiseInfo(id.email, normFriend);

        const nowSec = Math.floor(Date.now() / 1000);

        // 1. Inbox Notification Event (so friend sees incoming request by email)
        const invitePayload = {
            type: '414x_invite_v1',
            fromEmail: id.email,
            fromName: id.displayName,
            pubkeyHex: id.pubkeyHex,
            timestamp: Date.now()
        };
        const encryptedInvite = await encryptJson(invitePayload, inboxKeyHex);
        const inviteDTag = `${inboxTag}:${id.pubkeyHex.slice(0, 16)}`;
        const inviteEvent = await signEvent({
            kind: FRIEND_SYNC_CONFIG.NOSTR_KIND_APP_DATA,
            created_at: nowSec,
            tags: [
                ['d', inviteDTag],
                ['t', inboxTag]
            ],
            content: encryptedInvite
        }, id.privKeyHex);

        // 2. Pairwise Handshake Event (unlocks seenFeedKeyHex for mutually matched friend)
        const handshakePayload = {
            type: '414x_handshake_v1',
            fromEmail: id.email,
            toEmail: normFriend,
            displayName: id.displayName,
            pubkeyHex: id.pubkeyHex,
            seenFeedKeyHex: id.seenFeedKeyHex,
            timestamp: Date.now()
        };
        const encryptedHandshake = await encryptJson(handshakePayload, pairKeyHex);
        const handshakeEvent = await signEvent({
            kind: FRIEND_SYNC_CONFIG.NOSTR_KIND_APP_DATA,
            created_at: nowSec,
            tags: [
                ['d', outgoingTag],
                ['t', outgoingTag]
            ],
            content: encryptedHandshake
        }, id.privKeyHex);

        return [inviteEvent, handshakeEvent];
    }

    async publishHandshakeForFriend(friendEmail) {
        const events = await this.buildHandshakeEvents(friendEmail);
        if (events.length > 0) {
            await this.publishEventsToRelays(events);
        }
    }

    async publishAllHandshakes() {
        if (!this.state.identity) return;
        const allEvents = [];
        for (const [email, friend] of Object.entries(this.state.friends)) {
            if (friend.status === 'connected' || friend.status === 'pending_outgoing') {
                const evs = await this.buildHandshakeEvents(email);
                allEvents.push(...evs);
            }
        }
        if (allEvents.length > 0) {
            await this.publishEventsToRelays(allEvents);
        }
    }

    async buildSeenSnapshotEvent() {
        const id = this.state.identity;
        if (!id) return null;

        this.pruneMySeenIds();
        const seenIds = Array.from(this.mySeenSet);
        const forcedList = Object.values(this.state.myForcedMap || {})
            .filter(item => item && this.isValidRecentTweetId(item.id))
            .slice(-(FRIEND_SYNC_CONFIG.MAX_FORCED_IDS || 100));

        // Include compact post metadata for all forced posts + commented posts + most recent seen posts (up to MAX_POST_META_ENTRIES)
        const posts = {};
        const maxSeenMetaEntries = FRIEND_SYNC_CONFIG.MAX_POST_META_ENTRIES || 25;
        for (const forcedItem of forcedList) {
            const meta = this.state.postMetaMap[forcedItem.id];
            if (meta && !meta.isUnavailable) {
                posts[forcedItem.id] = meta;
            }
        }
        const comments = {};
        const maxCommentsPerTweet = FRIEND_SYNC_CONFIG.MAX_COMMENTS_PER_TWEET || 25;
        if (this.state.myForcedCommentsMap && typeof this.state.myForcedCommentsMap === 'object') {
            for (const [tid, list] of Object.entries(this.state.myForcedCommentsMap)) {
                if (!this.isValidRecentTweetId(tid) || !Array.isArray(list) || list.length === 0) continue;
                const cleanList = list
                    .map(c => this.sanitizeForceCommentEntry(c))
                    .filter(Boolean)
                    .slice(-maxCommentsPerTweet);
                if (cleanList.length > 0) {
                    comments[tid] = cleanList;
                    const meta = this.state.postMetaMap[tid];
                    if (!posts[tid] && meta && !meta.isUnavailable) {
                        posts[tid] = meta;
                    }
                }
            }
        }
        const recentSeenForMeta = seenIds.slice(-maxSeenMetaEntries).reverse();
        let addedSeenMetaCount = 0;
        for (const tid of recentSeenForMeta) {
            if (addedSeenMetaCount >= maxSeenMetaEntries) break;
            const meta = this.state.postMetaMap[tid];
            if (!posts[tid] && meta && !meta.isUnavailable) {
                posts[tid] = meta;
                addedSeenMetaCount++;
            }
        }

        const payload = {
            v: 1,
            email: id.email,
            displayName: id.displayName,
            updatedAt: Date.now(),
            ids: seenIds,
            forced: forcedList,
            comments,
            posts
        };

        const encryptedContent = await encryptJson(payload, id.seenFeedKeyHex);
        const nowSec = Math.floor(Date.now() / 1000);
        const createdAt = Math.max(nowSec, (this.lastPublishedCreatedAtSec || 0) + 1);
        this.lastPublishedCreatedAtSec = createdAt;
        return signEvent({
            kind: FRIEND_SYNC_CONFIG.NOSTR_KIND_APP_DATA,
            created_at: createdAt,
            tags: [
                ['d', '414x-seen-v1']
            ],
            content: encryptedContent
        }, id.privKeyHex);
    }

    async readLocalPreferencesForSelfSync() {
        const prefs = {};
        try {
            if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                const stored = await chrome.storage.local.get(SELF_SYNC_PREF_KEYS);
                for (const key of SELF_SYNC_PREF_KEYS) {
                    if (stored && stored[key] !== undefined) {
                        prefs[key] = stored[key];
                    }
                }
            }
        } catch (err) {
            // Ignore storage read errors
        }

        const prefsKeys = Object.keys(prefs).sort();
        if (prefsKeys.length > 0) {
            const normalizedObj = {};
            for (const k of prefsKeys) normalizedObj[k] = prefs[k];
            const prefsJson = JSON.stringify(normalizedObj);
            if (prefsJson !== (this.state.lastKnownPrefsJson || '')) {
                this.state.lastKnownPrefsJson = prefsJson;
                this.state.preferencesUpdatedAt = Date.now();
            }
        }

        return {
            preferences: prefs,
            preferencesUpdatedAt: this.state.preferencesUpdatedAt || 0
        };
    }

    async applyRemotePreferencesFromSelfSync(remotePrefs, remoteUpdatedAt = 0) {
        if (!remotePrefs || typeof remotePrefs !== 'object') return false;
        const localUpdatedAt = this.state.preferencesUpdatedAt || 0;
        if (remoteUpdatedAt <= localUpdatedAt) return false;

        const toSet = {};
        const sortedKeys = [];
        for (const key of SELF_SYNC_PREF_KEYS) {
            if (remotePrefs[key] !== undefined) {
                toSet[key] = remotePrefs[key];
                sortedKeys.push(key);
            }
        }
        if (sortedKeys.length === 0) return false;

        this.isApplyingRemotePrefs = true;
        try {
            if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                await chrome.storage.local.set(toSet);
                const fullStored = await chrome.storage.local.get(SELF_SYNC_PREF_KEYS);
                const allKeys = SELF_SYNC_PREF_KEYS.filter(k => fullStored && fullStored[k] !== undefined).sort();
                const normalizedObj = {};
                for (const k of allKeys) normalizedObj[k] = fullStored[k];
                this.state.lastKnownPrefsJson = JSON.stringify(normalizedObj);
            } else {
                sortedKeys.sort();
                const normalizedObj = {};
                for (const k of sortedKeys) normalizedObj[k] = toSet[k];
                this.state.lastKnownPrefsJson = JSON.stringify(normalizedObj);
            }
            this.state.preferencesUpdatedAt = remoteUpdatedAt;
        } catch (err) {
            console.warn('X Friends Sync: Failed to apply remote preferences', err);
        } finally {
            this.isApplyingRemotePrefs = false;
        }
        return true;
    }

    async buildSelfSyncEvent() {
        const id = this.state.identity;
        if (!id) return null;

        this.pruneMySeenIds();
        const { selfTag, selfKeyHex } = await deriveSelfSyncInfo(id.email, id.passphrase || '');
        const { preferences, preferencesUpdatedAt } = await this.readLocalPreferencesForSelfSync();

        const payload = {
            type: '414x_self_sync_v1',
            v: 1,
            updatedAt: Date.now(),
            identity: {
                email: id.email,
                displayName: id.displayName,
                privKeyHex: id.privKeyHex,
                pubkeyHex: id.pubkeyHex,
                seenFeedKeyHex: id.seenFeedKeyHex,
                identityCreatedAt: id.identityCreatedAt || 0,
                feedKeyUpdatedAt: id.feedKeyUpdatedAt || 0
            },
            friends: this.state.friends || {},
            removedFriends: this.state.removedFriends || {},
            mySeenIds: Array.from(this.mySeenSet).slice(-FRIEND_SYNC_CONFIG.MAX_SEEN_IDS),
            myForcedMap: this.state.myForcedMap || {},
            unforcedMap: this.state.unforcedMap || {},
            myForcedCommentsMap: this.state.myForcedCommentsMap || {},
            deletedCommentsMap: this.state.deletedCommentsMap || {},
            dismissedForcedIds: Array.from(this.dismissedForcedSet),
            dismissedCommentIds: Array.from(this.dismissedCommentSet),
            preferences,
            preferencesUpdatedAt
        };

        const encryptedContent = await encryptJson(payload, selfKeyHex);
        const nowSec = Math.floor(Date.now() / 1000);
        const createdAt = Math.max(nowSec, (this.lastPublishedCreatedAtSec || 0) + 1);
        this.lastPublishedCreatedAtSec = createdAt;

        return signEvent({
            kind: FRIEND_SYNC_CONFIG.NOSTR_KIND_APP_DATA,
            created_at: createdAt,
            tags: [
                ['d', '414x-self-v1'],
                ['t', selfTag]
            ],
            content: encryptedContent
        }, id.privKeyHex);
    }

    async publishSelfSyncSnapshot() {
        const event = await this.buildSelfSyncEvent();
        if (!event) return false;
        await this.publishEventsToRelays([event]);
        this.state.selfSyncLastSyncedAt = Date.now();
        await this.saveState();
        return true;
    }

    async mergeSelfSyncPayload(remote, options = {}) {
        if (!remote || remote.type !== '414x_self_sync_v1') return { changed: false, sawAdditionalItems: false };

        let changed = false;
        let sawAdditionalItems = false;
        const now = Date.now();

        // 1. Identity key adoption (multi-device / reinstall recovery & feed-key rotation sync)
        if (remote.identity && this.state.identity) {
            const rId = remote.identity;
            if (rId.privKeyHex && rId.pubkeyHex && rId.seenFeedKeyHex) {
                const sameKeypair = this.state.identity.privKeyHex === rId.privKeyHex;
                const remoteFeedUpdatedAt = Number(rId.feedKeyUpdatedAt || remote.updatedAt || 0);
                const localFeedUpdatedAt = Number(this.state.identity.feedKeyUpdatedAt || 0);

                if (options.adoptIdentityKeys) {
                    if (
                        this.state.identity.privKeyHex !== rId.privKeyHex ||
                        this.state.identity.pubkeyHex !== rId.pubkeyHex ||
                        this.state.identity.seenFeedKeyHex !== rId.seenFeedKeyHex
                    ) {
                        this.state.identity.privKeyHex = rId.privKeyHex;
                        this.state.identity.pubkeyHex = rId.pubkeyHex;
                        this.state.identity.seenFeedKeyHex = rId.seenFeedKeyHex;
                        if (rId.identityCreatedAt) this.state.identity.identityCreatedAt = rId.identityCreatedAt;
                        if (remoteFeedUpdatedAt) this.state.identity.feedKeyUpdatedAt = remoteFeedUpdatedAt;
                        changed = true;
                    }
                    if (!options.explicitDisplayName && rId.displayName && this.state.identity.displayName !== rId.displayName) {
                        this.state.identity.displayName = rId.displayName;
                        changed = true;
                    }
                } else if (sameKeypair && this.state.identity.seenFeedKeyHex !== rId.seenFeedKeyHex && remoteFeedUpdatedAt > localFeedUpdatedAt) {
                    // Another device with our same Nostr keypair rotated seenFeedKeyHex (e.g. after removing a friend)
                    this.state.identity.seenFeedKeyHex = rId.seenFeedKeyHex;
                    this.state.identity.feedKeyUpdatedAt = remoteFeedUpdatedAt;
                    changed = true;
                }
            }
        }

        // 2. Merge removedFriends tombstones
        if (!this.state.removedFriends) this.state.removedFriends = {};
        if (remote.removedFriends && typeof remote.removedFriends === 'object') {
            for (const [rawEmail, removedAt] of Object.entries(remote.removedFriends)) {
                const fEmail = normalizeIdentifier(rawEmail);
                const rTime = Number(removedAt) || 0;
                if (fEmail && rTime > (this.state.removedFriends[fEmail] || 0)) {
                    this.state.removedFriends[fEmail] = rTime;
                    changed = true;
                }
            }
        }

        // Remove any local friend whose addedAt predates a removal tombstone
        for (const [fEmail, localFriend] of Object.entries(this.state.friends)) {
            const removedAt = this.state.removedFriends[fEmail] || 0;
            if (removedAt > (localFriend.addedAt || 0)) {
                delete this.state.friends[fEmail];
                delete this.state.friendSeenMap[fEmail];
                delete this.state.friendForcedMap[fEmail];
                if (this.state.friendCommentsMap) {
                    delete this.state.friendCommentsMap[fEmail];
                }
                changed = true;
            }
        }

        // 3. Merge friends map
        if (remote.friends && typeof remote.friends === 'object') {
            for (const [rawEmail, rFriend] of Object.entries(remote.friends)) {
                const fEmail = normalizeIdentifier(rawEmail);
                if (!fEmail || !rFriend || typeof rFriend !== 'object') continue;
                if (this.state.identity && fEmail === this.state.identity.email) continue;

                const removedAt = this.state.removedFriends[fEmail] || 0;
                if ((rFriend.addedAt || 0) < removedAt) continue;

                const existing = this.state.friends[fEmail];
                if (!existing) {
                    this.state.friends[fEmail] = {
                        email: fEmail,
                        displayName: rFriend.displayName || fEmail,
                        status: rFriend.status || 'pending_outgoing',
                        pubkeyHex: rFriend.pubkeyHex || null,
                        seenFeedKeyHex: rFriend.seenFeedKeyHex || null,
                        handshakeTimestamp: rFriend.handshakeTimestamp || 0,
                        addedAt: rFriend.addedAt || now,
                        lastSyncedAt: rFriend.lastSyncedAt || null,
                        seenCount: (this.state.friendSeenMap[fEmail] || []).length
                    };
                    changed = true;
                } else {
                    if (rFriend.status === 'connected' && existing.status !== 'connected') {
                        existing.status = 'connected';
                        changed = true;
                    }
                    const rHsTime = rFriend.handshakeTimestamp || 0;
                    const lHsTime = existing.handshakeTimestamp || 0;
                    if (rFriend.pubkeyHex && rFriend.seenFeedKeyHex && (!existing.pubkeyHex || !existing.seenFeedKeyHex || rHsTime >= lHsTime)) {
                        if (existing.pubkeyHex !== rFriend.pubkeyHex || existing.seenFeedKeyHex !== rFriend.seenFeedKeyHex) {
                            existing.pubkeyHex = rFriend.pubkeyHex;
                            existing.seenFeedKeyHex = rFriend.seenFeedKeyHex;
                            existing.handshakeTimestamp = rHsTime;
                            changed = true;
                        }
                    }
                    if (rFriend.displayName && existing.displayName === existing.email && rFriend.displayName !== existing.email) {
                        existing.displayName = rFriend.displayName;
                        changed = true;
                    }
                }
            }
        }

        // 4. Merge mySeenIds
        if (Array.isArray(remote.mySeenIds)) {
            for (const rawId of remote.mySeenIds) {
                const tid = String(rawId || '').trim();
                if (this.isValidRecentTweetId(tid, now) && !this.mySeenSet.has(tid)) {
                    this.mySeenSet.add(tid);
                    changed = true;
                    sawAdditionalItems = true;
                }
            }
        }

        // 5. Merge unforcedMap & myForcedMap
        if (!this.state.unforcedMap) this.state.unforcedMap = {};
        if (remote.unforcedMap && typeof remote.unforcedMap === 'object') {
            for (const [rawId, unforcedAt] of Object.entries(remote.unforcedMap)) {
                const tid = String(rawId || '').trim();
                const uTime = Number(unforcedAt) || 0;
                if (tid && uTime > (this.state.unforcedMap[tid] || 0)) {
                    this.state.unforcedMap[tid] = uTime;
                    changed = true;
                }
            }
        }

        if (!this.state.myForcedMap) this.state.myForcedMap = {};
        for (const [tid, fObj] of Object.entries(this.state.myForcedMap)) {
            const uTime = this.state.unforcedMap[tid] || 0;
            if (uTime >= (fObj?.forcedAt || 0)) {
                delete this.state.myForcedMap[tid];
                changed = true;
                sawAdditionalItems = true;
            }
        }

        if (remote.myForcedMap && typeof remote.myForcedMap === 'object') {
            for (const [rawId, fObj] of Object.entries(remote.myForcedMap)) {
                const tid = String(rawId || fObj?.id || '').trim();
                const forcedAt = Number(fObj?.forcedAt) || remote.updatedAt || now;
                const uTime = this.state.unforcedMap[tid] || 0;
                if (this.isValidRecentTweetId(tid, now) && forcedAt > uTime) {
                    const existingForced = this.state.myForcedMap[tid];
                    if (!existingForced || forcedAt > (existingForced.forcedAt || 0)) {
                        this.state.myForcedMap[tid] = { id: tid, forcedAt };
                        this.mySeenSet.add(tid);
                        changed = true;
                        sawAdditionalItems = true;
                    }
                }
            }
        }

        // 6. Merge dismissedForcedIds & dismissedCommentIds
        if (Array.isArray(remote.dismissedForcedIds)) {
            for (const rawId of remote.dismissedForcedIds) {
                const tid = String(rawId || '').trim();
                if (this.isValidRecentTweetId(tid, now) && !this.dismissedForcedSet.has(tid)) {
                    this.dismissedForcedSet.add(tid);
                    this.mySeenSet.add(tid);
                    changed = true;
                }
            }
        }

        if (Array.isArray(remote.dismissedCommentIds)) {
            for (const rawCid of remote.dismissedCommentIds) {
                const cid = String(rawCid || '').trim();
                if (cid && !this.dismissedCommentSet.has(cid)) {
                    this.dismissedCommentSet.add(cid);
                    this.notifiedCommentSet.add(cid);
                    changed = true;
                }
            }
        }

        // 6b. Merge deletedCommentsMap & myForcedCommentsMap
        if (!this.state.deletedCommentsMap) this.state.deletedCommentsMap = {};
        if (remote.deletedCommentsMap && typeof remote.deletedCommentsMap === 'object') {
            for (const [rawCid, deletedAt] of Object.entries(remote.deletedCommentsMap)) {
                const cid = String(rawCid || '').trim();
                const dTime = Number(deletedAt) || 0;
                if (cid && dTime > (this.state.deletedCommentsMap[cid] || 0)) {
                    this.state.deletedCommentsMap[cid] = dTime;
                    changed = true;
                }
            }
        }

        if (!this.state.myForcedCommentsMap) this.state.myForcedCommentsMap = {};
        for (const [tid, list] of Object.entries(this.state.myForcedCommentsMap)) {
            if (!Array.isArray(list)) {
                delete this.state.myForcedCommentsMap[tid];
                changed = true;
                continue;
            }
            const uTime = this.state.unforcedMap[tid] || 0;
            const filtered = list.filter(c => {
                if (!c || !c.id) return false;
                if (this.state.deletedCommentsMap[c.id]) return false;
                if (uTime >= (c.createdAt || 0)) return false;
                return true;
            });
            if (filtered.length !== list.length) {
                if (filtered.length > 0) {
                    this.state.myForcedCommentsMap[tid] = filtered;
                } else {
                    delete this.state.myForcedCommentsMap[tid];
                }
                changed = true;
                sawAdditionalItems = true;
            }
        }

        if (remote.myForcedCommentsMap && typeof remote.myForcedCommentsMap === 'object') {
            const maxCommentsPerTweet = FRIEND_SYNC_CONFIG.MAX_COMMENTS_PER_TWEET || 25;
            for (const [rawTid, rawList] of Object.entries(remote.myForcedCommentsMap)) {
                const tid = String(rawTid || '').trim();
                if (!this.isValidRecentTweetId(tid, now) || !Array.isArray(rawList)) continue;
                const uTime = this.state.unforcedMap[tid] || 0;
                const existingList = Array.isArray(this.state.myForcedCommentsMap[tid])
                    ? this.state.myForcedCommentsMap[tid]
                    : [];
                const byId = new Map(existingList.filter(c => c && c.id).map(c => [c.id, c]));
                let addedForTweet = false;
                for (const rawC of rawList) {
                    const cleanC = this.sanitizeForceCommentEntry(rawC, remote.updatedAt || now);
                    if (!cleanC) continue;
                    if (this.state.deletedCommentsMap[cleanC.id]) continue;
                    if (uTime >= cleanC.createdAt) continue;
                    if (!byId.has(cleanC.id)) {
                        byId.set(cleanC.id, cleanC);
                        addedForTweet = true;
                    }
                }
                if (addedForTweet) {
                    this.state.myForcedCommentsMap[tid] = Array.from(byId.values())
                        .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0) || String(a.id).localeCompare(String(b.id)))
                        .slice(-maxCommentsPerTweet);
                    this.mySeenSet.add(tid);
                    changed = true;
                    sawAdditionalItems = true;
                }
            }
        }

        // 7. Merge preferences (blocklists & toggles)
        if (remote.preferences && typeof remote.preferences === 'object') {
            const prefsChanged = await this.applyRemotePreferencesFromSelfSync(
                remote.preferences,
                remote.preferencesUpdatedAt || remote.updatedAt || 0
            );
            if (prefsChanged) changed = true;
        }

        this.state.selfSyncLastSyncedAt = Math.max(this.state.selfSyncLastSyncedAt || 0, remote.updatedAt || now);
        this.pruneMySeenIds();
        return { changed, sawAdditionalItems };
    }

    async pullSelfSyncFromRelays(email, passphrase = '', options = {}) {
        const normEmail = normalizeIdentifier(email);
        if (!normEmail) return false;

        const { selfTag, selfKeyHex } = await deriveSelfSyncInfo(normEmail, passphrase);
        const events = await this.queryRelays([
            {
                kinds: [FRIEND_SYNC_CONFIG.NOSTR_KIND_APP_DATA],
                '#t': [selfTag],
                '#d': ['414x-self-v1']
            }
        ]);
        if (!Array.isArray(events) || events.length === 0) return false;

        // Sort oldest to newest so newest wins on conflicts while unioning sets
        const sorted = [...events].sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
        let anyMerged = false;
        for (const ev of sorted) {
            const payload = await decryptJson(ev.content, selfKeyHex);
            if (payload && payload.type === '414x_self_sync_v1') {
                await this.mergeSelfSyncPayload(payload, options);
                anyMerged = true;
            }
        }
        if (anyMerged) {
            this.rebuildIndex();
            await this.saveState();
        }
        return anyMerged;
    }

    async publishMySeenSnapshot() {
        const seenEvent = await this.buildSeenSnapshotEvent();
        const selfEvent = await this.buildSelfSyncEvent();
        const eventsToPublish = [seenEvent, selfEvent].filter(Boolean);
        if (eventsToPublish.length === 0) return false;

        const publishedRelayCount = await this.publishEventsToRelays(eventsToPublish);
        const hasConfiguredRelays = Array.isArray(this.relays) && this.relays.length > 0;
        if (!hasConfiguredRelays || publishedRelayCount > 0) {
            this.state.selfSyncLastSyncedAt = Date.now();
            if (this.state.hasUnpublishedSeen) {
                this.state.hasUnpublishedSeen = false;
            }
            await this.saveState();
            return true;
        }

        this.state.hasUnpublishedSeen = true;
        await this.saveState();
        return false;
    }

    async syncWithRelays() {
        await this.init();
        const id = this.state.identity;
        if (!id) return this.getPublicState();
        if (this.isSyncing) {
            this.pendingSyncRequested = true;
            return this.getPublicState();
        }

        this.isSyncing = true;
        this.pendingSyncRequested = false;
        try {
            // Snapshot pre-sync invites & forced posts for notification diffing
            this.rebuildIndex();
            const prevInviteEmails = new Set(
                Object.values(this.state.friends)
                    .filter(f => f.status === 'pending_incoming')
                    .map(f => f.email)
            );
            const prevForcedIds = new Set(this.tweetToForcedByMap.keys());
            const prevFriendCommentIds = new Set();
            for (const comments of this.tweetToCommentsMap.values()) {
                for (const c of comments) {
                    if (!c.isMe && c.id) {
                        prevFriendCommentIds.add(c.id);
                    }
                }
            }

            // Check if local preferences changed since last self-sync
            const prevPrefsUpdatedAt = this.state.preferencesUpdatedAt || 0;
            await this.readLocalPreferencesForSelfSync();
            if ((this.state.preferencesUpdatedAt || 0) > prevPrefsUpdatedAt) {
                this.state.hasUnpublishedSeen = true;
            }

            if (this.flushTimeout) {
                clearTimeout(this.flushTimeout);
                this.flushTimeout = null;
                this.state.hasUnpublishedSeen = true;
            }
            if (this.state.hasUnpublishedSeen) {
                await this.publishMySeenSnapshot().catch(() => {});
            }

            const { inboxTag, inboxKeyHex } = await deriveInboxInfo(id.email);
            const { selfTag, selfKeyHex } = await deriveSelfSyncInfo(id.email, id.passphrase || '');
            const tTagsToQuery = [inboxTag, selfTag];
            const pairwiseMap = new Map(); // incomingTag -> { friendEmail, pairKeyHex }

            for (const friendEmail of Object.keys(this.state.friends)) {
                const pairInfo = await derivePairwiseInfo(id.email, friendEmail);
                tTagsToQuery.push(pairInfo.incomingTag);
                pairwiseMap.set(pairInfo.incomingTag, {
                    friendEmail,
                    pairKeyHex: pairInfo.pairKeyHex
                });
            }

            // Step 1: Query Self-Sync, Inbox & Incoming Pairwise Handshakes
            const discoveryFilters = [
                {
                    kinds: [FRIEND_SYNC_CONFIG.NOSTR_KIND_APP_DATA],
                    '#t': tTagsToQuery
                }
            ];

            const discoveryEvents = await this.queryRelays(discoveryFilters);
            let stateChanged = false;
            let needRepublishSeenFromSelfSync = false;

            // Process self-sync events first (oldest to newest) so newly synced friends are included in pairwise checks
            const selfSyncEvents = discoveryEvents
                .filter(ev => {
                    const tVals = (ev.tags || []).filter(t => t[0] === 't').map(t => t[1]);
                    const dVal = (ev.tags || []).find(t => t[0] === 'd')?.[1] || '';
                    return tVals.includes(selfTag) || dVal === '414x-self-v1';
                })
                .sort((a, b) => (a.created_at || 0) - (b.created_at || 0));

            for (const ev of selfSyncEvents) {
                const selfPayload = await decryptJson(ev.content, selfKeyHex);
                if (selfPayload && selfPayload.type === '414x_self_sync_v1') {
                    const mergeRes = await this.mergeSelfSyncPayload(selfPayload, {
                        adoptIdentityKeys: false
                    });
                    if (mergeRes.changed) {
                        stateChanged = true;
                    }
                    if (mergeRes.sawAdditionalItems) {
                        needRepublishSeenFromSelfSync = true;
                    }
                }
            }

            // Ensure pairwiseMap includes any friends added via self-sync
            for (const friendEmail of Object.keys(this.state.friends)) {
                const pairInfo = await derivePairwiseInfo(id.email, friendEmail);
                if (!pairwiseMap.has(pairInfo.incomingTag)) {
                    pairwiseMap.set(pairInfo.incomingTag, {
                        friendEmail,
                        pairKeyHex: pairInfo.pairKeyHex
                    });
                }
            }

            // Track all valid (pubkeyHex -> seenFeedKeyHex) per friend so multi-device / reinstalled keys all sync
            const friendFeedsMap = new Map(); // friendEmail -> Map<pubkeyHex, { seenFeedKeyHex, timestamp }>

            for (const [fEmail, fObj] of Object.entries(this.state.friends)) {
                if (fObj.pubkeyHex && fObj.seenFeedKeyHex) {
                    const m = new Map();
                    m.set(fObj.pubkeyHex, {
                        seenFeedKeyHex: fObj.seenFeedKeyHex,
                        timestamp: fObj.handshakeTimestamp || 0
                    });
                    friendFeedsMap.set(fEmail, m);
                }
            }

            for (const ev of discoveryEvents) {
                const tTagValues = (ev.tags || []).filter(t => t[0] === 't').map(t => t[1]);
                const dTagValue = (ev.tags || []).find(t => t[0] === 'd')?.[1] || '';
                const evTimeMs = (ev.created_at || 0) * 1000;

                // Check if it's an inbox invite for us
                if (tTagValues.includes(inboxTag) || dTagValue.startsWith(inboxTag)) {
                    const invite = await decryptJson(ev.content, inboxKeyHex);
                    if (invite && invite.type === '414x_invite_v1' && invite.fromEmail) {
                        const fromEmail = normalizeIdentifier(invite.fromEmail);
                        if (fromEmail && fromEmail !== id.email) {
                            const removedAt = (this.state.removedFriends && this.state.removedFriends[fromEmail]) || 0;
                            const inviteTime = invite.timestamp || evTimeMs || Date.now();
                            if (inviteTime >= removedAt) {
                                const existing = this.state.friends[fromEmail];
                                if (!existing) {
                                    this.state.friends[fromEmail] = {
                                        email: fromEmail,
                                        displayName: invite.fromName || fromEmail,
                                        status: 'pending_incoming',
                                        pubkeyHex: invite.pubkeyHex || ev.pubkey,
                                        seenFeedKeyHex: null,
                                        addedAt: inviteTime,
                                        lastSyncedAt: null,
                                        seenCount: 0
                                    };
                                    stateChanged = true;
                                    // Also compute pairwise info so we can check if they already sent handshake
                                    const pairInfo = await derivePairwiseInfo(id.email, fromEmail);
                                    pairwiseMap.set(pairInfo.incomingTag, {
                                        friendEmail: fromEmail,
                                        pairKeyHex: pairInfo.pairKeyHex
                                    });
                                } else if (existing.displayName === existing.email && invite.fromName) {
                                    existing.displayName = invite.fromName;
                                    stateChanged = true;
                                }
                            }
                        }
                    }
                }

                // Check if it's a pairwise handshake from a friend
                for (const tag of [...tTagValues, dTagValue]) {
                    const pairMeta = pairwiseMap.get(tag);
                    if (pairMeta) {
                        const hs = await decryptJson(ev.content, pairMeta.pairKeyHex);
                        if (hs && hs.type === '414x_handshake_v1' && hs.seenFeedKeyHex && hs.pubkeyHex) {
                            const friend = this.state.friends[pairMeta.friendEmail];
                            if (friend) {
                                const hsTime = hs.timestamp || evTimeMs;
                                let feeds = friendFeedsMap.get(pairMeta.friendEmail);
                                if (!feeds) {
                                    feeds = new Map();
                                    friendFeedsMap.set(pairMeta.friendEmail, feeds);
                                }
                                feeds.set(hs.pubkeyHex, {
                                    seenFeedKeyHex: hs.seenFeedKeyHex,
                                    timestamp: hsTime
                                });

                                // Only overwrite primary pubkey/seenFeedKey if this handshake is newer or equal
                                const prevHsTime = friend.handshakeTimestamp || 0;
                                if (!friend.pubkeyHex || !friend.seenFeedKeyHex || hsTime >= prevHsTime) {
                                    if (friend.pubkeyHex !== hs.pubkeyHex || friend.seenFeedKeyHex !== hs.seenFeedKeyHex) {
                                        stateChanged = true;
                                    }
                                    friend.pubkeyHex = hs.pubkeyHex;
                                    friend.seenFeedKeyHex = hs.seenFeedKeyHex;
                                    friend.handshakeTimestamp = hsTime;
                                }
                                if (hs.displayName && friend.displayName !== hs.displayName) {
                                    friend.displayName = hs.displayName;
                                    stateChanged = true;
                                }
                                if (friend.status === 'pending_outgoing') {
                                    friend.status = 'connected';
                                    stateChanged = true;
                                }
                            }
                        }
                    }
                }
            }

            if (needRepublishSeenFromSelfSync || !this.state.selfSyncLastSyncedAt) {
                await this.publishMySeenSnapshot().catch(() => {});
            }

            // Step 2: Query Seen-Tweet Snapshots for all Connected Friends
            const connectedFriends = Object.values(this.state.friends).filter(
                f => f.status === 'connected' && f.pubkeyHex && f.seenFeedKeyHex
            );

            if (connectedFriends.length > 0) {
                const pubkeyToTargets = new Map(); // pubkeyHex -> Array<{ friend, seenFeedKeyHex }>
                for (const f of connectedFriends) {
                    const feeds = friendFeedsMap.get(f.email);
                    if (feeds && feeds.size > 0) {
                        for (const [pk, meta] of feeds.entries()) {
                            const list = pubkeyToTargets.get(pk) || [];
                            list.push({ friend: f, seenFeedKeyHex: meta.seenFeedKeyHex });
                            pubkeyToTargets.set(pk, list);
                        }
                    } else {
                        const list = pubkeyToTargets.get(f.pubkeyHex) || [];
                        list.push({ friend: f, seenFeedKeyHex: f.seenFeedKeyHex });
                        pubkeyToTargets.set(f.pubkeyHex, list);
                    }
                }

                const feedFilter = [
                    {
                        kinds: [FRIEND_SYNC_CONFIG.NOSTR_KIND_APP_DATA],
                        authors: Array.from(pubkeyToTargets.keys()),
                        '#d': ['414x-seen-v1']
                    }
                ];

                const feedEvents = await this.queryRelays(feedFilter);
                const now = Date.now();
                const mergedFriendIds = new Map(); // friendEmail -> Set<string>
                const mergedFriendForced = new Map(); // friendEmail -> Map<tweetId, { id, forcedAt }>
                const mergedFriendComments = new Map(); // friendEmail -> Map<tweetId, Map<commentId, { id, text, createdAt }>>

                for (const ev of feedEvents) {
                    const targets = pubkeyToTargets.get(ev.pubkey) || [];
                    for (const { friend, seenFeedKeyHex } of targets) {
                        const decrypted = await decryptJson(ev.content, seenFeedKeyHex);
                        if (decrypted && Array.isArray(decrypted.ids)) {
                            let idSet = mergedFriendIds.get(friend.email);
                            if (!idSet) {
                                idSet = new Set();
                                mergedFriendIds.set(friend.email, idSet);
                            }
                            for (const rawId of decrypted.ids) {
                                const tid = String(rawId).trim();
                                if (this.isValidRecentTweetId(tid, now)) {
                                    idSet.add(tid);
                                }
                            }
                            if (Array.isArray(decrypted.forced)) {
                                let forcedMapForFriend = mergedFriendForced.get(friend.email);
                                if (!forcedMapForFriend) {
                                    forcedMapForFriend = new Map();
                                    mergedFriendForced.set(friend.email, forcedMapForFriend);
                                }
                                for (const rawForced of decrypted.forced) {
                                    const fid = String(typeof rawForced === 'string' ? rawForced : rawForced?.id || '').trim();
                                    const forcedAt = (typeof rawForced === 'object' && rawForced?.forcedAt) ? rawForced.forcedAt : (decrypted.updatedAt || now);
                                    if (this.isValidRecentTweetId(fid, now)) {
                                        idSet.add(fid);
                                        const prev = forcedMapForFriend.get(fid);
                                        if (!prev || forcedAt >= prev.forcedAt) {
                                            forcedMapForFriend.set(fid, { id: fid, forcedAt });
                                        }
                                    }
                                }
                            }
                            if (decrypted.comments && typeof decrypted.comments === 'object') {
                                let commentsByTweet = mergedFriendComments.get(friend.email);
                                if (!commentsByTweet) {
                                    commentsByTweet = new Map();
                                    mergedFriendComments.set(friend.email, commentsByTweet);
                                }
                                for (const [rawTid, rawCommentList] of Object.entries(decrypted.comments)) {
                                    const tid = String(rawTid || '').trim();
                                    if (!this.isValidRecentTweetId(tid, now) || !Array.isArray(rawCommentList)) continue;
                                    let tweetComments = commentsByTweet.get(tid);
                                    if (!tweetComments) {
                                        tweetComments = new Map();
                                        commentsByTweet.set(tid, tweetComments);
                                    }
                                    for (const rawC of rawCommentList) {
                                        const cleanC = this.sanitizeForceCommentEntry(rawC, decrypted.updatedAt || now);
                                        if (!cleanC) continue;
                                        const prevC = tweetComments.get(cleanC.id);
                                        if (!prevC || cleanC.createdAt >= prevC.createdAt) {
                                            tweetComments.set(cleanC.id, cleanC);
                                        }
                                    }
                                }
                            }
                            if (decrypted.posts && typeof decrypted.posts === 'object') {
                                for (const [postId, rawPostMeta] of Object.entries(decrypted.posts)) {
                                    const sanitized = this.sanitizeTweetMeta(postId, rawPostMeta);
                                    if (sanitized) {
                                        this.state.postMetaMap[sanitized.id] = sanitized;
                                    }
                                }
                            }
                            if (decrypted.displayName) {
                                friend.displayName = decrypted.displayName;
                            }
                        }
                    }
                }

                for (const [fEmail, idSet] of mergedFriendIds.entries()) {
                    const friend = this.state.friends[fEmail];
                    if (!friend) continue;
                    const validIds = Array.from(idSet).slice(-FRIEND_SYNC_CONFIG.MAX_SEEN_IDS);
                    this.state.friendSeenMap[fEmail] = validIds;
                    const forcedMapForFriend = mergedFriendForced.get(fEmail);
                    if (forcedMapForFriend) {
                        this.state.friendForcedMap[fEmail] = Array.from(forcedMapForFriend.values())
                            .slice(-(FRIEND_SYNC_CONFIG.MAX_FORCED_IDS || 100));
                    } else {
                        this.state.friendForcedMap[fEmail] = [];
                    }
                    const commentsByTweet = mergedFriendComments.get(fEmail);
                    if (!this.state.friendCommentsMap) this.state.friendCommentsMap = {};
                    if (commentsByTweet && commentsByTweet.size > 0) {
                        const friendCommentObj = {};
                        const maxCommentsPerTweet = FRIEND_SYNC_CONFIG.MAX_COMMENTS_PER_TWEET || 25;
                        for (const [tid, cMap] of commentsByTweet.entries()) {
                            const arr = Array.from(cMap.values())
                                .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0) || String(a.id).localeCompare(String(b.id)))
                                .slice(-maxCommentsPerTweet);
                            if (arr.length > 0) {
                                friendCommentObj[tid] = arr;
                            }
                        }
                        this.state.friendCommentsMap[fEmail] = friendCommentObj;
                    } else {
                        this.state.friendCommentsMap[fEmail] = {};
                    }
                    friend.lastSyncedAt = now;
                    friend.seenCount = validIds.length;
                    stateChanged = true;
                }
            }

            this.lastSyncTime = Date.now();
            if (stateChanged) {
                this.rebuildIndex();
                await this.saveState();
                this.broadcastSeenUpdateToTabs();
            }

            // Compute newly discovered invites, forced posts, and force comments for notifications
            let notifiedSetChanged = false;
            const newInvites = [];
            for (const f of Object.values(this.state.friends)) {
                if (f.status === 'pending_incoming' && (!prevInviteEmails.has(f.email) || !this.notifiedInviteSet.has(f.email))) {
                    this.notifiedInviteSet.add(f.email);
                    notifiedSetChanged = true;
                    newInvites.push({
                        email: f.email,
                        displayName: f.displayName || f.email,
                        addedAt: f.addedAt || Date.now()
                    });
                }
            }

            const candidateForcedPosts = [];
            const newlyNotifiedForcedTweetIds = new Set();
            for (const [tweetId, entries] of this.tweetToForcedByMap.entries()) {
                if (!this.dismissedForcedSet.has(tweetId) && (!prevForcedIds.has(tweetId) || !this.notifiedForcedSet.has(tweetId))) {
                    this.notifiedForcedSet.add(tweetId);
                    notifiedSetChanged = true;
                    newlyNotifiedForcedTweetIds.add(tweetId);
                    const latestForcedAt = entries.reduce((max, e) => Math.max(max, e.forcedAt || 0), 0);
                    const allTweetComments = this.tweetToCommentsMap.get(tweetId) || [];
                    const friendComments = allTweetComments.filter(c => !c.isMe);
                    for (const fc of friendComments) {
                        if (fc.id) this.notifiedCommentSet.add(fc.id);
                    }
                    const latestComment = friendComments.length > 0 ? friendComments[friendComments.length - 1] : null;
                    candidateForcedPosts.push({
                        tweetId,
                        latestForcedAt,
                        forcedBy: entries.map(e => e.label),
                        latestComment,
                        comments: friendComments,
                        meta: this.state.postMetaMap[tweetId] || null
                    });
                }
            }

            // Sort newest forced first and cap per-sync notification burst to top 5
            candidateForcedPosts.sort((a, b) => (b.latestForcedAt || 0) - (a.latestForcedAt || 0));
            const newForcedPosts = candidateForcedPosts.slice(0, 5);

            const candidateForceComments = [];
            for (const [tweetId, comments] of this.tweetToCommentsMap.entries()) {
                if (newlyNotifiedForcedTweetIds.has(tweetId)) continue;
                for (const c of comments) {
                    if (c.isMe || !c.id) continue;
                    if (!this.dismissedCommentSet.has(c.id) && (!prevFriendCommentIds.has(c.id) || !this.notifiedCommentSet.has(c.id))) {
                        this.notifiedCommentSet.add(c.id);
                        notifiedSetChanged = true;
                        candidateForceComments.push({
                            tweetId,
                            commentId: c.id,
                            text: c.text,
                            createdAt: c.createdAt,
                            authorName: c.authorName,
                            authorLabel: c.authorLabel,
                            authorEmail: c.authorEmail,
                            meta: this.state.postMetaMap[tweetId] || null
                        });
                    }
                }
            }
            candidateForceComments.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
            const newForceComments = candidateForceComments.slice(0, 5);

            if (notifiedSetChanged) {
                this.pruneMySeenIds();
                await this.saveState();
            }

            this.lastSyncNotifications = {
                newInvites,
                newForcedPosts,
                newForceComments,
                timestamp: Date.now()
            };

            if ((newInvites.length > 0 || newForcedPosts.length > 0 || newForceComments.length > 0) && typeof this.onNotification === 'function') {
                try {
                    await this.onNotification(this.lastSyncNotifications);
                } catch (notifErr) {
                    console.warn('X Friends Sync: Notification callback error', notifErr);
                }
            }
        } catch (err) {
            console.warn('X Friends Sync: Relay sync error', err);
        } finally {
            this.isSyncing = false;
            if (this.relayHealthDirty && this.isLoaded) {
                await this.saveState();
            }
        }

        if (this.pendingSyncRequested) {
            this.pendingSyncRequested = false;
            return this.syncWithRelays();
        }

        return this.getPublicState();
    }

    broadcastSeenUpdateToTabs() {
        try {
            if (!chrome?.tabs?.query) return;
            chrome.tabs.query({ url: ['*://twitter.com/*', '*://x.com/*'] }, (tabs) => {
                if (!Array.isArray(tabs)) return;
                tabs.forEach(tab => {
                    if (tab.id) {
                        chrome.tabs.sendMessage(tab.id, { action: 'X_FRIENDS_SEEN_UPDATED' }).catch(() => {});
                    }
                });
            });
        } catch (e) {
            // Ignore tab messaging errors
        }
    }

    broadcastDismissUpdateToTabs(tweetIdOrIds, commentIdsMap = {}) {
        try {
            if (!chrome?.tabs?.query) return;
            const ids = Array.isArray(tweetIdOrIds) ? tweetIdOrIds : [tweetIdOrIds].filter(Boolean);
            const payload = { tweetIds: ids, tweetId: ids[0] };
            if (commentIdsMap && Object.keys(commentIdsMap).length > 0) {
                payload.commentIdsMap = commentIdsMap;
            }
            chrome.tabs.query({ url: ['*://twitter.com/*', '*://x.com/*'] }, (tabs) => {
                if (!Array.isArray(tabs)) return;
                tabs.forEach(tab => {
                    if (tab.id) {
                        chrome.tabs.sendMessage(tab.id, {
                            action: 'X_FRIENDS_DISMISS_UPDATED',
                            payload
                        }).catch(() => {});
                    }
                });
            });
        } catch (e) {
            // Ignore tab messaging errors
        }
    }

    // --- Low-Level WebSocket Relay Operations (Pooled, Preflighted & Retry-Resilient) ---

    sleepMs(ms) {
        if (!ms || ms <= 0) return Promise.resolve();
        return new Promise((resolve) => {
            const t = setTimeout(resolve, ms);
            if (typeof t?.unref === 'function') t.unref();
        });
    }

    toHttpRelayUrl(relayUrl) {
        if (typeof relayUrl !== 'string') return null;
        if (relayUrl.startsWith('wss://')) return 'https://' + relayUrl.slice(6);
        if (relayUrl.startsWith('ws://')) return 'http://' + relayUrl.slice(5);
        return null;
    }

    recordRelayFailure(relayUrl) {
        const failures = (this.relayFailureCounts.get(relayUrl) || 0) + 1;
        this.relayFailureCounts.set(relayUrl, failures);
        const baseCooldownMs = FRIEND_SYNC_CONFIG.RELAY_BASE_COOLDOWN_MS || (60 * 1000);
        const maxCooldownMs = FRIEND_SYNC_CONFIG.RELAY_MAX_COOLDOWN_MS || (30 * 60 * 1000);
        const backoffMs = Math.min(maxCooldownMs, baseCooldownMs * Math.pow(2, Math.min(failures - 1, 5)));
        this.relayCooldownUntil.set(relayUrl, Date.now() + backoffMs);
        this.relayPreflightOkUntil.delete(relayUrl);
        this.relayHealthDirty = true;
    }

    clearRelayFailure(relayUrl) {
        const hadFailures = this.relayFailureCounts.has(relayUrl);
        const hadCooldown = this.relayCooldownUntil.has(relayUrl);
        if (hadFailures) this.relayFailureCounts.delete(relayUrl);
        if (hadCooldown) this.relayCooldownUntil.delete(relayUrl);
        if (hadFailures || hadCooldown) {
            this.relayHealthDirty = true;
        }
    }

    async probeRelayHttpHealth(relayUrl) {
        if (!this.enableNip11Preflight || typeof this.fetchFn !== 'function') {
            return true;
        }

        const httpUrl = this.toHttpRelayUrl(relayUrl);
        if (!httpUrl) return true;

        const cachedOkUntil = this.relayPreflightOkUntil.get(relayUrl);
        if (cachedOkUntil && Date.now() < cachedOkUntil) {
            return true;
        }

        const inflight = this.inflightPreflights.get(relayUrl);
        if (inflight) return inflight;

        const preflightTimeoutMs = FRIEND_SYNC_CONFIG.RELAY_PREFLIGHT_TIMEOUT_MS || 3000;
        const preflightTtlMs = FRIEND_SYNC_CONFIG.RELAY_PREFLIGHT_TTL_MS || (5 * 60 * 1000);
        const maxRetries = Math.max(0, Number(this.preflightMaxRetries) || 0);
        const baseRetryDelayMs = Math.max(0, Number(this.preflightRetryDelayMs) || 0);

        const probePromise = (async () => {
            for (let attempt = 0; attempt <= maxRetries; attempt++) {
                const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
                const abortTimer = controller
                    ? setTimeout(() => {
                        try {
                            controller.abort();
                        } catch (e) {}
                    }, preflightTimeoutMs)
                    : null;
                if (typeof abortTimer?.unref === 'function') abortTimer.unref();

                try {
                    const fetchOptions = {
                        method: 'GET',
                        headers: {
                            Accept: 'application/nostr+json',
                            'Cache-Control': 'no-cache'
                        }
                    };
                    if (controller) fetchOptions.signal = controller.signal;

                    const res = await this.fetchFn(httpUrl, fetchOptions);
                    if (abortTimer) clearTimeout(abortTimer);

                    // Any non-5xx / non-429 response confirms the HTTP gateway is reachable (avoids Blink 502 WS error)
                    if (res && typeof res.status === 'number' && res.status < 500 && res.status !== 429) {
                        this.relayPreflightOkUntil.set(relayUrl, Date.now() + preflightTtlMs);
                        return true;
                    }
                } catch (err) {
                    if (abortTimer) clearTimeout(abortTimer);
                }

                if (attempt < maxRetries && baseRetryDelayMs > 0) {
                    const jitter = baseRetryDelayMs >= 50 ? (0.85 + Math.random() * 0.3) : 1;
                    const delayMs = Math.round(baseRetryDelayMs * Math.pow(2, attempt) * jitter);
                    await this.sleepMs(delayMs);
                }
            }

            return false;
        })();

        this.inflightPreflights.set(relayUrl, probePromise);
        try {
            return await probePromise;
        } finally {
            this.inflightPreflights.delete(relayUrl);
        }
    }

    getOrOpenRelayEntry(relayUrl) {
        const cooldown = this.relayCooldownUntil.get(relayUrl);
        if (cooldown && Date.now() < cooldown) {
            return Promise.resolve(null);
        }

        const existing = this.wsPool.get(relayUrl);
        if (existing && (existing.connecting || (existing.ws && (existing.ws.readyState === 0 || existing.ws.readyState === 1)))) {
            this.touchRelayEntry(existing);
            return existing.openPromise;
        }

        const entry = {
            relayUrl,
            ws: null,
            connecting: true,
            listeners: new Set(),
            closeListeners: new Set(),
            idleTimer: null,
            openPromise: null,
            openedAt: 0,
            receivedData: false
        };

        const notifyEntryClosed = () => {
            for (const closeFn of Array.from(entry.closeListeners)) {
                try {
                    closeFn();
                } catch (e) {}
            }
            entry.closeListeners.clear();
        };

        entry.openPromise = (async () => {
            const httpHealthy = await this.probeRelayHttpHealth(relayUrl);
            if (!httpHealthy) {
                entry.connecting = false;
                this.wsPool.delete(relayUrl);
                this.recordRelayFailure(relayUrl);
                notifyEntryClosed();
                return null;
            }

            return await new Promise((resolve) => {
                let settled = false;
                const fail = () => {
                    if (settled) return;
                    settled = true;
                    entry.connecting = false;
                    clearTimeout(connectTimer);
                    this.wsPool.delete(relayUrl);
                    this.recordRelayFailure(relayUrl);
                    notifyEntryClosed();
                    this.closeRelayEntry(entry);
                    resolve(null);
                };

                const connectTimer = setTimeout(fail, FRIEND_SYNC_CONFIG.RELAY_TIMEOUT_MS);
                if (typeof connectTimer?.unref === 'function') connectTimer.unref();

                try {
                    const ws = this.webSocketFactory(relayUrl);
                    if (!ws) {
                        fail();
                        return;
                    }
                    entry.ws = ws;

                    ws.onopen = () => {
                        if (settled) return;
                        settled = true;
                        entry.connecting = false;
                        clearTimeout(connectTimer);
                        entry.openedAt = Date.now();
                        if (this.relayCooldownUntil.has(relayUrl)) {
                            this.relayCooldownUntil.delete(relayUrl);
                            this.relayHealthDirty = true;
                        }
                        this.touchRelayEntry(entry);
                        resolve(entry);
                    };

                    ws.onmessage = (msg) => {
                        if (!entry.receivedData) {
                            entry.receivedData = true;
                            this.clearRelayFailure(relayUrl);
                        }
                        this.touchRelayEntry(entry);
                        for (const listener of Array.from(entry.listeners)) {
                            try {
                                listener(msg);
                            } catch (e) {}
                        }
                    };

                    ws.onerror = () => {
                        this.relayPreflightOkUntil.delete(relayUrl);
                        if (!settled) {
                            fail();
                        } else {
                            this.recordRelayFailure(relayUrl);
                            notifyEntryClosed();
                            this.closeRelayEntry(entry);
                        }
                    };

                    ws.onclose = () => {
                        if (entry.idleTimer) {
                            clearTimeout(entry.idleTimer);
                            entry.idleTimer = null;
                        }
                        this.wsPool.delete(relayUrl);
                        if (!settled) {
                            fail();
                        } else {
                            if (!entry.receivedData && entry.openedAt && (Date.now() - entry.openedAt) < 1500) {
                                this.recordRelayFailure(relayUrl);
                            }
                            notifyEntryClosed();
                        }
                    };
                } catch (err) {
                    fail();
                }
            });
        })();

        this.wsPool.set(relayUrl, entry);
        return entry.openPromise;
    }

    touchRelayEntry(entry) {
        if (entry.idleTimer) clearTimeout(entry.idleTimer);
        const idleTimeoutMs = FRIEND_SYNC_CONFIG.RELAY_IDLE_TIMEOUT_MS || 60000;
        entry.idleTimer = setTimeout(() => {
            if (entry.listeners.size === 0) {
                this.closeRelayEntry(entry);
            }
        }, idleTimeoutMs);
        if (typeof entry.idleTimer?.unref === 'function') entry.idleTimer.unref();
    }

    closeRelayEntry(entry) {
        if (!entry) return;
        entry.connecting = false;
        if (entry.idleTimer) {
            clearTimeout(entry.idleTimer);
            entry.idleTimer = null;
        }
        if (entry.closeListeners && entry.closeListeners.size > 0) {
            for (const closeFn of Array.from(entry.closeListeners)) {
                try {
                    closeFn();
                } catch (e) {}
            }
            entry.closeListeners.clear();
        }
        this.wsPool.delete(entry.relayUrl);
        const ws = entry.ws;
        entry.ws = null;
        if (!ws) return;
        try {
            ws.onopen = null;
            ws.onmessage = null;
            ws.onerror = null;
            ws.onclose = null;
            if (ws.readyState === 0 || ws.readyState === 1) {
                ws.close();
            }
        } catch (e) {}
    }

    resetSingleFailureCooldownsForRetry() {
        for (const relayUrl of this.relays) {
            const failures = this.relayFailureCounts.get(relayUrl) || 0;
            if (failures === 1) {
                this.relayFailureCounts.delete(relayUrl);
                this.relayCooldownUntil.delete(relayUrl);
            }
        }
    }

    async publishToSingleRelay(relayUrl, events, targetIds, allowStaleReconnect = true) {
        const pooledBefore = this.wsPool.get(relayUrl);
        const wasPooledOpen = Boolean(pooledBefore && pooledBefore.ws && pooledBefore.ws.readyState === 1);

        const entry = await this.getOrOpenRelayEntry(relayUrl);
        if (!entry || !entry.ws || entry.ws.readyState !== 1) return false;

        const result = await new Promise((resolve) => {
            let settled = false;
            const seenOkIds = new Set();
            const acceptedIds = new Set();
            let closedEarly = false;

            const finish = (didSucceed) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                entry.listeners.delete(onMessage);
                entry.closeListeners.delete(onClose);
                this.touchRelayEntry(entry);
                resolve({ ok: didSucceed, closedEarly });
            };

            const onClose = () => {
                closedEarly = true;
                finish(acceptedIds.size > 0);
            };

            const timer = setTimeout(() => finish(acceptedIds.size > 0), FRIEND_SYNC_CONFIG.RELAY_TIMEOUT_MS);
            if (typeof timer?.unref === 'function') timer.unref();

            const onMessage = (msg) => {
                try {
                    const data = JSON.parse(msg.data);
                    if (Array.isArray(data) && data[0] === 'OK' && targetIds.has(data[1])) {
                        seenOkIds.add(data[1]);
                        const isDuplicateReason = typeof data[3] === 'string' && data[3].toLowerCase().includes('duplicate');
                        const isAccepted = data[2] !== false || isDuplicateReason;
                        if (isAccepted) {
                            acceptedIds.add(data[1]);
                        } else {
                            console.warn('X Friends Sync: Relay rejected event', relayUrl, data[1], data[3] || '');
                        }
                        if (seenOkIds.size >= targetIds.size) {
                            finish(acceptedIds.size >= targetIds.size);
                        }
                    }
                } catch (e) {}
            };

            entry.listeners.add(onMessage);
            entry.closeListeners.add(onClose);
            try {
                for (const ev of events) {
                    entry.ws.send(JSON.stringify(['EVENT', ev]));
                }
            } catch (err) {
                closedEarly = true;
                this.closeRelayEntry(entry);
                finish(false);
            }
        });

        if (!result.ok && result.closedEarly && wasPooledOpen && allowStaleReconnect) {
            this.relayCooldownUntil.delete(relayUrl);
            return this.publishToSingleRelay(relayUrl, events, targetIds, false);
        }

        return result.ok;
    }

    async publishEventsToRelays(events) {
        if (!events || events.length === 0 || !this.relays || this.relays.length === 0) return 0;

        const targetIds = new Set(events.map(e => e.id));
        const maxRetries = Math.max(0, Number(this.batchMaxRetries) || 0);
        let publishedRelayCount = 0;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            const outcomes = await Promise.allSettled(
                this.relays.map(relayUrl => this.publishToSingleRelay(relayUrl, events, targetIds))
            );
            publishedRelayCount = outcomes.filter(r => r.status === 'fulfilled' && r.value === true).length;
            if (publishedRelayCount > 0) break;

            if (attempt < maxRetries) {
                this.resetSingleFailureCooldownsForRetry();
                await this.sleepMs(this.batchRetryDelayMs);
            }
        }

        if (this.relayHealthDirty && this.isLoaded) {
            await this.saveState();
        }
        return publishedRelayCount;
    }

    async querySingleRelay(relayUrl, subId, filters, collectedByKey, allowStaleReconnect = true) {
        const pooledBefore = this.wsPool.get(relayUrl);
        const wasPooledOpen = Boolean(pooledBefore && pooledBefore.ws && pooledBefore.ws.readyState === 1);

        const entry = await this.getOrOpenRelayEntry(relayUrl);
        if (!entry || !entry.ws || entry.ws.readyState !== 1) return false;

        const result = await new Promise((resolve) => {
            let settled = false;
            let gotResponse = false;
            let closedEarly = false;

            const finish = (didSucceed) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                entry.listeners.delete(onMessage);
                entry.closeListeners.delete(onClose);
                try {
                    if (entry.ws && entry.ws.readyState === 1) {
                        entry.ws.send(JSON.stringify(['CLOSE', subId]));
                    }
                } catch (e) {}
                this.touchRelayEntry(entry);
                resolve({ ok: didSucceed, closedEarly });
            };

            const onClose = () => {
                closedEarly = true;
                finish(gotResponse);
            };

            const timer = setTimeout(() => finish(gotResponse), FRIEND_SYNC_CONFIG.RELAY_TIMEOUT_MS);
            if (typeof timer?.unref === 'function') timer.unref();

            const onMessage = (msg) => {
                try {
                    const data = JSON.parse(msg.data);
                    if (!Array.isArray(data)) return;
                    if (data[0] === 'EVENT' && data[1] === subId && data[2]) {
                        gotResponse = true;
                        const ev = data[2];
                        const dTag = (ev.tags || []).find(t => t[0] === 'd')?.[1] || '';
                        const key = `${ev.pubkey}:${ev.kind}:${dTag}`;
                        const existing = collectedByKey.get(key);
                        if (!existing || ev.created_at >= existing.created_at) {
                            collectedByKey.set(key, ev);
                        }
                    } else if (data[0] === 'EOSE' && data[1] === subId) {
                        gotResponse = true;
                        finish(true);
                    }
                } catch (e) {}
            };

            entry.listeners.add(onMessage);
            entry.closeListeners.add(onClose);
            try {
                entry.ws.send(JSON.stringify(['REQ', subId, ...filters]));
            } catch (err) {
                closedEarly = true;
                this.closeRelayEntry(entry);
                finish(false);
            }
        });

        if (!result.ok && result.closedEarly && wasPooledOpen && allowStaleReconnect) {
            this.relayCooldownUntil.delete(relayUrl);
            return this.querySingleRelay(relayUrl, subId, filters, collectedByKey, false);
        }

        return result.ok;
    }

    async queryRelays(filters) {
        if (!filters || filters.length === 0 || !this.relays || this.relays.length === 0) return [];

        const collectedByKey = new Map(); // replaceableKey -> event
        const maxRetries = Math.max(0, Number(this.batchMaxRetries) || 0);

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            const subId = '414x_' + Math.random().toString(36).slice(2, 10);
            const outcomes = await Promise.allSettled(
                this.relays.map(relayUrl => this.querySingleRelay(relayUrl, subId, filters, collectedByKey))
            );
            const activeCount = outcomes.filter(r => r.status === 'fulfilled' && r.value === true).length;
            if (activeCount > 0) break;

            if (attempt < maxRetries) {
                this.resetSingleFailureCooldownsForRetry();
                await this.sleepMs(this.batchRetryDelayMs);
            }
        }

        if (this.relayHealthDirty && this.isLoaded) {
            await this.saveState();
        }

        const verifiedEvents = [];
        for (const ev of collectedByKey.values()) {
            const valid = await verifyEvent(ev);
            if (valid) verifiedEvents.push(ev);
        }
        verifiedEvents.sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
        return verifiedEvents;
    }
}

export const friendsSync = new XFriendsSyncManager();
