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
          js: ['content/reader-loader.js'],
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
const clueStore = createClueStore({
  storage,
  getApiKey: async () => {
    const s = await settingsService.getSettings();
    return s?.apiKey || '';
  }
});
const aiClient = createAiClient({ http, getSettings: () => settingsService.getSettings() });

// 向已打开且已授权的标签页自动注入 reader-loader
async function injectReadersIntoOpenTabs(filterOrigin) {
  if (typeof chrome === 'undefined' || !chrome.tabs?.query || !chrome.scripting?.executeScript) {
    return;
  }
  try {
    const settings = await settingsService.getSettings();
    const sites = settings && Array.isArray(settings.gameSites) ? settings.gameSites : [];
    const siteOrigins = new Set();
    for (const site of sites) {
      if (site == null) continue;
      const raw = typeof site === 'string' ? site : site.origin || site.url;
      const orig = resolveOrigin(raw);
      if (orig) siteOrigins.add(orig);
    }

    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (!tab || tab.id == null || !tab.url) continue;
      let tabOrigin = '';
      try {
        const parsed = new URL(tab.url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
        tabOrigin = resolveOrigin(parsed.origin);
      } catch (_) {
        continue;
      }
      if (!tabOrigin) continue;
      if (filterOrigin && tabOrigin !== resolveOrigin(filterOrigin)) continue;
      if (!siteOrigins.has(tabOrigin)) continue;

      let granted = false;
      try {
        granted = await permissionsAdapter.containsOrigin(tabOrigin);
      } catch (_) {
        granted = false;
      }
      if (!granted) continue;

      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content/reader-loader.js']
        });
      } catch (_) {
        // 单标签页注入失败吞掉
      }
    }
  } catch (_) {
    // 注入遍历失败吞掉
  }
}

// 包装 permissionsAdapter.registerReader，在站点注册成功后向打开的标签页补注入
const originalRegisterReader = permissionsAdapter.registerReader.bind(permissionsAdapter);
permissionsAdapter.registerReader = async function (origin) {
  const result = await originalRegisterReader(origin);
  if (result) {
    injectReadersIntoOpenTabs(origin).catch(() => {});
  }
  return result;
};

// 扩展重载/启动后，把已授权站点的 reader 脚本重新注册到最新的注入文件上并补注入
async function reregisterGrantedReaders() {
  try {
    const settings = await settingsService.getSettings();
    const sites = settings && Array.isArray(settings.gameSites) ? settings.gameSites : [];
    const origins = new Set();
    for (const site of sites) {
      if (site == null) continue;
      const raw = typeof site === 'string' ? site : site.origin || site.url;
      const origin = resolveOrigin(raw);
      if (origin) origins.add(origin);
    }
    for (const origin of origins) {
      try {
        const granted = await permissionsAdapter.containsOrigin(origin);
        if (granted) {
          await permissionsAdapter.registerReader(origin);
        }
      } catch (err) {
        // 单个站点重注册失败忽略
      }
    }
    await injectReadersIntoOpenTabs();
  } catch (err) {
    // 重注册整体失败忽略
  }
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onInstalled) {
  chrome.runtime.onInstalled.addListener(() => {
    reregisterGrantedReaders();
  });
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onStartup) {
  chrome.runtime.onStartup.addListener(() => {
    reregisterGrantedReaders();
  });
}

if (typeof chrome !== 'undefined' && chrome?.sidePanel && typeof chrome.sidePanel.setPanelBehavior === 'function') {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

const screenshotThrottleMap = new Map();

async function queryIsCanvas(tab) {
  if (!tab || tab.id == null || typeof chrome === 'undefined' || !chrome?.scripting?.executeScript) {
    return false;
  }
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const canvases = document.querySelectorAll('canvas');
        if (!canvases || canvases.length === 0) return false;
        const win = window;
        const viewportArea = (win && win.innerWidth && win.innerHeight)
          ? win.innerWidth * win.innerHeight
          : ((document.documentElement && document.documentElement.clientWidth && document.documentElement.clientHeight)
            ? document.documentElement.clientWidth * document.documentElement.clientHeight
            : 0);
        for (let i = 0; i < canvases.length; i++) {
          const cvs = canvases[i];
          const width = cvs.clientWidth || cvs.width || 0;
          const height = cvs.clientHeight || cvs.height || 0;
          const area = width * height;
          const meetsDimensions = width > 300 && height > 200;
          const meetsRatio = viewportArea > 0 && (area / viewportArea >= 0.3);
          if (meetsDimensions || meetsRatio) return true;
        }
        return false;
      }
    });
    if (Array.isArray(results) && results[0] && typeof results[0].result === 'boolean') {
      return results[0].result;
    }
    return false;
  } catch (_) {
    return false;
  }
}

async function captureCanvas(tab) {
  if (!tab || tab.id == null || typeof chrome === 'undefined' || !chrome?.scripting?.executeScript) {
    return null;
  }
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const canvases = document.querySelectorAll('canvas');
        if (!canvases || canvases.length === 0) return null;
        const win = window;
        const viewportArea = (win && win.innerWidth && win.innerHeight)
          ? win.innerWidth * win.innerHeight
          : ((document.documentElement && document.documentElement.clientWidth && document.documentElement.clientHeight)
            ? document.documentElement.clientWidth * document.documentElement.clientHeight
            : 0);
        let primary = null;
        let maxArea = 0;
        for (let i = 0; i < canvases.length; i++) {
          const cvs = canvases[i];
          const width = cvs.clientWidth || cvs.width || 0;
          const height = cvs.clientHeight || cvs.height || 0;
          const area = width * height;
          const meetsDimensions = width > 300 && height > 200;
          const meetsRatio = viewportArea > 0 && (area / viewportArea >= 0.3);
          if (meetsDimensions || meetsRatio) {
            if (area > maxArea) {
              maxArea = area;
              primary = cvs;
            }
          }
        }
        if (!primary) return null;
        try {
          return primary.toDataURL('image/jpeg', 0.7);
        } catch (_) {
          return null;
        }
      }
    });
    if (Array.isArray(results) && results[0] && typeof results[0].result === 'string') {
      return results[0].result;
    }
    return null;
  } catch (_) {
    return null;
  }
}

const router = createMessageRouter({
  settingsService,
  clueStore,
  aiClient,
  screenshotThrottleMap,
  now: Date.now,
  injectReadersIntoOpenTabs,
  queryIsCanvas,
  captureCanvas,
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
