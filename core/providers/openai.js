// 职责：OpenAI 兼容协议客户端适配，包含消息格式转换与鉴权头注入
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
  const cleanBase = (baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
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

/**
 * 将内部统一消息结构转换为 OpenAI 标准接口体格式
 */
function formatOpenAiMessages(messages) {
  return messages.map((m) => {
    if (!m.image) {
      return {
        role: m.role,
        content: m.content
      };
    }

    const parts = [{ type: 'text', text: m.content }];
    parts.push({
      type: 'image_url',
      image_url: {
        url: `data:${m.image.mimeType};base64,${m.image.dataBase64}`
      }
    });

    return {
      role: m.role,
      content: parts
    };
  });
}

export const openaiAdapter = {
  id: 'openai_compatible',
  defaultBaseUrl: 'https://api.openai.com/v1',
  defaultModel: 'gpt-4o',

  hostPatterns(baseUrl) {
    if (!baseUrl) {
      return ['https://api.openai.com/*'];
    }
    try {
      const u = new URL(baseUrl);
      return [`${u.origin}/*`];
    } catch (_) {
      return ['https://api.openai.com/*'];
    }
  },

  supportsVision(model) {
    if (!model || typeof model !== 'string') {
      return false;
    }
    const m = model.trim().toLowerCase();
    return /^(?:gpt-4o-mini|gpt-4o|gpt-4-turbo|gemini-3\.8-flash)(?:-(?:\d{4}-\d{2}-\d{2}|\d+|tiered))?$/.test(m);
  },

  async complete({ http, apiKey, baseUrl, model, messages }) {
    if (!apiKey || !apiKey.trim()) {
      throw new Error('未配置 API Key，请在设置中配置');
    }

    const url = buildUrl(baseUrl, 'chat/completions');
    const reqBody = {
      model: model || this.defaultModel,
      messages: formatOpenAiMessages(messages),
      temperature: 0.2
    };

    const hasImageContent = messages.some((m) => {
      if (m && m.image) {
        return true;
      }
      if (Array.isArray(m.content)) {
        return m.content.some((part) => part && part.type === 'image_url');
      }
      return false;
    });

    const requestOptions = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey.trim()}`
      },
      body: JSON.stringify(reqBody)
    };
    if (hasImageContent) {
      requestOptions.timeoutMs = 60000;
    }

    async function executeRequest() {
      return await http.request(url, requestOptions);
    }

    let res;
    try {
      res = await executeRequest();
    } catch (reqErr) {
      const em = String(reqErr && reqErr.message ? reqErr.message : reqErr);
      if (em.includes('502') || em.includes('429') || em.includes('503') || em.includes('524')) {
        await new Promise((r) => setTimeout(r, 100));
        res = await executeRequest();
      } else {
        throw reqErr;
      }
    }

    if (res.status === 502 || res.status === 429 || res.status === 503 || res.status === 524) {
      await new Promise((r) => setTimeout(r, 100));
      res = await executeRequest();
    }

    if (res.status < 200 || res.status >= 300) {
      let errMsg = `OpenAI 接口调用失败 (HTTP ${res.status})`;
      if (res.json && res.json.error && res.json.error.message) {
        errMsg = `OpenAI 接口错误: ${res.json.error.message} (HTTP ${res.status})`;
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
