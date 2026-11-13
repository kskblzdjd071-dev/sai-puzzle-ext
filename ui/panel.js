// 模块职责：解谜提问独立侧栏面板核心逻辑与事件绑定，支持 Chrome 侧栏与外部容器挂载
// 作者：Tom

import {
  PANEL_READY,
  ACTIVE_TAB_INFO,
  CLUES_LIST,
  CLUES_LIST_GAMES,
  CLUES_EXPORT,
  CLUES_UPDATED,
  READER_FLUSH,
  READER_SCREENSHOT_REQUEST,
  READER_SCREENSHOT_RESULT,
  AI_ASK,
  createMessage
} from '../core/messages.js';

import { makeGameKey } from '../core/models.js';

const panelCleanups = new WeakMap();

/**
 * 格式化时间戳或时间字符串
 * @param {number|string} time
 * @returns {string}
 */
function formatTime(time) {
  if (!time) return '';
  const date = typeof time === 'number' ? new Date(time) : new Date(String(time));
  if (isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  const h = pad(date.getHours());
  const m = pad(date.getMinutes());
  const s = pad(date.getSeconds());
  return `${h}:${m}:${s}`;
}

/**
 * 转换来源文案
 * @param {string} source
 * @returns {string}
 */
function translateSource(source) {
  if (source === 'text') return '文本';
  if (source === 'screenshot') return '截图';
  if (source === 'user') return '手动';
  return source || '线索';
}

/**
 * 挂载提问面板
 * @param {HTMLElement} root
 * @param {{ send: Function, onMessage: Function }} port
 */
export function mountPanel(root, port) {
  if (!root || !port) return;
  unmountPanel(root);

  let currentGameKey = '';
  let activeTabOrigin = '';
  let isCanvasActive = false;
  let isGranted = true;
  let isCapturing = false;
  let isAsking = false;

  root.innerHTML = `
    <div class="panel-container">
      <header class="panel-header">
        <div class="header-row">
          <select class="game-select" aria-label="选择游戏"></select>
          <div class="header-actions">
            <button class="btn-secondary btn-refresh" title="重新加载当前页面状态与线索">刷新</button>
            <button class="btn-secondary btn-export-json" title="导出 JSON 格式线索">JSON</button>
            <button class="btn-secondary btn-export-md" title="导出 Markdown 格式线索">MD</button>
          </div>
        </div>
      </header>

      <div class="canvas-bar" style="display: none;">
        <span class="canvas-bar-text">检测到游戏画布</span>
        <button class="btn-action btn-capture">即时抓取当前画面给 AI</button>
      </div>

      <div class="status-bar"></div>

      <main class="panel-main">
        <section class="section-container">
          <div class="section-title">线索时间线</div>
          <div class="timeline"></div>
        </section>

        <section class="section-container">
          <div class="section-title">问答历史</div>
          <div class="qa-history"></div>
        </section>
      </main>

      <footer class="panel-footer">
        <form class="ask-form">
          <textarea class="ask-input" placeholder="针对当前线索向 AI 提问..." rows="2"></textarea>
          <div class="ask-actions">
            <button type="submit" class="btn-primary btn-submit">提问</button>
          </div>
        </form>
      </footer>
    </div>
  `;

  const gameSelect = root.querySelector('.game-select');
  const btnRefresh = root.querySelector('.btn-refresh');
  const btnExportJson = root.querySelector('.btn-export-json');
  const btnExportMd = root.querySelector('.btn-export-md');
  const canvasBar = root.querySelector('.canvas-bar');
  const btnCapture = root.querySelector('.btn-capture');
  const statusBar = root.querySelector('.status-bar');
  const timelineEl = root.querySelector('.timeline');
  const qaHistoryEl = root.querySelector('.qa-history');
  const askForm = root.querySelector('.ask-form');
  const askInput = root.querySelector('.ask-input');
  const btnSubmit = root.querySelector('.btn-submit');

  function setStatus(text, type = 'info', persistent = false) {
    if (!text) {
      statusBar.className = 'status-bar';
      statusBar.textContent = '';
      return;
    }
    statusBar.className = `status-bar visible ${type}`;
    statusBar.textContent = text;
    if (!persistent && type !== 'error' && type !== 'warning') {
      setTimeout(() => {
        if (statusBar.textContent === text) {
          statusBar.className = 'status-bar';
          statusBar.textContent = '';
        }
      }, 4000);
    }
  }

  function renderClues(clues) {
    timelineEl.innerHTML = '';
    if (!Array.isArray(clues) || clues.length === 0) {
      timelineEl.innerHTML = '<div class="empty-tip">暂无线索记录</div>';
      return;
    }

    const sorted = clues.slice().sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0));
    const frag = document.createDocumentFragment();

    sorted.forEach((clue) => {
      const item = document.createElement('div');
      item.className = 'clue-item';

      const meta = document.createElement('div');
      meta.className = 'clue-meta';

      const badge = document.createElement('span');
      badge.className = 'clue-badge';
      badge.textContent = translateSource(clue.source);

      const timeSpan = document.createElement('span');
      timeSpan.textContent = formatTime(clue.createdAt);

      meta.appendChild(badge);
      if (clue.model && typeof clue.model === 'string') {
        const modelTag = document.createElement('span');
        modelTag.className = 'model-tag';
        modelTag.textContent = clue.model;
        meta.appendChild(modelTag);
      }
      meta.appendChild(timeSpan);
      item.appendChild(meta);

      const content = document.createElement('div');
      content.className = 'clue-content';
      content.textContent = clue.text || '';
      item.appendChild(content);

      if (Array.isArray(clue.tags) && clue.tags.length > 0) {
        const tagsWrapper = document.createElement('div');
        tagsWrapper.className = 'clue-tags';
        clue.tags.forEach((t) => {
          const tag = document.createElement('span');
          tag.className = 'clue-tag';
          tag.textContent = t;
          tagsWrapper.appendChild(tag);
        });
        item.appendChild(tagsWrapper);
      }

      frag.appendChild(item);
    });

    timelineEl.appendChild(frag);
  }

  async function loadClues(targetGameKey) {
    if (!targetGameKey) {
      renderClues([]);
      return;
    }
    const res = await port.send(createMessage(CLUES_LIST, { gameKey: targetGameKey }));
    if (res.ok && res.payload) {
      const clues = Array.isArray(res.payload)
        ? res.payload
        : (Array.isArray(res.payload.clues) ? res.payload.clues : []);
      renderClues(clues);
    } else {
      const msg = res.error && res.error.message ? res.error.message : '获取线索列表失败';
      setStatus(msg, 'error');
    }
  }

  async function loadGames(preferGameKey) {
    const res = await port.send(createMessage(CLUES_LIST_GAMES, {}));
    gameSelect.innerHTML = '';

    let games = [];
    if (res.ok && res.payload) {
      if (Array.isArray(res.payload)) {
        games = res.payload;
      } else if (Array.isArray(res.payload.games)) {
        games = res.payload.games;
      }
    }

    if (preferGameKey && !games.some((g) => g.gameKey === preferGameKey)) {
      games.unshift({ gameKey: preferGameKey, title: preferGameKey });
    }

    if (games.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '暂无游戏';
      gameSelect.appendChild(opt);
      return;
    }

    games.forEach((g) => {
      const opt = document.createElement('option');
      opt.value = g.gameKey;
      opt.textContent = g.title || g.gameKey;
      if (g.gameKey === currentGameKey) {
        opt.selected = true;
      }
      gameSelect.appendChild(opt);
    });
  }

  async function syncActiveTab() {
    const res = await port.send(createMessage(ACTIVE_TAB_INFO, {}));
    if (!res.ok || !res.payload) {
      setStatus('无法获取当前活动标签页信息', 'warning', true);
      askInput.disabled = true;
      btnSubmit.disabled = true;
      return;
    }

    const { origin, gameId, isGranted: tabGranted, isCanvas, title } = res.payload;
    activeTabOrigin = origin || '';
    isCanvasActive = Boolean(isCanvas);
    isGranted = Boolean(tabGranted);

    if (isCanvasActive) {
      canvasBar.style.display = 'flex';
    } else {
      canvasBar.style.display = 'none';
    }

    if (!activeTabOrigin) {
      setStatus('当前标签页无有效 Origin，提问已禁用', 'warning', true);
      askInput.disabled = true;
      btnSubmit.disabled = true;
      await loadGames(currentGameKey);
      return;
    }

    try {
      currentGameKey = makeGameKey(activeTabOrigin, gameId);
    } catch {
      setStatus('无法解析当前游戏标识', 'error', true);
      askInput.disabled = true;
      btnSubmit.disabled = true;
      return;
    }

    if (!isGranted) {
      setStatus('当前站点尚未授权线索提取，可浏览归档记录', 'warning', true);
      askInput.disabled = true;
      btnSubmit.disabled = true;
      btnCapture.disabled = true;
    } else {
      setStatus('');
      askInput.disabled = false;
      btnSubmit.disabled = false;
      btnCapture.disabled = isCapturing;
    }

    await loadGames(currentGameKey);
    await loadClues(currentGameKey);

    if (title && gameSelect.selectedOptions.length > 0 && gameSelect.value === currentGameKey) {
      gameSelect.selectedOptions[0].textContent = title;
    }
  }

  const handleGameSelectChange = async () => {
    const nextGameKey = gameSelect.value;
    if (!nextGameKey) return;
    currentGameKey = nextGameKey;
    if (currentGameKey.startsWith(activeTabOrigin) && !isGranted) {
      askInput.disabled = true;
      btnSubmit.disabled = true;
    } else {
      askInput.disabled = false;
      btnSubmit.disabled = false;
    }
    await loadClues(currentGameKey);
  };

  const handleRefreshClick = async () => {
    btnRefresh.disabled = true;
    try {
      await port.send(createMessage(READER_FLUSH, {}));
    } catch {
      // 忽略阻断
    }
    await syncActiveTab();
    btnRefresh.disabled = false;
  };

  const handleCaptureClick = async () => {
    if (!activeTabOrigin || !currentGameKey || isCapturing) return;
    isCapturing = true;
    btnCapture.disabled = true;
    setStatus('正在抓取当前游戏画面...', 'info');

    try {
      const res = await port.send(createMessage(READER_SCREENSHOT_REQUEST, {
        origin: activeTabOrigin,
        gameKey: currentGameKey,
        reason: 'user'
      }));

      if (!res.ok) {
        const msg = res.error && res.error.message ? res.error.message : '抓取请求发送失败';
        setStatus(msg, 'error');
      } else if (res.payload && res.payload.skipped) {
        const s = res.payload.skipped;
        if (s === 'throttled') setStatus('截图频率过快，已节流', 'warning');
        else if (s === 'permission' || s === 'not_granted') setStatus('无截图权限', 'warning');
        else if (s === 'no_tab') setStatus('未找到活动标签页', 'warning');
        else setStatus('截图已跳过', 'warning');
      }
    } catch {
      setStatus('抓取画面网络通信失败', 'error');
    } finally {
      setTimeout(() => {
        isCapturing = false;
        if (isGranted) btnCapture.disabled = false;
      }, 1000);
    }
  };

  function triggerDownload(content, filename) {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'clues_export.txt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  const handleExportJsonClick = async () => {
    btnExportJson.disabled = true;
    const res = await port.send(createMessage(CLUES_EXPORT, {
      gameKey: currentGameKey || null,
      format: 'json'
    }));
    btnExportJson.disabled = false;
    if (res.ok && res.payload && res.payload.content) {
      triggerDownload(res.payload.content, res.payload.filename);
    } else {
      setStatus(res.error && res.error.message ? res.error.message : '导出 JSON 失败', 'error');
    }
  };

  const handleExportMdClick = async () => {
    btnExportMd.disabled = true;
    const res = await port.send(createMessage(CLUES_EXPORT, {
      gameKey: currentGameKey || null,
      format: 'markdown'
    }));
    btnExportMd.disabled = false;
    if (res.ok && res.payload && res.payload.content) {
      triggerDownload(res.payload.content, res.payload.filename);
    } else {
      setStatus(res.error && res.error.message ? res.error.message : '导出 Markdown 失败', 'error');
    }
  };

  const handleAskSubmit = async (e) => {
    e.preventDefault();
    const question = askInput.value.trim();
    if (!question || !currentGameKey || isAsking) return;

    isAsking = true;
    askInput.disabled = true;
    btnSubmit.disabled = true;

    const exchange = document.createElement('div');
    exchange.className = 'qa-exchange';

    const qEl = document.createElement('div');
    qEl.className = 'qa-question';
    qEl.textContent = question;
    exchange.appendChild(qEl);

    const skeleton = document.createElement('div');
    skeleton.className = 'skeleton-card';
    exchange.appendChild(skeleton);
    qaHistoryEl.appendChild(exchange);
    qaHistoryEl.scrollTop = qaHistoryEl.scrollHeight;

    try {
      const res = await port.send(createMessage(AI_ASK, {
        gameKey: currentGameKey,
        question
      }));

      skeleton.remove();

      if (res.ok && res.payload) {
        const data = res.payload;
        const cards = document.createElement('div');
        cards.className = 'qa-response-cards';

        if (data.summary) {
          const cardSummary = document.createElement('div');
          cardSummary.className = 'card';
          cardSummary.innerHTML = `
            <div class="card-header">
              <span>线索总结</span>
              ${data.model ? `<span class="model-tag">${data.model}</span>` : ''}
            </div>
            <div class="card-body"></div>
          `;
          cardSummary.querySelector('.card-body').textContent = data.summary;
          cards.appendChild(cardSummary);
        }

        if (Array.isArray(data.suggestions) && data.suggestions.length > 0) {
          const cardSug = document.createElement('div');
          cardSug.className = 'card';
          const header = document.createElement('div');
          header.className = 'card-header';
          header.textContent = '建议下一步';
          cardSug.appendChild(header);

          const list = document.createElement('ol');
          list.className = 'suggestion-list';
          data.suggestions.forEach((itemText) => {
            const li = document.createElement('li');
            li.textContent = itemText;
            list.appendChild(li);
          });
          cardSug.appendChild(list);
          cards.appendChild(cardSug);
        }

        if (data.answer) {
          const cardAnswer = document.createElement('div');
          cardAnswer.className = 'card';
          cardAnswer.innerHTML = '<div class="card-header">解答</div><div class="card-body"></div>';
          cardAnswer.querySelector('.card-body').textContent = data.answer;
          cards.appendChild(cardAnswer);
        }

        exchange.appendChild(cards);
        askInput.value = '';
      } else {
        const errCard = document.createElement('div');
        errCard.className = 'card';
        const msg = res.error && res.error.message ? res.error.message : '提问失败，请稍后重试';
        errCard.innerHTML = `<div class="card-header" style="color: var(--panel-danger);">回答失败</div><div class="card-body"></div>`;
        errCard.querySelector('.card-body').textContent = msg;
        exchange.appendChild(errCard);
      }
    } catch {
      skeleton.remove();
      const errCard = document.createElement('div');
      errCard.className = 'card';
      errCard.innerHTML = '<div class="card-header" style="color: var(--panel-danger);">回答失败</div><div class="card-body">网络通信异常</div>';
      exchange.appendChild(errCard);
    } finally {
      isAsking = false;
      askInput.disabled = false;
      btnSubmit.disabled = false;
      askInput.focus();
      qaHistoryEl.scrollTop = qaHistoryEl.scrollHeight;
    }
  };

  gameSelect.addEventListener('change', handleGameSelectChange);
  btnRefresh.addEventListener('click', handleRefreshClick);
  btnCapture.addEventListener('click', handleCaptureClick);
  btnExportJson.addEventListener('click', handleExportJsonClick);
  btnExportMd.addEventListener('click', handleExportMdClick);
  askForm.addEventListener('submit', handleAskSubmit);

  const unsubscribe = port.onMessage((msg) => {
    if (!msg || !msg.type) return;

    if (msg.type === CLUES_UPDATED && msg.payload) {
      if (msg.payload.gameKey === currentGameKey) {
        loadClues(currentGameKey);
      }
    } else if (msg.type === READER_SCREENSHOT_RESULT && msg.payload) {
      const p = msg.payload;
      if (p.ok === true) {
        setStatus('画面抓取成功，已加入线索', 'info');
      } else if (p.skipped === 'throttled') {
        setStatus('截图太频繁，已自动跳过', 'warning');
      } else if (p.skipped === 'no_tab') {
        setStatus('未定位到游戏标签页', 'warning');
      } else if (p.skipped === 'permission' || p.skipped === 'not_granted') {
        setStatus('缺少截图权限', 'warning');
      } else if (p.error) {
        setStatus(`截图失败: ${p.error}`, 'error');
      }
    }
  });

  const cleanup = () => {
    unsubscribe();
    gameSelect.removeEventListener('change', handleGameSelectChange);
    btnRefresh.removeEventListener('click', handleRefreshClick);
    btnCapture.removeEventListener('click', handleCaptureClick);
    btnExportJson.removeEventListener('click', handleExportJsonClick);
    btnExportMd.removeEventListener('click', handleExportMdClick);
    askForm.removeEventListener('submit', handleAskSubmit);
    root.innerHTML = '';
  };

  panelCleanups.set(root, cleanup);

  // 初始化通知与拉取
  port.send(createMessage(PANEL_READY, {})).catch(() => {});
  syncActiveTab();
}

/**
 * 卸载提问面板
 * @param {HTMLElement} root
 */
export function unmountPanel(root) {
  if (!root) return;
  const cleanup = panelCleanups.get(root);
  if (typeof cleanup === 'function') {
    cleanup();
    panelCleanups.delete(root);
  } else {
    root.innerHTML = '';
  }
}

// 自动挂载（仅在扩展环境运行）
if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    const hasChromeRuntime = typeof chrome !== 'undefined' &&
      chrome.runtime &&
      typeof chrome.runtime.sendMessage === 'function' &&
      chrome.runtime.onMessage &&
      typeof chrome.runtime.onMessage.addListener === 'function';

    if (!hasChromeRuntime) return;

    const rootEl = document.getElementById('panel-root') || document.body;

    const chromePort = {
      send: (message) => {
        return new Promise((resolve) => {
          try {
            chrome.runtime.sendMessage(message, (response) => {
              if (chrome.runtime.lastError) {
                resolve({
                  type: message.type,
                  requestId: message.requestId,
                  ok: false,
                  error: { message: chrome.runtime.lastError.message || '扩展通信失败' }
                });
                return;
              }
              if (response && typeof response === 'object') {
                resolve(response);
              } else {
                resolve({
                  type: message.type,
                  requestId: message.requestId,
                  ok: false,
                  error: { message: '接收到无效响应格式' }
                });
              }
            });
          } catch {
            resolve({
              type: message.type,
              requestId: message.requestId,
              ok: false,
              error: { message: '发送消息异常' }
            });
          }
        });
      },
      onMessage: (listener) => {
        const handler = (message) => {
          listener(message);
        };
        chrome.runtime.onMessage.addListener(handler);
        return () => {
          chrome.runtime.onMessage.removeListener(handler);
        };
      }
    };

    mountPanel(rootEl, chromePort);
  });
}
