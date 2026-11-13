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

export const NUMERIC_SLOT_TRACKER_LIMIT = 200;

// 跟踪局部骨架中各非计时数字 slot 的变动历史
// slotKey -> {
//   slotKey: string,
//   lastVal: string,
//   changeTimes: number[],
//   isJumping: boolean,
//   lastChangeAt: number,
//   lastAccess: number,
//   finalEmitted: boolean,
//   sentenceSkeleton: string,
//   slotIndexInSentence: number
// }
let slotTracker = new Map();

export function getNumericSlotTrackerSize() {
  return slotTracker.size;
}

function pruneSlotTracker(now) {
  // 丢弃超过 60s 既无更新也无访问的过期条目
  for (const [key, record] of slotTracker.entries()) {
    const lastActive = Math.max(record.lastChangeAt || 0, record.lastAccess || 0);
    if (now - lastActive > 60000 && !record.isJumping) {
      slotTracker.delete(key);
    }
  }

  // 若仍超出容量，按 lastAccess 升序（最久未访问）淘汰
  if (slotTracker.size > NUMERIC_SLOT_TRACKER_LIMIT) {
    const entries = Array.from(slotTracker.entries());
    entries.sort((a, b) => (a[1].lastAccess || 0) - (b[1].lastAccess || 0));
    const excess = slotTracker.size - NUMERIC_SLOT_TRACKER_LIMIT;
    for (let i = 0; i < excess; i++) {
      slotTracker.delete(entries[i][0]);
    }
  }
}

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

const TEMPORAL_REGEXES = [
  /(?:剩余|剩余时间|倒计时|冷却)?\s*\b\d{1,2}:\d{2}(?::\d{2})?\b/gi,
  /(?:剩余|剩余时间|冷却)?\s*\d+(?:\.\d+)?\s*(?:秒|s|sec|seconds?)\b/gi,
  /倒计时\s*\d+/gi
];

// 归一化明确的计时/倒计时/时钟格式
function normalizeTemporalTokens(str) {
  if (!str) return '';
  let res = str;
  for (const reg of TEMPORAL_REGEXES) {
    res = res.replace(reg, '__TIME__');
  }
  return res.replace(/\s+/g, ' ').trim();
}

// 先将计时类 token 屏蔽为固定占位，避免进入数字槽位提取与跳动检测
function maskTemporalTokens(str) {
  if (!str) return '';
  let res = str;
  for (const reg of TEMPORAL_REGEXES) {
    res = res.replace(reg, '__TIME__');
  }
  return res;
}

// 将文本拆分为局部句子/片段，保持稳定上下文
function splitIntoSentences(text) {
  if (!text) return [];
  return text.split(/(?<=[。！？\n])|(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
}

// 提取文本中的局部非计时数字 slot 信息
// 结构：{ key, sentenceSkeleton, slotIndexInSentence, val, sentence }
function extractLocalNumericSlots(text) {
  const sentences = splitIntoSentences(text);
  const slots = [];

  for (const sentence of sentences) {
    // 先遮蔽计时/时钟数字
    const maskedSentence = maskTemporalTokens(sentence);
    let indexInSentence = 0;
    const sentenceSkeleton = maskedSentence.replace(/\b\d+\b/g, () => `__NUM_SLOT__`);

    // 针对原始非计时数字抽取 token
    let match;
    const numRegex = /\b\d+\b/g;
    // 在 maskedSentence 寻找非 __TIME__ 内部的数字
    while ((match = numRegex.exec(maskedSentence)) !== null) {
      const val = match[0];
      const slotIndex = indexInSentence++;
      const key = `${sentenceSkeleton}:::slot_${slotIndex}`;
      slots.push({
        key,
        sentenceSkeleton,
        slotIndexInSentence: slotIndex,
        val,
        sentence
      });
    }
  }

  return slots;
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
    const prefix = n.slice(0, idx).replace(/\s+/g, ' ').trim();
    const suffix = n.slice(idx + p.length).replace(/\s+/g, ' ').trim();
    const parts = [];
    if (prefix) parts.push(prefix);
    if (suffix) parts.push(suffix);
    return parts.join(' ').replace(/\s+/g, ' ').trim();
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
    const pMasked = maskTemporalTokens(p);
    const nMasked = maskTemporalTokens(n);
    const pSkel = pMasked.replace(/\b\d+\b/g, '__NUM__');
    const nSkel = nMasked.replace(/\b\d+\b/g, '__NUM__');
    if (pSkel === nSkel && pMasked !== nMasked) {
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
  const now = getNow();
  const doc = safeGetDoc();
  const next = collectVisibleText(doc);
  const prev = previousText;

  isDomDirty = false;

  // 1. 抽取基于稳定局部上下文的非计时数字槽位
  const pLocalSlots = extractLocalNumericSlots(prev);
  const nLocalSlots = extractLocalNumericSlots(next);

  const prevSlotMap = new Map();
  for (const s of pLocalSlots) {
    prevSlotMap.set(s.key, s);
  }

  // 记录跳动位置的集合与本次用于遮罩的替换映射
  const jumpingMaskMap = new Map(); // key -> lastAcceptedVal
  const jumpingKeysThisRound = new Set();
  const stabilizedSentencesToEmit = [];

  for (const nSlot of nLocalSlots) {
    const key = nSlot.key;
    const pSlot = prevSlotMap.get(key);
    let record = slotTracker.get(key);

    if (!record) {
      record = {
        slotKey: key,
        lastVal: pSlot ? pSlot.val : nSlot.val,
        changeTimes: [],
        isJumping: false,
        lastChangeAt: now,
        lastAccess: now,
        finalEmitted: false,
        sentenceSkeleton: nSlot.sentenceSkeleton,
        slotIndexInSentence: nSlot.slotIndexInSentence,
        lastAcceptedVal: pSlot ? pSlot.val : nSlot.val
      };
      slotTracker.set(key, record);
    }

    record.lastAccess = now;

    const currentVal = nSlot.val;
    const hadChanged = record.lastVal !== currentVal;

    if (hadChanged) {
      record.lastVal = currentVal;
      record.lastChangeAt = now;
      record.finalEmitted = false;

      // 30 秒滑动窗口
      record.changeTimes = record.changeTimes.filter(t => now - t <= 30000);
      record.changeTimes.push(now);

      if (record.changeTimes.length >= 3) {
        record.isJumping = true;
      } else {
        // 第 1、2 次变动正常接受
        record.lastAcceptedVal = currentVal;
      }
    }

    if (record.isJumping) {
      if (hadChanged) {
        jumpingKeysThisRound.add(key);
      }
      jumpingMaskMap.set(key, record.lastAcceptedVal || '__JUMPING__');

      // 检查跳动已停且稳定 >5000ms（注意：计时数字已被排除在 slots 之外，无须担心误判）
      if (!record.finalEmitted && now - record.lastChangeAt > 5000) {
        stabilizedSentencesToEmit.push(nSlot.sentence);
        record.finalEmitted = true;
        record.isJumping = false;
        record.lastAcceptedVal = currentVal;
        slotTracker.delete(key);
      }
    }
  }

  // 同时也对不在当前 nextLocalSlots 中但在上一轮或之前存在且仍处于跳动状态的槽位检查稳定补发
  for (const [key, record] of slotTracker.entries()) {
    if (record.isJumping && !record.finalEmitted && now - record.lastChangeAt > 5000) {
      // 若当前 DOM 文本中依然能找到该句子骨架，尝试补发
      if (next.includes(record.lastVal)) {
        stabilizedSentencesToEmit.push(record.lastVal);
      }
      record.finalEmitted = true;
      record.isJumping = false;
      slotTracker.delete(key);
    }
  }

  pruneSlotTracker(now);

  // 2. 对已判定跳动的位置，在 computeDelta 之前把 prev 和 next 里该位置的数字都替换成 lastAcceptedVal
  function maskJumpingSlotsInText(targetText, activeJumpingKeys) {
    if (!targetText || activeJumpingKeys.size === 0) return targetText;
    const sentences = splitIntoSentences(targetText);
    const transformed = sentences.map(sentence => {
      const masked = maskTemporalTokens(sentence);
      let indexInSentence = 0;
      const sentenceSkeleton = masked.replace(/\b\d+\b/g, () => `__NUM_SLOT__`);

      // 在 masked (计时 token 已变为 __TIME__) 基础上替换普通数字 slot
      const replacedMasked = masked.replace(/\b\d+\b/g, (m) => {
        const slotIdx = indexInSentence++;
        const key = `${sentenceSkeleton}:::slot_${slotIdx}`;
        if (activeJumpingKeys.has(key)) {
          return jumpingMaskMap.get(key) || m;
        }
        return m;
      });

      // 还原 __TIME__ 标记为原始句子对应位置的计时字面量
      const temporalMatches = [];
      for (const regex of TEMPORAL_REGEXES) {
        regex.lastIndex = 0;
        let match;
        while ((match = regex.exec(sentence)) !== null) {
          temporalMatches.push({
            start: match.index,
            text: match[0]
          });
        }
      }
      temporalMatches.sort((a, b) => a.start - b.start);
      let tIdx = 0;
      return replacedMasked.replace(/__TIME__/g, () => {
        if (tIdx < temporalMatches.length) {
          return temporalMatches[tIdx++].text;
        }
        return '__TIME__';
      });
    });
    return transformed.join(' ');
  }

  const allJumpingKeys = new Set(jumpingMaskMap.keys());
  let effectivePrev = prev;
  let effectiveNext = next;

  if (allJumpingKeys.size > 0) {
    effectivePrev = maskJumpingSlotsInText(prev, allJumpingKeys);
    effectiveNext = maskJumpingSlotsInText(next, allJumpingKeys);
  }

  // 3. 计算增量并决定是否发送
  let delta = computeDelta(effectivePrev, effectiveNext);

  // 若增量为空但存在跳动稳定后的终值片段，补发该句子
  if (!delta && stabilizedSentencesToEmit.length > 0) {
    const uniqueSentences = Array.from(new Set(stabilizedSentencesToEmit));
    delta = uniqueSentences.join('\n').trim();
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
