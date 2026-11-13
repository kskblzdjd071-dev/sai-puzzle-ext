// 职责：负责网页正文文本增量提取、Canvas 视觉监控与截图触发
// 作者：Look

import {
  READER_CONFIG,
  READER_DELTA,
  READER_FLUSH,
  READER_SCREENSHOT_REQUEST,
  READER_SCREENSHOT_RESULT,
  createMessage
} from '../core/messages.js';

let currentConfig = {
  batchIntervalMs: 5000,
  screenshotMaxIntervalMs: 30000,
  gameKey: '',
  enabled: true
};

let previousText = '';
let isDomDirty = false;
let batchTimer = null;
let visualTimer = null;
let cooldownTimer = null;
let domObserver = null;
let floatingButton = null;
let lastScreenshotTime = 0;
let lastCanvasHash = null;
let isListenerRegistered = false;

// 注入时钟支持（测试与文本稳定检测）
let getNow = () => Date.now();

// 跟踪同一文本骨架中各数字 slot 的变动历史
// slotKey -> {
//   skeleton: string,
//   slotIndex: number,
//   lastVal: string,
//   changeTimes: number[],
//   isJumping: boolean,
//   lastChangeAt: number,
//   finalEmitted: boolean
// }
let slotTracker = new Map();

function safeGetDoc() {
  return typeof document !== 'undefined' ? document : null;
}

function safeGetWindow() {
  return typeof window !== 'undefined' ? window : null;
}

function safeSendMessage(message) {
  if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
    try {
      chrome.runtime.sendMessage(message, () => {
        if (chrome.runtime.lastError) {
          // 忽略接收端未建立或断开时的错误，防止未捕获异常
        }
      });
    } catch {
      // 忽略发送异常
    }
  }
}

function isElementVisible(elem, win) {
  if (!elem || elem.nodeType !== 1) return false;

  let styleObj = null;
  if (win && typeof win.getComputedStyle === 'function') {
    try {
      styleObj = win.getComputedStyle(elem);
    } catch {
      styleObj = null;
    }
  }
  if (!styleObj && elem.style) {
    styleObj = elem.style;
  }

  if (styleObj) {
    if (styleObj.display === 'none' || styleObj.visibility === 'hidden') {
      return false;
    }
  }

  const tag = elem.tagName ? elem.tagName.toLowerCase() : '';
  const rawRole = elem.getAttribute ? elem.getAttribute('role') : null;
  const role = rawRole ? rawRole.toLowerCase() : null;

  const isNavigationTag = tag === 'nav' || tag === 'header' || tag === 'footer';
  const isNavigationRole = role === 'navigation' || role === 'contentinfo' || role === 'banner';

  if (isNavigationTag || isNavigationRole) {
    if (styleObj && (styleObj.position === 'fixed' || styleObj.position === 'sticky')) {
      return false;
    }
    if (!styleObj && isNavigationRole) {
      return false;
    }
  }

  return true;
}

export function collectVisibleText(doc = safeGetDoc()) {
  if (!doc) return '';
  const root = doc.body || doc.documentElement || doc;
  if (!root) return '';

  const win = doc.defaultView || safeGetWindow();
  const ignoredTags = new Set(['script', 'style', 'noscript', 'iframe', 'svg']);

  const texts = [];

  function traverse(node) {
    if (!node) return;
    if (node.nodeType === 3) {
      const val = node.nodeValue;
      if (val && val.trim().length > 0) {
        texts.push(val);
      }
      return;
    }

    if (node.nodeType === 1) {
      if (typeof node.getAttribute === 'function' && node.getAttribute('data-sai-ext') !== null) {
        return;
      }

      const tag = node.tagName ? node.tagName.toLowerCase() : '';
      if (ignoredTags.has(tag)) return;
      if (!isElementVisible(node, win)) return;

      let child = node.firstChild;
      while (child) {
        traverse(child);
        child = child.nextSibling;
      }
    }
  }

  traverse(root);
  return texts.join(' ').replace(/\s+/g, ' ').trim();
}

// 归一化明确的计时/倒计时/时钟格式
function normalizeTemporalTokens(str) {
  if (!str) return '';
  return str
    .replace(/(?:剩余|剩余时间|倒计时|冷却)?\s*\b\d{1,2}:\d{2}(?::\d{2})?\b/gi, '__TIME__')
    .replace(/(?:剩余|剩余时间|冷却)?\s*\d+(?:\.\d+)?\s*(?:秒|s|sec|seconds?)\b/gi, '__TIME__')
    .replace(/倒计时\s*\d+/gi, '__TIME__')
    .replace(/\s+/g, ' ')
    .trim();
}

// 提取文本中的数字 token 以及剥离数字后的骨架
function extractNumericSlots(str) {
  const tokens = [];
  let tokenIndex = 0;
  const skeleton = str.replace(/\d+/g, (match) => {
    tokens.push({ val: match, index: tokenIndex++ });
    return '__NUM_SLOT__';
  });
  return { skeleton, tokens };
}

export function computeDelta(prev, next) {
  const p = (prev == null ? '' : String(prev)).replace(/\s+/g, ' ').trim();
  const n = (next == null ? '' : String(next)).replace(/\s+/g, ' ').trim();

  if (!n) return '';
  if (!p) return n;
  if (p === n) return '';

  // (a) 若仅有计时/倒计时/时钟发生变化，则返回空串
  if (normalizeTemporalTokens(p) === normalizeTemporalTokens(n)) {
    return '';
  }

  if (n.startsWith(p)) {
    const tail = n.slice(p.length).replace(/\s+/g, ' ').trim();
    return tail;
  }

  const idx = n.indexOf(p);
  if (idx !== -1) {
    const tail = n.slice(idx + p.length).replace(/\s+/g, ' ').trim();
    return tail;
  }

  const prevParts = p.split(/(?<=[。！？.!?\n])\s*/).filter(Boolean);
  const nextParts = n.split(/(?<=[。！？.!?\n])\s*/).filter(Boolean);

  const prevSlice = prevParts.slice(-400);
  const nextSlice = nextParts.slice(-400);
  const prevSet = new Set(prevSlice);

  const diffParts = [];
  for (const part of nextSlice) {
    if (!prevSet.has(part)) {
      diffParts.push(part);
    }
  }

  const result = diffParts.join('\n').replace(/[ \t]+/g, ' ').trim();
  if (!result || result === p) {
    // 骨架等价但非计时数字发生单次同位变化时的保全（如「保险箱密码 4721」->「保险箱密码 9035」）
    const pSlots = extractNumericSlots(p);
    const nSlots = extractNumericSlots(n);
    if (pSlots.skeleton === nSlots.skeleton && pSlots.tokens.length === nSlots.tokens.length) {
      return n;
    }
    return '';
  }
  return result;
}

export function shouldCaptureCanvas(doc = safeGetDoc()) {
  return findPrimaryCanvas(doc) !== null;
}

function findPrimaryCanvas(doc = safeGetDoc()) {
  if (!doc || typeof doc.querySelectorAll !== 'function') return null;

  const canvases = doc.querySelectorAll('canvas');
  if (!canvases || canvases.length === 0) return null;

  const win = doc.defaultView || safeGetWindow();
  let viewportArea = 0;
  if (win && win.innerWidth && win.innerHeight) {
    viewportArea = win.innerWidth * win.innerHeight;
  } else if (doc.documentElement && doc.documentElement.clientWidth && doc.documentElement.clientHeight) {
    viewportArea = doc.documentElement.clientWidth * doc.documentElement.clientHeight;
  }

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

  return primary;
}

function getCanvasHash(canvas) {
  if (!canvas) return null;
  const doc = safeGetDoc();
  if (!doc) return null;

  try {
    const offscreen = doc.createElement('canvas');
    offscreen.width = 16;
    offscreen.height = 16;
    const ctx = offscreen.getContext('2d');
    if (!ctx) return null;

    ctx.drawImage(canvas, 0, 0, 16, 16);
    const imgData = ctx.getImageData(0, 0, 16, 16);
    const data = imgData.data;

    let hash = 0;
    for (let i = 0; i < data.length; i += 4) {
      const gray = Math.round(data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
      hash = ((hash << 5) - hash + gray) | 0;
    }
    return String(hash);
  } catch {
    return null;
  }
}

function updateButtonCooldownUI() {
  if (!floatingButton) return;
  const elapsed = Date.now() - lastScreenshotTime;
  const remainingMs = currentConfig.screenshotMaxIntervalMs - elapsed;

  if (remainingMs > 0) {
    const seconds = Math.ceil(remainingMs / 1000);
    floatingButton.disabled = true;
    floatingButton.innerText = `冷却 ${seconds}s`;
    floatingButton.style.opacity = '0.6';
    floatingButton.style.cursor = 'not-allowed';
  } else {
    floatingButton.disabled = false;
    floatingButton.innerText = '发送截图解谜';
    floatingButton.style.opacity = '1';
    floatingButton.style.cursor = 'pointer';
    if (cooldownTimer) {
      clearInterval(cooldownTimer);
      cooldownTimer = null;
    }
  }
}

function startCooldownCountdown() {
  if (cooldownTimer) {
    clearInterval(cooldownTimer);
  }
  updateButtonCooldownUI();
  cooldownTimer = setInterval(() => {
    updateButtonCooldownUI();
  }, 1000);
}

function ensureFloatingButton(doc = safeGetDoc()) {
  if (!doc || !doc.body) return;
  if (!shouldCaptureCanvas(doc)) {
    removeFloatingButton();
    return;
  }

  if (floatingButton && floatingButton.parentElement) {
    return;
  }

  const btn = doc.createElement('button');
  btn.id = '__game_reader_screenshot_btn__';
  if (typeof btn.setAttribute === 'function') {
    btn.setAttribute('data-sai-ext', '1');
  }
  btn.innerText = '发送截图解谜';
  btn.style.position = 'fixed';
  btn.style.right = '20px';
  btn.style.bottom = '20px';
  btn.style.zIndex = '2147483646';
  btn.style.padding = '8px 14px';
  btn.style.background = '#2563eb';
  btn.style.color = '#ffffff';
  btn.style.border = 'none';
  btn.style.borderRadius = '6px';
  btn.style.fontSize = '13px';
  btn.style.fontWeight = '500';
  btn.style.boxShadow = '0 4px 6px -1px rgba(0, 0, 0, 0.1)';
  btn.style.transition = 'all 0.2s';
  btn.style.cursor = 'pointer';

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    requestScreenshot('user');
  });

  doc.body.appendChild(btn);
  floatingButton = btn;
  updateButtonCooldownUI();
}

function removeFloatingButton() {
  if (floatingButton) {
    if (floatingButton.parentElement) {
      floatingButton.parentElement.removeChild(floatingButton);
    }
    floatingButton = null;
  }
  if (cooldownTimer) {
    clearInterval(cooldownTimer);
    cooldownTimer = null;
  }
}

function runVisualDetection() {
  const doc = safeGetDoc();
  if (!doc) return;

  ensureFloatingButton(doc);

  if (!shouldCaptureCanvas(doc)) {
    lastCanvasHash = null;
    return;
  }

  if (doc.visibilityState === 'hidden') {
    return;
  }

  const canvas = findPrimaryCanvas(doc);
  if (!canvas) return;

  const currentHash = getCanvasHash(canvas);
  if (!currentHash) return;

  if (lastCanvasHash === null) {
    lastCanvasHash = currentHash;
    return;
  }

  if (lastCanvasHash !== currentHash) {
    lastCanvasHash = currentHash;
    const elapsed = Date.now() - lastScreenshotTime;
    if (elapsed >= currentConfig.screenshotMaxIntervalMs) {
      requestScreenshot('visual_change');
    }
  }
}

export function requestScreenshot(reason) {
  if (reason !== 'user' && reason !== 'visual_change') {
    return;
  }

  const doc = safeGetDoc();
  if (reason === 'visual_change' && doc && doc.visibilityState === 'hidden') {
    return;
  }

  const elapsed = Date.now() - lastScreenshotTime;
  if (elapsed < currentConfig.screenshotMaxIntervalMs) {
    updateButtonCooldownUI();
    return;
  }

  lastScreenshotTime = Date.now();
  startCooldownCountdown();

  const win = safeGetWindow();
  const origin = win && win.location ? win.location.origin : '';
  const message = createMessage(READER_SCREENSHOT_REQUEST, {
    origin,
    gameKey: currentConfig.gameKey || undefined,
    reason
  });
  safeSendMessage(message);
}

export function flushBatch(force = true) {
  if (!force && !isDomDirty) {
    return;
  }
  isDomDirty = false;

  const now = getNow();
  const doc = safeGetDoc();
  const next = collectVisibleText(doc);
  const prev = previousText;

  // 1. 检测同位数字变化与跳动状态
  const pNormTime = normalizeTemporalTokens(prev);
  const nNormTime = normalizeTemporalTokens(next);
  const isPureTemporalChange = prev !== next && pNormTime === nNormTime;

  let shouldSuppressDueToJumping = false;
  let stabilizedFinalToSend = null;

  const pSlots = extractNumericSlots(prev);
  const nSlots = extractNumericSlots(next);
  const isSameSkeleton = pSlots.skeleton.length > 0 && pSlots.skeleton === nSlots.skeleton && pSlots.tokens.length === nSlots.tokens.length;

  if (isSameSkeleton) {
    for (let i = 0; i < nSlots.tokens.length; i++) {
      const pVal = pSlots.tokens[i].val;
      const nVal = nSlots.tokens[i].val;
      const slotKey = `${nSlots.skeleton}:::slot_${i}`;
      let record = slotTracker.get(slotKey);

      if (!record) {
        record = {
          lastVal: pVal,
          changeTimes: [],
          isJumping: false,
          lastChangeAt: now,
          finalEmitted: false
        };
        slotTracker.set(slotKey, record);
      }

      if (pVal !== nVal) {
        // 发生了同位数值变化
        record.lastVal = nVal;
        record.lastChangeAt = now;
        record.finalEmitted = false;

        // 30 秒滑动窗口
        record.changeTimes = record.changeTimes.filter(t => now - t <= 30000);
        record.changeTimes.push(now);

        if (record.changeTimes.length >= 3) {
          record.isJumping = true;
          // 第 3 次及以上进入跳动抑制
          shouldSuppressDueToJumping = true;
        }
      } else {
        // 同位数值未变：检查是否曾经判定跳动且 >5000ms 稳定
        if (record.isJumping && !record.finalEmitted && !isPureTemporalChange && /\d/.test(nNormTime)) {
          if (now - record.lastChangeAt > 5000) {
            stabilizedFinalToSend = next;
            record.finalEmitted = true;
            // 发送后清空该位置跳动状态
            slotTracker.delete(slotKey);
          }
        }
      }
    }
  }

  // 2. 计算增量并决定是否发送
  let delta = computeDelta(prev, next);

  if (delta.length > 0) {
    if (shouldSuppressDueToJumping) {
      // 被判定为跳动值，抑制发送
      delta = '';
    }
  }

  // 若存在稳定后的终值需补发
  if (!delta && stabilizedFinalToSend) {
    delta = stabilizedFinalToSend;
  }

  if (delta.length > 0) {
    const win = safeGetWindow();
    const origin = win && win.location ? win.location.origin : '';
    const title = doc && doc.title ? doc.title : '';

    const message = createMessage(READER_DELTA, {
      origin,
      gameKey: currentConfig.gameKey || undefined,
      text: delta,
      title: title || undefined
    });

    safeSendMessage(message);
  }

  previousText = next;
}

export function stopReader() {
  if (domObserver) {
    domObserver.disconnect();
    domObserver = null;
  }

  if (batchTimer) {
    clearInterval(batchTimer);
    batchTimer = null;
  }

  if (visualTimer) {
    clearInterval(visualTimer);
    visualTimer = null;
  }

  if (cooldownTimer) {
    clearInterval(cooldownTimer);
    cooldownTimer = null;
  }

  removeFloatingButton();

  previousText = '';
  isDomDirty = false;
  lastCanvasHash = null;
  slotTracker.clear();
  getNow = () => Date.now();
}

export function startReader(config) {
  stopReader();

  currentConfig = {
    batchIntervalMs: 5000,
    screenshotMaxIntervalMs: 30000,
    gameKey: '',
    enabled: true,
    ...(config || {})
  };

  if (typeof config?.now === 'function') {
    getNow = config.now;
  } else {
    getNow = () => Date.now();
  }

  if (currentConfig.enabled === false) {
    return;
  }

  const doc = safeGetDoc();
  previousText = collectVisibleText(doc);
  isDomDirty = false;

  function attachObserver() {
    const targetDoc = safeGetDoc();
    if (!targetDoc) return;
    const root = targetDoc.body || targetDoc.documentElement;
    if (!root) return;

    if (typeof MutationObserver !== 'undefined') {
      domObserver = new MutationObserver(() => {
        isDomDirty = true;
      });
      domObserver.observe(root, {
        childList: true,
        characterData: true,
        subtree: true
      });
    }
  }

  if (doc) {
    if (doc.body || doc.documentElement) {
      attachObserver();
      ensureFloatingButton(doc);
    } else {
      doc.addEventListener('DOMContentLoaded', () => {
        attachObserver();
        ensureFloatingButton(doc);
      }, { once: true });
    }
  }

  batchTimer = setInterval(() => {
    flushBatch(false);
  }, currentConfig.batchIntervalMs);

  visualTimer = setInterval(() => {
    runVisualDetection();
  }, 5000);
}

function handleRuntimeMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  const type = msg.type;
  const payload = msg.payload || {};

  switch (type) {
    case READER_CONFIG:
      startReader(payload);
      break;
    case READER_FLUSH:
      flushBatch(true);
      break;
    case READER_SCREENSHOT_RESULT:
      if (payload.ok === true || payload.skipped === 'throttled') {
        lastScreenshotTime = Date.now();
        startCooldownCountdown();
      } else {
        lastScreenshotTime = 0;
        updateButtonCooldownUI();
      }
      break;
    default:
      break;
  }
}

if (!isListenerRegistered && typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
  try {
    chrome.runtime.onMessage.addListener(handleRuntimeMessage);
    isListenerRegistered = true;
  } catch {
    // 监听注册保护
  }
}

// 内容脚本环境自启动：先用默认配置启动，再让首次批量冲刷上报页面初始可见文本
if (
  typeof document !== 'undefined' &&
  typeof window !== 'undefined' &&
  typeof chrome !== 'undefined' &&
  chrome.runtime &&
  chrome.runtime.id
) {
  try {
    startReader({});
    previousText = '';
    isDomDirty = true;
  } catch {
    // 自启动保护
  }
}
