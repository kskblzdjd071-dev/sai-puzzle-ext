// 职责：提供统一的键值存储抽象，包含 Chrome 扩展存储与纯内存存储实现
// 作者：架构组

/**
 * 创建基于 chrome.storage.local 的存储适配器
 * @returns {import('../core/models.js').StorageAdapter}
 */
export function createChromeStorageAdapter() {
  const chromeObj = globalThis.chrome;
  if (!chromeObj || !chromeObj.storage || !chromeObj.storage.local) {
    throw new Error('当前运行环境未检测到有效的 chrome.storage.local 接口');
  }

  const local = chromeObj.storage.local;

  return {
    async get(key) {
      return new Promise((resolve, reject) => {
        local.get([key], (items) => {
          const err = chromeObj.runtime && chromeObj.runtime.lastError;
          if (err) {
            return reject(new Error(err.message || '读取存储失败'));
          }
          resolve(items ? items[key] : undefined);
        });
      });
    },

    async set(key, value) {
      return new Promise((resolve, reject) => {
        local.set({ [key]: value }, () => {
          const err = chromeObj.runtime && chromeObj.runtime.lastError;
          if (err) {
            const msg = String(err.message || '');
            if (msg.includes('QUOTA_BYTES') || msg.includes('quota')) {
              return reject(new Error('存储空间超出限额，写入失败'));
            }
            return reject(new Error(msg || '写入存储失败'));
          }
          resolve();
        });
      });
    },

    async remove(key) {
      return new Promise((resolve, reject) => {
        local.remove([key], () => {
          const err = chromeObj.runtime && chromeObj.runtime.lastError;
          if (err) {
            return reject(new Error(err.message || '删除存储项失败'));
          }
          resolve();
        });
      });
    },

    async listKeys(prefix = '') {
      return new Promise((resolve, reject) => {
        local.get(null, (items) => {
          const err = chromeObj.runtime && chromeObj.runtime.lastError;
          if (err) {
            return reject(new Error(err.message || '获取存储键列表失败'));
          }
          const allKeys = Object.keys(items || {});
          if (!prefix) {
            return resolve(allKeys);
          }
          resolve(allKeys.filter((k) => k.startsWith(prefix)));
        });
      });
    }
  };
}

/**
 * 创建纯内存存储适配器（用于单测、Node.js 与无扩展环境）
 * @param {Record<string, any>} [initial]
 * @returns {import('../core/models.js').StorageAdapter}
 */
export function createMemoryStorageAdapter(initial = {}) {
  const map = new Map();

  if (initial && typeof initial === 'object') {
    for (const [k, v] of Object.entries(initial)) {
      map.set(k, structuredClone(v));
    }
  }

  return {
    async get(key) {
      if (!map.has(key)) {
        return undefined;
      }
      return structuredClone(map.get(key));
    },

    async set(key, value) {
      try {
        map.set(key, structuredClone(value));
      } catch (err) {
        throw new Error('存储空间超出限额，写入失败');
      }
    },

    async remove(key) {
      map.delete(key);
    },

    async listKeys(prefix = '') {
      const keys = Array.from(map.keys());
      if (!prefix) {
        return keys;
      }
      return keys.filter((k) => k.startsWith(prefix));
    }
  };
}
