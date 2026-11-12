// 后台服务工作线程：为网页游戏解谜扩展创建薄封装，业务消息统一交由 message-router 处理
// 作者：Banana
import { createChromeStorageAdapter } from '../adapters/storage.js';
import { createFetchHttpAdapter } from '../adapters/http.js';
import { createResponse } from '../core/messages.js';
import { createSettingsService, normalizeOrigin } from '../core/settings.js';
import { createClueStore } from '../core/clues.js';
import { createAiClient } from '../core/ai.js';
import { createMessageRouter } from './message-router.js';

function hashString(input) {
  const text = String(input == null ? '' : input);
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash << 5) - hash + text.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

function resolveOrigin(origin) {
  try {
    const normalized = normalizeOrigin(origin);
    if (typeof normalized === 'string' && normalized) {
      return normalized.replace(/\/+$/, '');
    }
  } catch (err) {
    // 规范化失败时回退到原始值
  }
  return String(origin == null ? '' : origin).replace(/\/+$/, '');
}

function originPattern(origin) {
  return `${resolveOrigin(origin)}/*`;
}

const permissionsAdapter = {
  // 权限已由设置页在用户点击时申请，后台仅检查
  async requestOrigin(origin) {
    if (typeof chrome === 'undefined' || !chrome?.permissions?.contains) return false;
    try {
      return await chrome.permissions.contains({ origins: [originPattern(origin)] });
    } catch (err) {
      return false;
    }
  },
  async removeOrigin(origin) {
    if (typeof chrome === 'undefined' || !chrome?.permissions?.remove) return false;
    try {
      return await chrome.permissions.remove({ origins: [originPattern(origin)] });
    } catch (err) {
      return false;
    }
  },
  async containsOrigin(origin) {
    if (typeof chrome === 'undefined' || !chrome?.permissions?.contains) return false;
    try {
      return await chrome.permissions.contains({ origins: [originPattern(origin)] });
    } catch (err) {
      return false;
    }
  },
  // 权限已由设置页在用户点击时申请，后台仅检查
  async requestHost(origins) {
    if (typeof chrome === 'undefined' || !chrome?.permissions?.contains) return false;
    const list = Array.isArray(origins) ? origins : [];
    const patterns = [];
    for (const item of list) {
      if (typeof item !== 'string' || !item) continue;
      const cleaned = item.replace(/\/+$/, '');
      patterns.push(cleaned.endsWith('/*') ? cleaned : `${cleaned}/*`);
    }
    if (!patterns.length) return false;
    try {
      return await chrome.permissions.contains({ origins: patterns });
    } catch (err) {
      return false;
    }
  },
  async registerReader(origin) {
    if (typeof chrome === 'undefined' || !chrome?.scripting) return false;
    const scriptId = `reader_${hashString(resolveOrigin(origin))}`;
    try {
      try {
        await chrome.scripting.unregisterContentScripts({ ids: [scriptId] });
      } catch (err) {
        // 未注册时忽略
      }
      await chrome.scripting.registerContentScripts([
        {
          id: scriptId,
          matches: [originPattern(origin)],
          js: ['content/reader.js'],
          persistAcrossSessions: true,
          runAt: 'document_idle'
        }
      ]);
      return true;
    } catch (err) {
      return false;
    }
  },
  async unregisterReader(origin) {
    if (typeof chrome === 'undefined' || !chrome?.scripting) return false;
    const scriptId = `reader_${hashString(resolveOrigin(origin))}`;
    try {
      await chrome.scripting.unregisterContentScripts({ ids: [scriptId] });
      return true;
    } catch (err) {
      return false;
    }
  }
};

const storage = createChromeStorageAdapter();
const http = createFetchHttpAdapter();
const settingsService = createSettingsService({ storage, permissions: permissionsAdapter });
const clueStore = createClueStore({ storage });
const aiClient = createAiClient({ http, getSettings: () => settingsService.getSettings() });

if (typeof chrome !== 'undefined' && chrome?.sidePanel && typeof chrome.sidePanel.setPanelBehavior === 'function') {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

const screenshotThrottleMap = new Map();

const router = createMessageRouter({
  settingsService,
  clueStore,
  aiClient,
  screenshotThrottleMap,
  now: Date.now,
  async getActiveTab() {
    if (typeof chrome === 'undefined' || !chrome?.tabs?.query) return null;
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const tab = Array.isArray(tabs) ? tabs[0] : null;
    if (!tab) return null;
    return {
      id: tab.id,
      url: tab.url,
      title: tab.title,
      windowId: tab.windowId
    };
  },
  async getTabById(tabId) {
    if (typeof chrome === 'undefined' || !chrome?.tabs?.get) return null;
    try {
      const tab = await chrome.tabs.get(tabId);
      if (!tab) return null;
      return {
        id: tab.id,
        url: tab.url,
        title: tab.title,
        windowId: tab.windowId
      };
    } catch (err) {
      return null;
    }
  },
  containsOrigin: (origin) => permissionsAdapter.containsOrigin(origin),
  async captureVisibleTab(windowId, opts) {
    if (typeof chrome === 'undefined' || !chrome?.tabs?.captureVisibleTab) return null;
    return await chrome.tabs.captureVisibleTab(windowId, opts);
  },
  async sendToTab(tabId, message) {
    if (typeof chrome === 'undefined' || !chrome?.tabs?.sendMessage) return null;
    return await chrome.tabs.sendMessage(tabId, message);
  },
  broadcast(msg) {
    if (typeof chrome === 'undefined') return;
    if (!chrome?.runtime?.sendMessage) return;
    const result = chrome.runtime.sendMessage(msg);
    if (result && typeof result.catch === 'function') result.catch(() => {});
  }
});

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return false;
    (async () => {
      let currentApiKey = null;
      try {
        const current = await settingsService.getSettings();
        currentApiKey = current && current.apiKey ? current.apiKey : null;
      } catch (err) {
        currentApiKey = null;
      }
      try {
        const res = await router.handleMessage(message, sender);
        sendResponse(res);
      } catch (err) {
        sendResponse(
          createResponse(
            message.type,
            message.requestId,
            false,
            null,
            (err && err.message) || '后台服务执行异常',
            currentApiKey
          )
        );
      }
    })();
    return true;
  });
}
