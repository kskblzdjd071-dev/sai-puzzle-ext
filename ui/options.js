// 职责：实现设置页面的 UI 逻辑、供应商切换与安全通信交互
// 作者：Allen

import {
  OPTIONS_READY,
  SETTINGS_GET,
  SETTINGS_SAVE,
  SITES_ADD,
  SITES_REMOVE,
  PROVIDER_PERMISSION_REQUEST,
  createMessage
} from '../core/messages.js';
import { normalizeOrigin } from '../core/settings.js';

const PROVIDER_DEFAULTS = {
  openai_compatible: {
    model: 'gpt-4o',
    baseUrl: 'https://api.openai.com/v1'
  },
  deepseek: {
    model: 'deepseek-chat',
    baseUrl: 'https://api.deepseek.com'
  },
  gemini: {
    model: 'gemini-1.5-flash',
    baseUrl: 'https://generativelanguage.googleapis.com'
  }
};

let currentRedactedSettings = null;
let currentPlainApiKey = '';
let currentSites = [];
let statusTimeoutId = null;

const statusBar = document.getElementById('status-bar');
const settingsForm = document.getElementById('settings-form');
const providerSelect = document.getElementById('provider-select');
const deepseekNotice = document.getElementById('deepseek-notice');
const baseUrlGroup = document.getElementById('base-url-group');
const baseUrlInput = document.getElementById('base-url-input');
const modelInput = document.getElementById('model-input');
const apiKeyInput = document.getElementById('api-key-input');
const addSiteForm = document.getElementById('add-site-form');
const siteUrlInput = document.getElementById('site-url-input');
const siteGameIdInput = document.getElementById('site-gameid-input');
const sitesTbody = document.getElementById('sites-tbody');

/**
 * 封装消息发送 Promise，捕获 runtime.lastError
 * @param {object} message
 * @returns {Promise<any>}
 */
function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const err = chrome.runtime.lastError;
      if (err) {
        return reject(new Error(err.message || '通信失败，后台未响应'));
      }
      if (!response) {
        return reject(new Error('未收到后台响应'));
      }
      if (!response.ok) {
        const msg = (response.error && response.error.message) ? response.error.message : '操作失败';
        return reject(new Error(msg));
      }
      resolve(response.payload);
    });
  });
}

/**
 * 显示状态提示栏
 * @param {string} message
 * @param {'success'|'error'|'warning'} type
 */
function showStatus(message, type = 'success') {
  if (statusTimeoutId) {
    clearTimeout(statusTimeoutId);
  }

  // 严格避免把包含真实密钥特征的内容展示在状态栏
  let safeMessage = String(message || '');
  if (currentPlainApiKey && currentPlainApiKey.length >= 8 && safeMessage.includes(currentPlainApiKey)) {
    safeMessage = safeMessage.replace(new RegExp(currentPlainApiKey, 'g'), '******');
  }

  statusBar.className = `status-bar ${type}`;
  statusBar.textContent = safeMessage;
  statusBar.classList.remove('hidden');

  statusTimeoutId = setTimeout(() => {
    statusBar.classList.add('hidden');
  }, 4500);
}

/**
 * 调整各供应商对应的显示控制
 * @param {string} provider
 */
function updateProviderView(provider) {
  if (provider === 'openai_compatible') {
    baseUrlGroup.classList.remove('hidden');
  } else {
    baseUrlGroup.classList.add('hidden');
  }

  if (provider === 'deepseek') {
    deepseekNotice.classList.remove('hidden');
  } else {
    deepseekNotice.classList.add('hidden');
  }
}

/**
 * 渲染脱敏密钥状态
 */
function renderApiKeyField() {
  if (currentPlainApiKey) {
    apiKeyInput.value = currentPlainApiKey;
    return;
  }

  if (currentRedactedSettings && currentRedactedSettings.hasApiKey) {
    apiKeyInput.value = currentRedactedSettings.apiKeyMasked || '';
    apiKeyInput.placeholder = '已配置 (输入新密钥以覆盖)';
  } else {
    apiKeyInput.value = '';
    apiKeyInput.placeholder = '请输入 API Key';
  }
}

/**
 * 渲染游戏站点列表
 * @param {Array<any>} sites
 */
function renderSitesTable(sites) {
  currentSites = Array.isArray(sites) ? sites : [];
  sitesTbody.innerHTML = '';

  if (currentSites.length === 0) {
    const tr = document.createElement('tr');
    tr.className = 'empty-row';
    const td = document.createElement('td');
    td.colSpan = 5;
    td.textContent = '暂未添加任何游戏站点';
    tr.appendChild(td);
    sitesTbody.appendChild(tr);
    return;
  }

  currentSites.forEach((site) => {
    const tr = document.createElement('tr');

    const originTd = document.createElement('td');
    originTd.textContent = site.origin + (site.title ? ` (${site.title})` : '');
    tr.appendChild(originTd);

    const gameIdTd = document.createElement('td');
    gameIdTd.textContent = site.gameId || '-';
    tr.appendChild(gameIdTd);

    const grantedTd = document.createElement('td');
    const grantedBadge = document.createElement('span');
    grantedBadge.className = site.granted ? 'badge badge-success' : 'badge badge-danger';
    grantedBadge.textContent = site.granted ? '已授权' : '未授权';
    grantedTd.appendChild(grantedBadge);
    tr.appendChild(grantedTd);

    const enabledTd = document.createElement('td');
    const enabledBadge = document.createElement('span');
    enabledBadge.className = site.enabled ? 'badge badge-neutral' : 'badge badge-danger';
    enabledBadge.textContent = site.enabled ? '启用' : '禁用';
    enabledTd.appendChild(enabledBadge);
    tr.appendChild(enabledTd);

    const actionTd = document.createElement('td');
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn btn-danger-outline';
    removeBtn.textContent = '移除';
    removeBtn.addEventListener('click', () => handleRemoveSite(site));
    actionTd.appendChild(removeBtn);
    tr.appendChild(actionTd);

    sitesTbody.appendChild(tr);
  });
}

/**
 * 应用表单数据
 * @param {object} settings
 */
function applySettingsToForm(settings) {
  currentRedactedSettings = settings;
  providerSelect.value = settings.provider || 'openai_compatible';
  modelInput.value = settings.model || '';
  baseUrlInput.value = settings.baseUrl || '';

  updateProviderView(providerSelect.value);
  renderApiKeyField();
  renderSitesTable(settings.gameSites || []);
}

/**
 * 密钥输入框交互绑定：避免在 DOM 长期留存明文
 */
apiKeyInput.addEventListener('focus', () => {
  if (!currentPlainApiKey && currentRedactedSettings && currentRedactedSettings.hasApiKey) {
    apiKeyInput.value = '';
  }
});

apiKeyInput.addEventListener('input', () => {
  currentPlainApiKey = apiKeyInput.value.trim();
});

apiKeyInput.addEventListener('blur', () => {
  if (!currentPlainApiKey) {
    renderApiKeyField();
  }
});

/**
 * 供应商切换：自动迁移未修改的模型名称
 */
providerSelect.addEventListener('change', () => {
  const previousProvider = currentRedactedSettings ? currentRedactedSettings.provider : 'openai_compatible';
  const newProvider = providerSelect.value;
  updateProviderView(newProvider);

  const prevDefaultModel = PROVIDER_DEFAULTS[previousProvider] ? PROVIDER_DEFAULTS[previousProvider].model : '';
  const newDefaultModel = PROVIDER_DEFAULTS[newProvider] ? PROVIDER_DEFAULTS[newProvider].model : '';

  if (!modelInput.value || modelInput.value === prevDefaultModel) {
    modelInput.value = newDefaultModel;
  }

  if (newProvider === 'openai_compatible' && !baseUrlInput.value) {
    baseUrlInput.value = PROVIDER_DEFAULTS.openai_compatible.baseUrl;
  }
});

/**
 * 保存设置提交
 */
settingsForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const provider = providerSelect.value;
  const model = modelInput.value.trim();
  const baseUrl = baseUrlInput.value.trim();

  if (!model) {
    showStatus('请输入模型名称', 'error');
    return;
  }

  try {
    const permReqPayload = { provider };
    if (provider === 'openai_compatible' && baseUrl) {
      permReqPayload.baseUrl = baseUrl;
    }
    const permResult = await sendRuntimeMessage(createMessage(PROVIDER_PERMISSION_REQUEST, permReqPayload));
    if (!permResult || !permResult.granted) {
      showStatus('AI 服务商网络访问权限未获得授权，可能导致无法连接', 'warning');
    }

    const payload = {
      provider,
      model
    };

    if (provider === 'openai_compatible') {
      payload.baseUrl = baseUrl;
    }

    if (currentPlainApiKey) {
      payload.apiKey = currentPlainApiKey;
    }

    const updatedSettings = await sendRuntimeMessage(createMessage(SETTINGS_SAVE, payload));
    currentPlainApiKey = '';
    applySettingsToForm(updatedSettings);
    showStatus('设置已成功保存', 'success');
  } catch (err) {
    showStatus(`保存失败: ${err.message}`, 'error');
  }
});

/**
 * 添加站点提交
 */
addSiteForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const rawUrl = siteUrlInput.value.trim();
  const gameId = siteGameIdInput.value.trim();

  if (!rawUrl) {
    showStatus('请输入游戏站点 URL', 'error');
    return;
  }

  let normalizedOrigin = '';
  try {
    normalizedOrigin = normalizeOrigin(rawUrl);
  } catch (err) {
    showStatus('无效的 URL 格式，请输入正确的网址', 'error');
    return;
  }

  try {
    const result = await sendRuntimeMessage(createMessage(SITES_ADD, {
      origin: normalizedOrigin,
      gameId: gameId || undefined
    }));

    if (!result.granted) {
      showStatus('站点已添加，但未授予访问权限', 'warning');
    } else {
      showStatus('游戏站点添加并授权成功', 'success');
    }

    siteUrlInput.value = '';
    siteGameIdInput.value = '';

    const latest = await sendRuntimeMessage(createMessage(SETTINGS_GET, {}));
    applySettingsToForm(latest);
  } catch (err) {
    showStatus(`添加站点失败: ${err.message}`, 'error');
  }
});

/**
 * 移除站点处理
 * @param {object} site
 */
async function handleRemoveSite(site) {
  const displayId = site.gameId ? ` (ID: ${site.gameId})` : '';
  const confirmRemove = window.confirm(`确定要移除站点 ${site.origin}${displayId} 吗？\n移除后将撤销对其的权限。`);
  if (!confirmRemove) {
    return;
  }

  try {
    await sendRuntimeMessage(createMessage(SITES_REMOVE, {
      origin: site.origin,
      gameId: site.gameId || undefined
    }));

    showStatus('站点已移除', 'success');
    const latest = await sendRuntimeMessage(createMessage(SETTINGS_GET, {}));
    applySettingsToForm(latest);
  } catch (err) {
    showStatus(`移除站点失败: ${err.message}`, 'error');
  }
}

/**
 * 初始化流程：发送 OPTIONS_READY，再读取脱敏设置
 */
async function initialize() {
  try {
    await sendRuntimeMessage(createMessage(OPTIONS_READY, {}));
  } catch (_) {
    // OPTIONS_READY 广播通知，失败不阻塞初始获取
  }

  try {
    const settings = await sendRuntimeMessage(createMessage(SETTINGS_GET, {}));
    applySettingsToForm(settings);
  } catch (err) {
    showStatus(`读取配置失败: ${err.message}`, 'error');
  }
}

document.addEventListener('DOMContentLoaded', initialize);
