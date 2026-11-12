// 职责：核心领域模型接口定义与主键合成/拆解等纯函数工具
// 作者：架构组

/**
 * 合成游戏复合唯一主键
 * @param {string} origin
 * @param {string} [gameId]
 * @returns {string}
 */
export function makeGameKey(origin, gameId) {
  if (!origin || typeof origin !== 'string') {
    throw new Error('无效的 origin 参数');
  }
  const cleanOrigin = origin.trim();
  if (!gameId || typeof gameId !== 'string' || !gameId.trim()) {
    return cleanOrigin;
  }
  return `${cleanOrigin}::${gameId.trim()}`;
}

/**
 * 从复合主键反解出 origin 与 gameId
 * @param {string} gameKey
 * @returns {{ origin: string, gameId?: string }}
 */
export function parseGameKey(gameKey) {
  if (!gameKey || typeof gameKey !== 'string') {
    throw new Error('无效的 gameKey 参数');
  }
  const parts = gameKey.split('::');
  const origin = parts[0];
  const gameId = parts.length > 1 ? parts.slice(1).join('::') : undefined;
  return {
    origin,
    gameId: gameId && gameId.length > 0 ? gameId : undefined
  };
}
