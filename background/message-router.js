// 职责：统一处理扩展各端消息路由与响应编排（不依赖 chrome.*，浏览器能力全部由 deps 注入）。
// 作者：Banana

import {
  PING,
  PANEL_READY,
  OPTIONS_READY,
  ACTIVE_TAB_INFO,
  SETTINGS_GET,
  SETTINGS_SAVE,
  SITES_ADD,
  SITES_REMOVE,
  PROVIDER_PERMISSION_REQUEST,
  CLUES_LIST,
  CLUES_LIST_GAMES,
  CLUES_EXPORT,
  CLUES_UPDATED,
  READER_DELTA,
  READER_FLUSH,
  READER_SCREENSHOT_REQUEST,
  READER_SCREENSHOT_RESULT,
  AI_EXTRACT,
  AI_ASK,
  createMessage,
  createResponse,
} from '../core/messages.js';
import { normalizeOrigin } from '../core/settings.js';
import { makeGameKey, parseGameKey } from '../core/clues.js';

const DEFAULT_SCREENSHOT_INTERVAL_MS = 30000;
const EMPTY_TAB_INFO = { origin: '', isGranted: false, isCanvas: false, title: '' };

/**
 * 创建消息路由实例。
 * @param {object} deps 依赖集合（settingsService / clueStore / aiClient 必填）
 * @returns {{ handleMessage: (message: object, sender: object) => Promise<object> }}
 */
export function createMessageRouter(deps) {
  const {
    settingsService,
    clueStore,
    aiClient,
    now = Date.now,
    screenshotThrottleMap = new Map(),
    getActiveTab,
    getTabById,
    containsOrigin,
    captureVisibleTab,
    sendToTab,
    broadcast,
    queryIsCanvas,
  } = deps || {};

  function respond(type, requestId, apiKey, payload) {
    return createResponse(type, requestId, true, payload, null, apiKey);
  }

  function fail(type, requestId, apiKey, errorMessage) {
    return createResponse(type, requestId, false, null, errorMessage, apiKey);
  }

  /**
   * 读取明文 apiKey，仅用于 createResponse 脱敏，绝不进入 payload / 日志。
   */
  async function readApiKeyForRedaction() {
    try {
      const settings = await settingsService.getSettings();
      return settings && settings.apiKey ? settings.apiKey : null;
    } catch (_) {
      return null;
    }
  }

  function safeBroadcast(message) {
    if (typeof broadcast !== 'function') return;
    try {
      broadcast(message);
    } catch (_) {
      /* 广播失败不影响主流程 */
    }
  }

  /**
   * 统一入库并广播线索更新。
   * @returns {Promise<Array>} 新增的线索数组
   */
  async function maybeStoreExtracted(gameKey, extractResult) {
    try {
      if (!gameKey || !extractResult) return [];
      const clues = Array.isArray(extractResult.clues) ? extractResult.clues : [];
      if (clues.length === 0) return [];
      const added = await clueStore.addClues(gameKey, clues);
      const addedList = Array.isArray(added) ? added : [];
      if (addedList.length > 0) {
        safeBroadcast(createMessage(CLUES_UPDATED, { gameKey, addedCount: addedList.length }));
      }
      return addedList;
    } catch (_) {
      return [];
    }
  }

  /**
   * 从 settings 中推断 origin 对应的 gameId。
   */
  function resolveGameId(settings, origin) {
    if (!settings || !origin) return '';
    const currentGameKey = settings.currentGameKey;
    if (currentGameKey) {
      let parsed = null;
      try {
        parsed = parseGameKey(currentGameKey);
      } catch (_) {
        parsed = null;
      }
      if (parsed && parsed.origin === origin && parsed.gameId) {
        return parsed.gameId;
      }
    }

    const sites = settings.gameSites;
    const matches = [];

    if (Array.isArray(sites)) {
      for (const item of sites) {
        if (!item || typeof item !== 'object') continue;
        if (item.origin === origin && item.gameId) matches.push(item.gameId);
      }
    } else if (sites && typeof sites === 'object') {
      const value = sites[origin];
      if (typeof value === 'string' && value) {
        matches.push(value);
      } else if (value && typeof value === 'object') {
        const gameId = value.gameId || value.id;
        if (gameId) matches.push(gameId);
      }
    }

    const unique = Array.from(new Set(matches));
    return unique.length === 1 ? unique[0] : '';
  }

  /**
   * 获取当前活动标签页信息（ACTIVE_TAB_INFO / PANEL_READY 共用）。
   */
  async function getActiveTabInfo() {
    if (typeof getActiveTab !== 'function') return Object.assign({}, EMPTY_TAB_INFO);

    let tab = null;
    try {
      tab = await getActiveTab();
    } catch (_) {
      tab = null;
    }
    if (!tab) return Object.assign({}, EMPTY_TAB_INFO);

    const origin = tab.url ? normalizeOrigin(tab.url) : '';
    const title = tab.title || '';

    let isGranted = false;
    if (origin && typeof containsOrigin === 'function') {
      try {
        isGranted = !!(await containsOrigin(origin));
      } catch (_) {
        isGranted = false;
      }
    }

    let isCanvas = false;
    if (typeof queryIsCanvas === 'function') {
      try {
        isCanvas = !!(await queryIsCanvas(tab));
      } catch (_) {
        isCanvas = false;
      }
    }

    let gameId = '';
    if (origin) {
      let settings = null;
      try {
        settings = await settingsService.getSettings();
      } catch (_) {
        settings = null;
      }
      gameId = resolveGameId(settings, origin);
    }

    const info = { origin };
    if (gameId) info.gameId = gameId;
    info.isGranted = isGranted;
    info.isCanvas = isCanvas;
    info.title = title;
    return info;
  }

  /**
   * 处理单条消息。
   * @param {{ type: string, requestId: string, payload?: object }} message
   * @param {{ tab?: { id: number, url: string, title: string, windowId: number } }} sender
   * @returns {Promise<object>} ExtensionResponse
   */
  async function handleMessage(message, sender) {
    const type = message ? message.type : undefined;
    const requestId = message ? message.requestId : undefined;
    const payload = (message && message.payload) || {};
    const apiKey = await readApiKeyForRedaction();

    try {
      switch (type) {
        case PING: {
          return respond(type, requestId, apiKey, { ok: true, pong: now() });
        }

        case SETTINGS_GET: {
          const redacted = await settingsService.getRedactedSettings();
          return respond(type, requestId, apiKey, redacted);
        }

        case SETTINGS_SAVE: {
          await settingsService.saveSettings(payload || {});
          const redacted = await settingsService.getRedactedSettings();
          return respond(type, requestId, apiKey, redacted);
        }

        case SITES_ADD: {
          const result = await settingsService.addGameSite(payload.origin, payload.gameId);
          return respond(type, requestId, apiKey, result || { granted: false });
        }

        case SITES_REMOVE: {
          await settingsService.removeGameSite(payload.origin, payload.gameId);
          return respond(type, requestId, apiKey, { ok: true });
        }

        case PROVIDER_PERMISSION_REQUEST: {
          const granted = await settingsService.requestProviderHostPermission(
            payload.provider,
            payload.baseUrl
          );
          return respond(type, requestId, apiKey, { granted: !!granted });
        }

        case CLUES_LIST: {
          const clues = await clueStore.listClues(payload.gameKey);
          return respond(type, requestId, apiKey, Array.isArray(clues) ? clues : []);
        }

        case CLUES_LIST_GAMES: {
          const games = await clueStore.listGames();
          return respond(type, requestId, apiKey, Array.isArray(games) ? games : []);
        }

        case CLUES_EXPORT: {
          const gameKey = payload.gameKey;
          const format = payload.format || 'json';
          const isMarkdown = format === 'markdown' || format === 'md';
          const content = isMarkdown
            ? await clueStore.exportMarkdown(gameKey)
            : await clueStore.exportJSON(gameKey);
          const ext = isMarkdown ? 'md' : 'json';
          let filename;
          if (gameKey) {
            const safe = String(gameKey).replace(/[^A-Za-z0-9.]/g, '-');
            filename = `clues-${safe}.${ext}`;
          } else {
            filename = `clues-all.${ext}`;
          }
          return respond(type, requestId, apiKey, { content, filename });
        }

        case ACTIVE_TAB_INFO: {
          const tabInfo = await getActiveTabInfo();
          return respond(type, requestId, apiKey, tabInfo);
        }

        case AI_EXTRACT: {
          const gameKey = payload.gameKey;
          const result = await aiClient.extractClues(payload.delta, payload.image);
          if (gameKey && result && Array.isArray(result.clues) && result.clues.length > 0) {
            await maybeStoreExtracted(gameKey, result);
          }
          return respond(type, requestId, apiKey, result);
        }

        case AI_ASK: {
          const gameKey = payload.gameKey;
          const clues = gameKey ? await clueStore.listClues(gameKey) : [];
          const result = await aiClient.answerQuestion(
            payload.question,
            Array.isArray(clues) ? clues : []
          );
          return respond(type, requestId, apiKey, result);
        }

        case READER_DELTA: {
          let origin = typeof payload.origin === 'string' && payload.origin ? payload.origin : '';
          if (!origin && sender && sender.tab && sender.tab.url) {
            origin = normalizeOrigin(sender.tab.url);
          }
          if (!origin) {
            return respond(type, requestId, apiKey, { queued: true });
          }

          let granted = false;
          if (typeof containsOrigin === 'function') {
            try {
              granted = !!(await containsOrigin(origin));
            } catch (_) {
              granted = false;
            }
          }
          if (!granted) {
            return respond(type, requestId, apiKey, { queued: false });
          }

          const text = payload.text;
          if (typeof text !== 'string' || text.trim() === '') {
            return respond(type, requestId, apiKey, { queued: true });
          }

          const gameKey = typeof payload.gameKey === 'string' && payload.gameKey
            ? payload.gameKey
            : makeGameKey(origin);

          try {
            const extractResult = await aiClient.extractClues(text, null);
            if (extractResult && Array.isArray(extractResult.clues) && extractResult.clues.length > 0) {
              await maybeStoreExtracted(gameKey, extractResult);
            }
          } catch (_) {
            /* 自动提取异常吞掉，请求仍视为已入队 */
          }

          return respond(type, requestId, apiKey, { queued: true });
        }

        case READER_SCREENSHOT_REQUEST: {
          const reason = typeof payload.reason === 'string' && payload.reason ? payload.reason : 'user';

          const screenshotResult = async (ok, resultReason, extra) => {
            const body = Object.assign({ ok, reason: resultReason }, extra || {});
            safeBroadcast(createMessage(READER_SCREENSHOT_RESULT, body));
            return createResponse(type, requestId, true, body, null, apiKey);
          };

          let tab = sender && sender.tab ? sender.tab : null;
          if (!tab && payload.tabId != null && typeof getTabById === 'function') {
            try {
              tab = await getTabById(payload.tabId);
            } catch (_) {
              tab = null;
            }
          }
          if (!tab && typeof getActiveTab === 'function') {
            try {
              tab = await getActiveTab();
            } catch (_) {
              tab = null;
            }
          }

          if (!tab) {
            return screenshotResult(false, reason, { skipped: 'no_tab' });
          }

          let origin = typeof payload.origin === 'string' && payload.origin ? payload.origin : '';
          if (!origin && tab.url) {
            origin = normalizeOrigin(tab.url);
          }

          let granted = false;
          if (origin && typeof containsOrigin === 'function') {
            try {
              granted = !!(await containsOrigin(origin));
            } catch (_) {
              granted = false;
            }
          }
          if (!origin || !granted) {
            return screenshotResult(false, reason, { skipped: 'permission' });
          }

          const tabId = tab.id != null ? tab.id : 'unknown';
          const throttleKey = `${tabId}::${origin}`;

          let interval = DEFAULT_SCREENSHOT_INTERVAL_MS;
          try {
            const settings = await settingsService.getSettings();
            if (
              settings &&
              typeof settings.screenshotMaxIntervalMs === 'number' &&
              settings.screenshotMaxIntervalMs >= 0
            ) {
              interval = settings.screenshotMaxIntervalMs;
            }
          } catch (_) {
            interval = DEFAULT_SCREENSHOT_INTERVAL_MS;
          }

          const lastCapturedAt = screenshotThrottleMap.get(throttleKey);
          const startedAt = now();
          if (typeof lastCapturedAt === 'number' && startedAt - lastCapturedAt < interval) {
            return screenshotResult(false, reason, { skipped: 'throttled' });
          }

          let dataUrl = '';
          try {
            if (typeof captureVisibleTab !== 'function') {
              throw new Error('截图能力未就绪');
            }
            if (tab.windowId == null) {
              throw new Error('无法获取窗口信息');
            }
            dataUrl = await captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 70 });
          } catch (_) {
            return screenshotResult(false, reason, { error: '网页截图失败，请稍后再试' });
          }

          const matched = /^data:([^;]+);base64,(.+)$/.exec(String(dataUrl || ''));
          if (!matched) {
            return screenshotResult(false, reason, { error: '截图数据格式无效' });
          }
          const mimeType = matched[1];
          const dataBase64 = matched[2];

          const gameKey = typeof payload.gameKey === 'string' && payload.gameKey
            ? payload.gameKey
            : makeGameKey(origin);

          try {
            const extractResult = await aiClient.extractClues('', { mimeType, dataBase64 });
            if (extractResult && Array.isArray(extractResult.clues) && extractResult.clues.length > 0) {
              await maybeStoreExtracted(gameKey, extractResult);
            }
          } catch (_) {
            return screenshotResult(false, reason, { error: '图像识别失败，请稍后再试' });
          }

          screenshotThrottleMap.set(throttleKey, now());
          return screenshotResult(true, reason, {});
        }

        case READER_FLUSH: {
          let tab = null;
          if (typeof getActiveTab === 'function') {
            try {
              tab = await getActiveTab();
            } catch (_) {
              tab = null;
            }
          }
          if (!tab) {
            return respond(type, requestId, apiKey, { forwarded: false });
          }

          const origin = tab.url ? normalizeOrigin(tab.url) : '';
          if (!origin) {
            return respond(type, requestId, apiKey, { forwarded: false });
          }

          let granted = false;
          if (typeof containsOrigin === 'function') {
            try {
              granted = !!(await containsOrigin(origin));
            } catch (_) {
              granted = false;
            }
          }
          if (!granted || typeof sendToTab !== 'function') {
            return respond(type, requestId, apiKey, { forwarded: false });
          }

          try {
            await sendToTab(tab.id, createMessage(READER_FLUSH, {}));
            return respond(type, requestId, apiKey, { forwarded: true });
          } catch (_) {
            return respond(type, requestId, apiKey, { forwarded: false });
          }
        }

        case PANEL_READY: {
          const tabInfo = await getActiveTabInfo();
          let clues = [];
          if (tabInfo.origin) {
            const gameKey = makeGameKey(tabInfo.origin, tabInfo.gameId);
            try {
              const listed = await clueStore.listClues(gameKey);
              clues = Array.isArray(listed) ? listed : [];
            } catch (_) {
              clues = [];
            }
          }
          return respond(type, requestId, apiKey, Object.assign({}, tabInfo, { clues }));
        }

        case OPTIONS_READY: {
          try {
            const settings = await settingsService.getSettings();
            const rawSites = settings ? settings.gameSites : null;
            if (Array.isArray(rawSites) && typeof settingsService.saveSettings === 'function') {
              let changed = false;
              const updated = [];
              for (const raw of rawSites) {
                if (!raw || typeof raw !== 'object' || !raw.origin) {
                  updated.push(raw);
                  continue;
                }
                let granted = false;
                if (typeof containsOrigin === 'function') {
                  try {
                    granted = !!(await containsOrigin(raw.origin));
                  } catch (_) {
                    granted = false;
                  }
                }
                if (typeof raw.granted === 'boolean' && raw.granted !== granted) {
                  changed = true;
                  updated.push(Object.assign({}, raw, { granted }));
                } else {
                  updated.push(raw);
                }
              }
              if (changed) {
                try {
                  await settingsService.saveSettings({ gameSites: updated });
                } catch (_) {
                  /* 同步失败忽略 */
                }
              }
            }
          } catch (_) {
            /* 权限同步失败忽略 */
          }
          return respond(type, requestId, apiKey, { ready: true });
        }

        default: {
          return fail(type, requestId, apiKey, '未知的请求类型');
        }
      }
    } catch (err) {
      const errorMessage = err && err.message ? err.message : '处理请求时发生未知错误';
      return fail(type, requestId, apiKey, errorMessage);
    }
  }

  return { handleMessage };
}

export default createMessageRouter;
