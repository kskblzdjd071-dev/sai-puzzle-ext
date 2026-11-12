// 职责：跨端与扩展内部通信消息类型常量定义、消息体与安全响应构造器
// 作者：架构组

export const PING = 'PING';
export const PANEL_READY = 'PANEL_READY';
export const OPTIONS_READY = 'OPTIONS_READY';
export const ACTIVE_TAB_INFO = 'ACTIVE_TAB_INFO';
export const SETTINGS_GET = 'SETTINGS_GET';
export const SETTINGS_SAVE = 'SETTINGS_SAVE';
export const SITES_ADD = 'SITES_ADD';
export const SITES_REMOVE = 'SITES_REMOVE';
export const PROVIDER_PERMISSION_REQUEST = 'PROVIDER_PERMISSION_REQUEST';
export const CLUES_LIST = 'CLUES_LIST';
export const CLUES_LIST_GAMES = 'CLUES_LIST_GAMES';
export const CLUES_EXPORT = 'CLUES_EXPORT';
export const CLUES_UPDATED = 'CLUES_UPDATED';
export const READER_CONFIG = 'READER_CONFIG';
export const READER_DELTA = 'READER_DELTA';
export const READER_FLUSH = 'READER_FLUSH';
export const READER_SCREENSHOT_REQUEST = 'READER_SCREENSHOT_REQUEST';
export const READER_SCREENSHOT_RESULT = 'READER_SCREENSHOT_RESULT';
export const AI_EXTRACT = 'AI_EXTRACT';
export const AI_ASK = 'AI_ASK';

export const MESSAGE_TYPES = [
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
  READER_CONFIG,
  READER_DELTA,
  READER_FLUSH,
  READER_SCREENSHOT_REQUEST,
  READER_SCREENSHOT_RESULT,
  AI_EXTRACT,
  AI_ASK
];

function generateId() {
  return 'req_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

/**
 * 校验并净化错误信息，彻底替换可能存在的敏感密钥
 * @param {string} message
 * @param {string} [apiKey]
 * @returns {string}
 */
export function assertSafeErrorMessage(message, apiKey) {
  if (!message || typeof message !== 'string') {
    return '未知错误';
  }

  let sanitized = message;

  if (apiKey && typeof apiKey === 'string' && apiKey.trim().length > 0) {
    sanitized = sanitized.replaceAll(apiKey, '（已隐藏敏感信息）');
  }

  sanitized = sanitized
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '（已隐藏敏感信息）')
    .replace(/AIza[A-Za-z0-9_-]{8,}/g, '（已隐藏敏感信息）');

  return sanitized;
}

/**
 * 构造标准扩展请求消息体
 * @param {string} type
 * @param {any} payload
 * @param {string} [requestId]
 */
export function createMessage(type, payload = {}, requestId) {
  return {
    type,
    requestId: requestId || generateId(),
    payload
  };
}

/**
 * 构造标准扩展响应消息体（含错误敏感信息清洗）
 * @param {string} type
 * @param {string} requestId
 * @param {boolean} ok
 * @param {any} [payload]
 * @param {string} [errorMessage]
 * @param {string} [apiKey]
 */
export function createResponse(type, requestId, ok, payload, errorMessage, apiKey) {
  const res = {
    type,
    requestId,
    ok: Boolean(ok)
  };

  if (ok) {
    res.payload = payload;
  } else {
    const rawError = errorMessage || '操作执行失败';
    res.error = {
      message: assertSafeErrorMessage(rawError, apiKey)
    };
  }

  return res;
}
