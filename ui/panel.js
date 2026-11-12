// 网页游戏解谜整理插件 - 侧边栏交互逻辑
// 包含线索时间线展示、智能提问、数据导出与手动提取触发
import {
  ACTIVE_TAB_INFO,
  CLUES_LIST,
  CLUES_EXPORT,
  AI_ASK,
  AI_EXTRACT,
  CLUES_UPDATED,
  createMessage
} from '../core/messages.js';
import { makeGameKey } from '../core/models.js';
import { normalizeOrigin } from '../core/settings.js';

export function createExtensionPort() {
  return {
    async send(msg) {
      return new Promise((resolve) => {
        if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
          resolve({ ok: false, errorMessage: 'Chrome API 不可用' });
          return;
        }
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, errorMessage: chrome.runtime.lastError.message });
          } else {
            resolve(res || { ok: false });
          }
        });
      });
    },
    onMessage(handler) {
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.onMessage) {
        return () => {};
      }
      const listener = (message, sender) => handler(message, sender);
      chrome.runtime.onMessage.addListener(listener);
      return () => chrome.runtime.removeListener(listener);
    }
  };
}

export async function mountPanel(root, port) {
  root.innerHTML = `
    <div class="game-header">
      <div id="game-title" class="game-title">检测游戏中...</div>
      <div id="game-origin" class="game-origin">--</div>
    </div>
    <div class="action-bar">
      <button id="btn-extract-now" class="btn-xs">现在提取</button>
      <button id="btn-export-md" class="btn-xs">导出 MD</button>
      <button id="btn-export-json" class="btn-xs">导出 JSON</button>
    </div>
    <div class="panel-content">
      <div>
        <div class="section-label">线索时间线</div>
        <div id="timeline-list" class="timeline">
          <div class="empty-tip">暂无捕获线索</div>
        </div>
      </div>
      <div>
        <div class="section-label">AI 答疑建议</div>
        <div class="qa-box">
          <div id="answer-container" class="answer-card" style="display:none;"></div>
        </div>
      </div>
    </div>
    <div class="ask-form">
      <input type="text" id="ask-input" class="ask-input" placeholder="针对当前线索提问...">
      <button id="btn-ask" class="ask-btn">提问</button>
    </div>
  `;

  const gameTitleEl = root.querySelector('#game-title');
  const gameOriginEl = root.querySelector('#game-origin');
  const timelineEl = root.querySelector('#timeline-list');
  const answerEl = root.querySelector('#answer-container');
  const askInput = root.querySelector('#ask-input');
  const btnAsk = root.querySelector('#btn-ask');
  const btnExtractNow = root.querySelector('#btn-extract-now');
  const btnExportMd = root.querySelector('#btn-export-md');
  const btnExportJson = root.querySelector('#btn-export-json');

  let currentGameKey = '';
  let cachedClues = [];

  function renderClues(clues) {
    cachedClues = clues || [];
    if (cachedClues.length === 0) {
      timelineEl.innerHTML = '<div class="empty-tip">暂无捕获线索</div>';
      return;
    }
    timelineEl.innerHTML = '';
    cachedClues.forEach((clue) => {
      const item = document.createElement('div');
      item.className = 'timeline-item';
      const timeStr = clue.createdAt ? new Date(clue.createdAt).toLocaleTimeString() : '';
      item.innerHTML = `
        <div class="clue-meta">${clue.type || '线索'} · ${timeStr}</div>
        <div class="clue-text">${escapeHtml(clue.text || '')}</div>
      `;
      timelineEl.appendChild(item);
    });
  }

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  async function refreshClues() {
    if (!currentGameKey) return;
    const res = await port.send(createMessage(CLUES_LIST, { gameKey: currentGameKey }));
    if (res.ok && Array.isArray(res.payload)) {
      renderClues(res.payload);
    }
  }

  // 获取当前标签信息
  const tabRes = await port.send(createMessage(ACTIVE_TAB_INFO));
  if (tabRes.ok && tabRes.payload?.tab?.url) {
    const url = tabRes.payload.tab.url;
    try {
      const origin = normalizeOrigin(url);
      currentGameKey = makeGameKey(origin, new URL(url).pathname);
      gameTitleEl.textContent = tabRes.payload.tab.title || '未知游戏';
      gameOriginEl.textContent = origin;
      await refreshClues();
    } catch (err) {
      gameTitleEl.textContent = '当前站点不在支持列表';
    }
  }

  btnAsk.addEventListener('click', async () => {
    const q = askInput.value.trim();
    if (!q) return;
    btnAsk.disabled = true;
    answerEl.style.display = 'block';
    answerEl.textContent = '思考解答中...';
    try {
      const res = await port.send(createMessage(AI_ASK, { question: q, clues: cachedClues }));
      if (res.ok && res.payload?.answer) {
        answerEl.textContent = res.payload.answer;
      } else {
        answerEl.textContent = `回答失败: ${res.errorMessage || '未知错误'}`;
      }
    } finally {
      btnAsk.disabled = false;
    }
  });

  btnExtractNow.addEventListener('click', async () => {
    btnExtractNow.disabled = true;
    try {
      await port.send(createMessage(AI_EXTRACT, { delta: '用户请求即时整理', image: null }));
      await refreshClues();
    } finally {
      btnExtractNow.disabled = false;
    }
  });

  btnExportMd.addEventListener('click', async () => {
    const res = await port.send(createMessage(CLUES_EXPORT, { gameKey: currentGameKey, format: 'markdown' }));
    if (res.ok && res.payload?.content) {
      downloadFile(`clues-${Date.now()}.md`, res.payload.content, 'text/markdown');
    }
  });

  btnExportJson.addEventListener('click', async () => {
    const res = await port.send(createMessage(CLUES_EXPORT, { gameKey: currentGameKey, format: 'json' }));
    if (res.ok && res.payload?.content) {
      downloadFile(`clues-${Date.now()}.json`, res.payload.content, 'application/json');
    }
  });

  const unsubscribe = port.onMessage((msg) => {
    if (msg.type === CLUES_UPDATED) {
      refreshClues();
    }
  });

  function downloadFile(filename, content, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  return () => {
    unsubscribe();
  };
}

export function unmountPanel(root) {
  if (root) {
    root.innerHTML = '';
  }
}

// 扩展内页面自挂载
if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    const root = document.getElementById('panel-root');
    if (root && typeof chrome !== 'undefined' && chrome.runtime) {
      mountPanel(root, createExtensionPort());
    }
  });
}
