// 职责：线索主键维护、小写空白去重、按时间升序归档与脱敏导出
// 作者：Peter

import { makeGameKey, parseGameKey } from './models.js';

export { makeGameKey, parseGameKey };

const CLUE_PREFIX = 'clues:v1:';

/**
 * 生成规范化的去重判定键（去除两端空白，内部压缩单空格，全小写）
 * @param {{ text: string }} clue
 * @returns {string}
 */
/**
 * 将文本中的 API Key 及明显形态密钥（sk- / AIza）替换为 ***
 * @param {string} text
 * @param {string} [apiKey]
 * @returns {string}
 */
export function sanitizeSecretText(text, apiKey) {
  if (!text || typeof text !== 'string') {
    return text || '';
  }
  let sanitized = text;
  if (apiKey && typeof apiKey === 'string' && apiKey.trim().length >= 16) {
    sanitized = sanitized.replaceAll(apiKey, '***');
  }
  return sanitized
    .replace(/(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/g, '***')
    .replace(/(?<![A-Za-z0-9])AIza[A-Za-z0-9_-]{16,}/g, '***');
}

export function dedupeKey(clue) {
  if (!clue || typeof clue.text !== 'string') {
    return '';
  }
  return clue.text.trim().replace(/\s+/g, ' ').toLowerCase();
}

function sanitizeClue(clue, apiKey) {
  if (!clue) return clue;
  return {
    ...clue,
    text: sanitizeSecretText(clue.text, apiKey),
    tags: Array.isArray(clue.tags)
      ? clue.tags.map((t) => sanitizeSecretText(t, apiKey))
      : clue.tags
  };
}

function sanitizeQa(qaItem, apiKey) {
  if (!qaItem) return qaItem;
  return {
    ...qaItem,
    question: sanitizeSecretText(qaItem.question, apiKey),
    answer: sanitizeSecretText(qaItem.answer, apiKey),
    summary: typeof qaItem.summary === 'string' ? sanitizeSecretText(qaItem.summary, apiKey) : qaItem.summary
  };
}

function sanitizeGameRecord(game, apiKey) {
  if (!game) return game;
  return {
    ...game,
    clues: Array.isArray(game.clues) ? game.clues.map((c) => sanitizeClue(c, apiKey)) : [],
    qa: Array.isArray(game.qa) ? game.qa.map((q) => sanitizeQa(q, apiKey)) : []
  };
}

/**
 * 递归深度校验对象中是否存在任何形式的明文密钥/基础地址属性名
 * @param {any} obj
 */
function assertNoSensitiveKeys(obj) {
  if (!obj || typeof obj !== 'object') {
    return;
  }
  if (Array.isArray(obj)) {
    for (const item of obj) {
      assertNoSensitiveKeys(item);
    }
    return;
  }
  for (const k of Object.keys(obj)) {
    const lk = k.toLowerCase().replace(/[-_]/g, '');
    if (lk === 'apikey' || lk === 'baseurl') {
      throw new Error('严重安全违规：导出数据中检测到敏感配置字段');
    }
    assertNoSensitiveKeys(obj[k]);
  }
}

/**
 * 创建线索持久化仓库
 * @param {{ storage: import('./models.js').StorageAdapter, now?: () => number, id?: () => string, getApiKey?: () => (string | Promise<string>) }} param0
 */
export function createClueStore({ storage, now = Date.now, id, getApiKey }) {
  if (!storage) {
    throw new Error('缺少必需的 storage 适配器');
  }

  function nextId() {
    if (typeof id === 'function') {
      return id();
    }
    return 'clue_' + now() + '_' + Math.random().toString(36).slice(2, 8);
  }

  function getStorageKey(gameKey) {
    return CLUE_PREFIX + gameKey;
  }

  async function readRecord(gameKey) {
    const raw = await storage.get(getStorageKey(gameKey));
    if (!raw) {
      return null;
    }
    return {
      ...raw,
      clues: Array.isArray(raw.clues) ? raw.clues : [],
      qa: Array.isArray(raw.qa) ? raw.qa : []
    };
  }

  async function getGameRecord(gameKey) {
    if (!gameKey) {
      return null;
    }
    const record = await readRecord(gameKey);
    return record ? structuredClone(record) : null;
  }

  return {
    async addClues(gameKey, clues = []) {
      if (!gameKey) {
        throw new Error('gameKey 不能为空');
      }
      if (!Array.isArray(clues) || clues.length === 0) {
        return [];
      }

      const currentApiKey = typeof getApiKey === 'function' ? await getApiKey() : '';

      let record = await readRecord(gameKey);
      if (!record) {
        const parsed = parseGameKey(gameKey);
        record = {
          gameKey,
          origin: parsed.origin,
          gameId: parsed.gameId,
          title: parsed.origin,
          clues: [],
          qa: [],
          createdAt: now(),
          updatedAt: now()
        };
      }

      const existingMap = new Set(record.clues.map((c) => dedupeKey(c)));
      const newlyAdded = [];

      for (const item of clues) {
        if (!item || !item.text || !item.text.trim()) {
          continue;
        }
        const sanitizedText = sanitizeSecretText(item.text.trim(), currentApiKey);
        if (!sanitizedText) {
          continue;
        }
        const key = dedupeKey({ text: sanitizedText });
        if (existingMap.has(key)) {
          continue;
        }
        existingMap.add(key);

        const newClue = {
          id: nextId(),
          gameKey,
          text: sanitizedText,
          source: item.source || 'text',
          createdAt: now(),
          tags: Array.isArray(item.tags)
            ? item.tags.map((t) => sanitizeSecretText(String(t).trim(), currentApiKey)).filter(Boolean)
            : [],
          imageRef: item.imageRef || undefined
        };
        newlyAdded.push(newClue);
        record.clues.push(newClue);
      }

      if (newlyAdded.length > 0) {
        record.updatedAt = now();
        record.clues.sort((a, b) => a.createdAt - b.createdAt);
        await storage.set(getStorageKey(gameKey), record);
      }

      return structuredClone(newlyAdded);
    },

    async listClues(gameKey) {
      if (!gameKey) {
        throw new Error('gameKey 不能为空');
      }
      const record = await readRecord(gameKey);
      if (!record) {
        return [];
      }
      const sorted = [...record.clues].sort((a, b) => a.createdAt - b.createdAt);
      return structuredClone(sorted);
    },

    async addQa(gameKey, entry) {
      if (!gameKey) {
        throw new Error('gameKey 不能为空');
      }
      if (!entry || typeof entry !== 'object') {
        return null;
      }
      const question = typeof entry.question === 'string' ? entry.question.trim() : '';
      const answer = typeof entry.answer === 'string' ? entry.answer.trim() : '';
      if (!question || !answer) {
        return null;
      }

      let record = await readRecord(gameKey);
      if (!record) {
        const parsed = parseGameKey(gameKey);
        record = {
          gameKey,
          origin: parsed.origin,
          gameId: parsed.gameId,
          title: parsed.origin,
          clues: [],
          qa: [],
          createdAt: now(),
          updatedAt: now()
        };
      }

      const qaItem = {
        id: entry.id || nextId(),
        gameKey,
        question,
        answer,
        createdAt: now()
      };

      if (typeof entry.summary === 'string' && entry.summary.trim()) {
        qaItem.summary = entry.summary.trim();
      }
      if (Array.isArray(entry.suggestions) && entry.suggestions.length > 0) {
        qaItem.suggestions = entry.suggestions.map((s) => String(s).trim()).filter(Boolean);
      }
      if (typeof entry.model === 'string' && entry.model.trim()) {
        qaItem.model = entry.model.trim();
      }

      record.qa.push(qaItem);
      record.updatedAt = now();
      await storage.set(getStorageKey(gameKey), record);
      return structuredClone(qaItem);
    },

    async listQa(gameKey) {
      if (!gameKey) {
        throw new Error('gameKey 不能为空');
      }
      const record = await readRecord(gameKey);
      if (!record) {
        return [];
      }
      const sorted = [...record.qa].sort((a, b) => a.createdAt - b.createdAt);
      return structuredClone(sorted);
    },

    async listGames() {
      const allKeys = await storage.listKeys(CLUE_PREFIX);
      const games = [];
      for (const key of allKeys) {
        const item = await storage.get(key);
        if (item) {
          const gameKey = key.slice(CLUE_PREFIX.length);
          games.push({
            gameKey: item.gameKey || gameKey,
            origin: item.origin || parseGameKey(gameKey).origin,
            gameId: item.gameId,
            title: item.title || item.origin,
            clueCount: Array.isArray(item.clues) ? item.clues.length : 0,
            createdAt: item.createdAt || 0,
            updatedAt: item.updatedAt || 0
          });
        }
      }
      games.sort((a, b) => b.updatedAt - a.updatedAt);
      return games;
    },

    async getGame(gameKey) {
      return getGameRecord(gameKey);
    },

    async removeClue(gameKey, clueId) {
      if (!gameKey) {
        return false;
      }
      const record = await readRecord(gameKey);
      if (!record) {
        return false;
      }
      const prevLen = record.clues.length;
      record.clues = record.clues.filter((c) => c.id !== clueId);
      if (record.clues.length === prevLen) {
        return false;
      }
      record.updatedAt = now();
      await storage.set(getStorageKey(gameKey), record);
      return true;
    },

    async clearGame(gameKey) {
      if (!gameKey) {
        return;
      }
      await storage.remove(getStorageKey(gameKey));
    },

    async exportJSON(gameKey) {
      const currentApiKey = typeof getApiKey === 'function' ? await getApiKey() : '';
      let exportData;
      if (gameKey) {
        const game = await getGameRecord(gameKey);
        exportData = {
          version: '1.0',
          exportedAt: now(),
          games: game ? [sanitizeGameRecord(game, currentApiKey)] : []
        };
      } else {
        const keys = await storage.listKeys(CLUE_PREFIX);
        const list = [];
        for (const k of keys) {
          const g = await storage.get(k);
          if (g) {
            list.push(sanitizeGameRecord({
              ...g,
              clues: Array.isArray(g.clues) ? g.clues : [],
              qa: Array.isArray(g.qa) ? g.qa : []
            }, currentApiKey));
          }
        }
        exportData = {
          version: '1.0',
          exportedAt: now(),
          games: list
        };
      }

      assertNoSensitiveKeys(exportData);
      const jsonStr = JSON.stringify(exportData, null, 2);
      if (/apiKey|baseUrl/i.test(jsonStr)) {
        throw new Error('严重安全违规：导出数据中检测到敏感配置字段');
      }

      return jsonStr;
    },

    async exportMarkdown(gameKey) {
      const currentApiKey = typeof getApiKey === 'function' ? await getApiKey() : '';
      let games = [];
      if (gameKey) {
        const g = await getGameRecord(gameKey);
        if (g) games.push(sanitizeGameRecord(g, currentApiKey));
      } else {
        const keys = await storage.listKeys(CLUE_PREFIX);
        for (const k of keys) {
          const g = await storage.get(k);
          if (g) {
            games.push(sanitizeGameRecord({
              ...g,
              clues: Array.isArray(g.clues) ? g.clues : [],
              qa: Array.isArray(g.qa) ? g.qa : []
            }, currentApiKey));
          }
        }
      }

      let md = `# 游戏线索归档\n\n- 导出时间：${new Date(now()).toISOString()}\n\n`;

      if (games.length === 0) {
        md += `*暂无任何线索记录*\n`;
      } else {
        for (const game of games) {
          md += `## 游戏：${game.title || game.gameKey}\n\n`;
          md += `> 站点标识：\`${game.gameKey}\`\n\n`;
          if (!game.clues || game.clues.length === 0) {
            md += `*此游戏暂无线索*\n\n`;
          } else {
            const sorted = [...game.clues].sort((a, b) => b.createdAt - a.createdAt);
            for (const clue of sorted) {
              const tags = clue.tags && clue.tags.length ? ` \`${clue.tags.join('` `')}\`` : '';
              const time = new Date(clue.createdAt).toLocaleTimeString();
              md += `- **[${time}]** ${clue.text}${tags} *(来源: ${clue.source})*\n`;
            }
            md += '\n';
          }

          if (Array.isArray(game.qa) && game.qa.length > 0) {
            md += `### 问答记录\n\n`;
            const sortedQa = [...game.qa].sort((a, b) => a.createdAt - b.createdAt);
            for (const item of sortedQa) {
              md += `**问**：${item.question}\n\n`;
              md += `**答**：${item.answer}\n\n`;
            }
          }
        }
      }

      if (/apiKey|baseUrl/i.test(md)) {
        throw new Error('严重安全违规：Markdown 导出包含敏感信息');
      }

      return md;
    }
  };
}
