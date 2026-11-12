// 职责：DeepSeek API 适配器（兼容 OpenAI 规范，无视觉支持）
// 作者：Apple

function assertNoSecretInText(text, apiKey) {
  if (!text || typeof text !== 'string') {
    return;
  }
  if (apiKey && typeof apiKey === 'string' && apiKey.length > 5) {
    if (text.includes(apiKey)) {
      throw new Error('严重安全违规：文本中侦测到 API Key 泄漏风险');
    }
  }
}

function buildUrl(baseUrl, path) {
  const cleanBase = (baseUrl || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
  const cleanPath = path.replace(/^\/+/, '');
  return `${cleanBase}/${cleanPath}`;
}

function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const promptTokens = raw.promptTokens ?? raw.prompt_tokens;
  const completionTokens = raw.completionTokens ?? raw.completion_tokens;
  const totalTokens = raw.totalTokens ?? raw.total_tokens;

  if (
    typeof promptTokens !== 'number' &&
    typeof completionTokens !== 'number' &&
    typeof totalTokens !== 'number'
  ) {
    return undefined;
  }

  return {
    promptTokens: typeof promptTokens === 'number' ? promptTokens : 0,
    completionTokens: typeof completionTokens === 'number' ? completionTokens : 0,
    totalTokens: typeof totalTokens === 'number' ? totalTokens : 0
  };
}

export const deepseekAdapter = {
  id: 'deepseek',
  defaultBaseUrl: 'https://api.deepseek.com/v1',
  defaultModel: 'deepseek-chat',

  hostPatterns() {
    return ['https://api.deepseek.com/*'];
  },

  supportsVision(_model) {
    return false;
  },

  async complete({ http, apiKey, baseUrl, model, messages }) {
    if (!apiKey || !apiKey.trim()) {
      throw new Error('未配置 DeepSeek API Key，请在设置中配置');
    }

    const url = buildUrl(baseUrl, 'chat/completions');
    const formattedMessages = messages.map((m) => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
    }));

    const reqBody = {
      model: model || this.defaultModel,
      messages: formattedMessages,
      temperature: 0.2
    };

    const res = await http.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey.trim()}`
      },
      body: JSON.stringify(reqBody)
    });

    if (res.status < 200 || res.status >= 300) {
      let errMsg = `DeepSeek 接口调用失败 (HTTP ${res.status})`;
      if (res.json && res.json.error && res.json.error.message) {
        errMsg = `DeepSeek 接口错误: ${res.json.error.message}`;
      } else if (res.text) {
        assertNoSecretInText(res.text, apiKey);
      }
      assertNoSecretInText(errMsg, apiKey);
      throw new Error(errMsg);
    }

    let data = res.json;
    if (!data && typeof res.text === 'string') {
      try {
        data = JSON.parse(res.text);
      } catch (_) {
        throw new Error('接口响应不是合法的 JSON，请稍后重试');
      }
    }

    if (!data || typeof data !== 'object') {
      throw new Error('接口响应不是合法的 JSON，请稍后重试');
    }

    const choice = data.choices && data.choices[0];
    const text = choice && choice.message ? choice.message.content : '';
    assertNoSecretInText(text, apiKey);

    return {
      text: text || '',
      model: data.model || model,
      usage: normalizeUsage(data.usage)
    };
  }
};
