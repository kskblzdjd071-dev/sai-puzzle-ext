// 网页游戏解谜整理插件 - 后台 Service Worker 消息枢纽
// 负责站点动态注入、权限校验、线索提取管线及侧边栏通信
import { createChromeStorageAdapter } from '../adapters/storage.js';
import { createFetchHttpAdapter } from '../adapters/http.js';
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
  READER_SCREENSHOT_REQUEST,
  AI_EXTRACT,
  AI_ASK,
  createResponse
} from '../core/messages.js';
import { createSettingsService, normalizeOrigin } from '../core/settings.js';
import { createClueStore, makeGameKey } from '../core/clues.js';
import { createAiClient } from '../core/ai.js';

const storage = createChromeStorageAdapter();
const http = createFetchHttpAdapter();

// 权限抽象层适配
const permissionsAdapter = {
  async requestOrigin(origin) {
    if (typeof chrome === 'undefined' || !chrome.permissions) return false;
    return await chrome.permissions.request({ origins: [`${origin}/*`] });
  },
  async removeOrigin(origin) {
    if (typeof chrome === 'undefined' || !chrome.permissions) return false;
    return await chrome.permissions.remove({ origins: [`${origin}/*`] });
  },
  async containsOrigin(origin) {
    if (typeof chrome === 'undefined' || !chrome.permissions) return false;
    return await chrome.permissions.contains({ origins: [`${origin}/*`] });
  },
  async requestHost(origins) {
    if (typeof chrome === 'undefined' || !chrome.permissions) return false;
    const formatted = origins.map(o => (o.endsWith('/*') ? o : `${o}/*`));
    return await chrome.permissions.request({ origins: formatted });
  },
  async registerReader(origin) {
    if (typeof chrome === 'undefined' || !chrome.scripting || !chrome.scripting.registerContentScripts) return;
    const scriptId = `reader_${hashString(origin)}`;
    try {
      await chrome.scripting.unregisterContentScripts({ ids: [scriptId] }).catch(() => {});
      await chrome.scripting.registerContentScripts([
        {
          id: scriptId,
          matches: [`${origin}/*`],
          js: ['content/reader.js'],
          persistAcrossSessions: true,
          runAt: 'document_idle'
        }
      ]);
    } catch (err) {
      // 避免重复注册错误中断流程
    }
  },
  async unregisterReader(origin) {
    if (typeof chrome === 'undefined' || !chrome.scripting || !chrome.scripting.unregisterContentScripts) return;
    const scriptId = `reader_${hashString(origin)}`;
    try {
      await chrome.scripting.unregisterContentScripts({ ids: [scriptId] });
    } catch (err) {
      // 忽略未注册错误
    }
  }
};

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

const settingsService = createSettingsService({ storage, permissions: permissionsAdapter });
const clueStore = createClueStore({ storage });
const aiClient = createAiClient({
  http,
  getSettings: () => settingsService.getSettings()
});

// 点击图标打开侧边栏
if (typeof chrome !== 'undefined' && chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

// 截图 30 秒节流缓存：tabId::origin -> timestamp
const screenshotThrottleMap = new Map();

async function handleReaderDelta(payload, sender) {
  const origin = payload.origin || (sender.tab && sender.tab.url ? normalizeOrigin(sender.tab.url) : null);
  if (!origin) return;
  const gameKey = makeGameKey(origin, payload.gameId || '');
  const deltaText = payload.delta || '';
  if (!deltaText.trim()) return;

  try {
    const rawClues = await aiClient.extractClues(deltaText, null);
    if (Array.isArray(rawClues) && rawClues.length > 0) {
      const added = await clueStore.addClues(gameKey, rawClues);
      if (added.length > 0) {
        broadcastMessage({ type: CLUES_UPDATED, payload: { gameKey, clues: added } });
      }
    }
  } catch (err) {
    // 静默处理自动提取异常，防止打断游戏
  }
}

function broadcastMessage(msg) {
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
    chrome.runtime.sendMessage(msg).catch(() => {});
  }
}

// 消息转发中心
if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return false;

    (async () => {
      let currentApiKey = null;
      try {
        const s = await settingsService.getSettings().catch(() => null);
        currentApiKey = s && s.apiKey ? s.apiKey : null;
      } catch (e) {
        // 忽略设置读取失败
      }

      try {
        switch (message.type) {
          case PING: {
            sendResponse(createResponse(PING, message.requestId, true, { pong: true }));
            break;
          }
          case SETTINGS_GET: {
            const redacted = await settingsService.getRedactedSettings();
            sendResponse(createResponse(SETTINGS_GET, message.requestId, true, redacted));
            break;
          }
          case SETTINGS_SAVE: {
            const saved = await settingsService.saveSettings(message.payload || {});
            sendResponse(createResponse(SETTINGS_SAVE, message.requestId, true, saved));
            break;
          }
          case SITES_ADD: {
            const sites = await settingsService.addGameSite(message.payload?.site);
            sendResponse(createResponse(SITES_ADD, message.requestId, true, { sites }));
            break;
          }
          case SITES_REMOVE: {
            const sites = await settingsService.removeGameSite(message.payload?.site);
            sendResponse(createResponse(SITES_REMOVE, message.requestId, true, { sites }));
            break;
          }
          case PROVIDER_PERMISSION_REQUEST: {
            const ok = await settingsService.requestProviderHostPermission(message.payload?.provider);
            sendResponse(createResponse(PROVIDER_PERMISSION_REQUEST, message.requestId, true, { granted: ok }));
            break;
          }
          case CLUES_LIST: {
            const clues = await clueStore.listClues(message.payload?.gameKey);
            sendResponse(createResponse(CLUES_LIST, message.requestId, true, clues));
            break;
          }
          case CLUES_LIST_GAMES: {
            const games = await clueStore.listGames();
            sendResponse(createResponse(CLUES_LIST_GAMES, message.requestId, true, games));
            break;
          }
          case CLUES_EXPORT: {
            const format = message.payload?.format || 'json';
            const output = format === 'markdown'
              ? await clueStore.exportMarkdown(message.payload?.gameKey)
              : await clueStore.exportJSON(message.payload?.gameKey);
            sendResponse(createResponse(CLUES_EXPORT, message.requestId, true, { content: output }));
            break;
          }
          case ACTIVE_TAB_INFO: {
            if (chrome.tabs && chrome.tabs.query) {
              const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
              sendResponse(createResponse(ACTIVE_TAB_INFO, message.requestId, true, { tab: tab || null }));
            } else {
              sendResponse(createResponse(ACTIVE_TAB_INFO, message.requestId, true, { tab: null }));
            }
            break;
          }
          case AI_EXTRACT: {
            const { delta, image } = message.payload || {};
            const extracted = await aiClient.extractClues(delta, image);
            sendResponse(createResponse(AI_EXTRACT, message.requestId, true, extracted));
            break;
          }
          case AI_ASK: {
            const { question, clues } = message.payload || {};
            const answer = await aiClient.answerQuestion(question, clues || []);
            sendResponse(createResponse(AI_ASK, message.requestId, true, { answer }));
            break;
          }
          case READER_DELTA: {
            await handleReaderDelta(message.payload || {}, sender);
            sendResponse(createResponse(READER_DELTA, message.requestId, true, { queued: true }));
            break;
          }
          case READER_SCREENSHOT_REQUEST: {
            const tabId = sender.tab?.id;
            const tabUrl = sender.tab?.url;
            if (!tabId || !tabUrl) {
              sendResponse(createResponse(READER_SCREENSHOT_REQUEST, message.requestId, false, null, '无法识别当前标签页'));
              return;
            }
            const origin = normalizeOrigin(tabUrl);
            const throttleKey = `${tabId}::${origin}`;
            const now = Date.now();
            const lastTime = screenshotThrottleMap.get(throttleKey) || 0;
            if (now - lastTime < 30000) {
              const remaining = Math.ceil((30000 - (now - lastTime)) / 1000);
              sendResponse(createResponse(READER_SCREENSHOT_REQUEST, message.requestId, false, null, `截图请求过于频繁，请等待 ${remaining} 秒`));
              return;
            }
            const allowed = await permissionsAdapter.containsOrigin(origin);
            if (!allowed) {
              sendResponse(createResponse(READER_SCREENSHOT_REQUEST, message.requestId, false, null, '该站点尚未获得授权截屏'));
              return;
            }
            screenshotThrottleMap.set(throttleKey, now);
            const dataUrl = await chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' });
            sendResponse(createResponse(READER_SCREENSHOT_REQUEST, message.requestId, true, { dataUrl }));
            break;
          }
          case PANEL_READY:
          case OPTIONS_READY: {
            sendResponse(createResponse(message.type, message.requestId, true, { ready: true }));
            break;
          }
          default:
            sendResponse(createResponse(message.type, message.requestId, false, null, `未知的请求类型: ${message.type}`));
        }
      } catch (err) {
        sendResponse(createResponse(message.type, message.requestId, false, null, err.message || '后台服务执行异常', currentApiKey));
      }
    })();

    return true; // 保持异步消息通道
  });
}
