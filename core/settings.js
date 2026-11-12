// 职责：管理设置持久化、API 密钥脱敏与游戏站点/AI 域名动态权限申请
// 作者：Allen

/** @type {import('./models.js').Settings} */
export const DEFAULT_SETTINGS = {
  provider: 'openai_compatible',
  apiKey: '',
  model: 'gpt-4o',
  baseUrl: 'https://api.openai.com/v1',
  gameSites: [],
  batchIntervalMs: 5000,
  screenshotMaxIntervalMs: 30000
};

const SETTINGS_STORAGE_KEY = 'settings:v1';

/**
 * 规范化 Origin（协议+域名+端口，剔除尾部斜杠、路径与查询）
 * @param {string} urlOrOrigin
 * @returns {string}
 */
export function normalizeOrigin(urlOrOrigin) {
  if (!urlOrOrigin || typeof urlOrOrigin !== 'string') {
    throw new Error('无效的 URL 格式，请输入正确的网址');
  }

  let text = urlOrOrigin.trim();
  if (!text.includes('://')) {
    text = 'https://' + text;
  }

  try {
    const parsed = new URL(text);
    if (!parsed.protocol || !parsed.host || !['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error();
    }
    return parsed.origin;
  } catch (_) {
    throw new Error('无效的 URL 格式，请输入正确的网址');
  }
}

/**
 * 对敏感密钥进行掩码脱敏
 * @param {string} value
 * @returns {string}
 */
export function redactSecret(value) {
  if (!value || typeof value !== 'string') {
    return '';
  }
  if (value.length < 8) {
    return '****';
  }
  return value.slice(0, 3) + '****' + value.slice(-4);
}

/**
 * 创建设置管理服务
 * @param {{ storage: import('./models.js').StorageAdapter, permissions: any }} param0
 */
export function createSettingsService({ storage, permissions }) {
  if (!storage) {
    throw new Error('缺少必需的 storage 适配器');
  }

  async function loadRawSettings() {
    const data = await storage.get(SETTINGS_STORAGE_KEY);
    if (!data) {
      return structuredClone(DEFAULT_SETTINGS);
    }
    return {
      ...structuredClone(DEFAULT_SETTINGS),
      ...data,
      gameSites: Array.isArray(data.gameSites) ? structuredClone(data.gameSites) : []
    };
  }

  return {
    async getSettings() {
      const current = await loadRawSettings();
      return structuredClone(current);
    },

    async saveSettings(partial) {
      if (!partial || typeof partial !== 'object') {
        throw new Error('设置更新参数无效');
      }

      const current = await loadRawSettings();
      const updated = {
        ...current,
        ...partial
      };

      if (Array.isArray(partial.gameSites)) {
        updated.gameSites = structuredClone(partial.gameSites);
      }

      await storage.set(SETTINGS_STORAGE_KEY, updated);
      return structuredClone(updated);
    },

    async getRedactedSettings() {
      const settings = await loadRawSettings();
      const { apiKey, ...rest } = settings;
      return {
        ...rest,
        apiKeyMasked: redactSecret(apiKey),
        hasApiKey: Boolean(apiKey && apiKey.trim().length > 0)
      };
    },

    async addGameSite(origin, gameId) {
      if (!permissions || typeof permissions.requestOrigin !== 'function') {
        throw new Error('权限管理端口不可用');
      }

      const normOrigin = normalizeOrigin(origin);
      const granted = await permissions.requestOrigin(normOrigin);

      if (granted && typeof permissions.registerReader === 'function') {
        await permissions.registerReader(normOrigin);
      }

      const settings = await loadRawSettings();
      const list = [...settings.gameSites];
      const existingIdx = list.findIndex(
        (s) => s.origin === normOrigin && (s.gameId || '') === (gameId || '')
      );

      const siteRecord = {
        origin: normOrigin,
        gameId: gameId || undefined,
        enabled: true,
        granted: Boolean(granted),
        addedAt: Date.now()
      };

      if (existingIdx >= 0) {
        list[existingIdx] = {
          ...list[existingIdx],
          ...siteRecord,
          addedAt: list[existingIdx].addedAt
        };
      } else {
        list.push(siteRecord);
      }

      await storage.set(SETTINGS_STORAGE_KEY, {
        ...settings,
        gameSites: list
      });

      return {
        site: siteRecord,
        granted: Boolean(granted)
      };
    },

    async removeGameSite(origin, gameId) {
      if (!permissions) {
        throw new Error('权限管理端口不可用');
      }

      const normOrigin = normalizeOrigin(origin);
      const settings = await loadRawSettings();
      const list = settings.gameSites.filter(
        (s) => !(s.origin === normOrigin && (s.gameId || '') === (gameId || ''))
      );

      const hasRemainingForOrigin = list.some((s) => s.origin === normOrigin);

      if (!hasRemainingForOrigin) {
        if (typeof permissions.unregisterReader === 'function') {
          await permissions.unregisterReader(normOrigin);
        }
        if (typeof permissions.removeOrigin === 'function') {
          await permissions.removeOrigin(normOrigin);
        }
      }

      await storage.set(SETTINGS_STORAGE_KEY, {
        ...settings,
        gameSites: list
      });

      return { ok: true };
    },

    async requestProviderHostPermission(provider, baseUrl) {
      if (!permissions || typeof permissions.requestHost !== 'function') {
        throw new Error('权限管理端口不支持请求宿主权限');
      }

      let hostPattern = '';
      if (provider === 'openai_compatible') {
        if (baseUrl) {
          const origin = normalizeOrigin(baseUrl);
          hostPattern = `${origin}/*`;
        } else {
          hostPattern = 'https://api.openai.com/*';
        }
      } else if (provider === 'deepseek') {
        hostPattern = 'https://api.deepseek.com/*';
      } else if (provider === 'gemini') {
        hostPattern = 'https://generativelanguage.googleapis.com/*';
      } else {
        throw new Error(`未知的服务商类型: ${provider}`);
      }

      const granted = await permissions.requestHost([hostPattern]);
      return Boolean(granted);
    }
  };
}
