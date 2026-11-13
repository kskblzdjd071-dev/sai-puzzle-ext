// 职责：Google Gemini 原生 REST 协议适配器，支持多模态请求与专用鉴权头
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

function buildGeminiUrl(baseUrl, model) {
  const cleanBase = (baseUrl || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
  const cleanModel = model.replace(/^models\//, '');
  return `${cleanBase}/v1beta/models/${cleanModel}:generateContent`;
}

function normalizeGeminiUsage(data) {
  if (!data || typeof data !== 'object') {
    return undefined;
  }
  if (data.usage && typeof data.usage === 'object') {
    const p = data.usage.promptTokens ?? data.usage.prompt_tokens;
    const c = data.usage.completionTokens ?? data.usage.completion_tokens;
    const t = data.usage.totalTokens ?? data.usage.total_tokens;
    if (typeof p === 'number' || typeof c === 'number' || typeof t === 'number') {
      return {
        promptTokens: typeof p === 'number' ? p : 0,
        completionTokens: typeof c === 'number' ? c : 0,
        totalTokens: typeof t === 'number' ? t : 0
      };
    }
  }

  const meta = data.usageMetadata;
  if (meta && typeof meta === 'object') {
    const p = meta.promptTokenCount ?? meta.promptTokens ?? meta.prompt_tokens;
    const c = meta.candidatesTokenCount ?? meta.completionTokens ?? meta.completion_tokens;
    const t = meta.totalTokenCount ?? meta.totalTokens ?? meta.total_tokens;
    return {
      promptTokens: typeof p === 'number' ? p : 0,
      completionTokens: typeof c === 'number' ? c : 0,
      totalTokens: typeof t === 'number' ? t : 0
    };
  }

  return undefined;
}

/**
 * 转换内部统一消息为 Gemini 的 contents 格式
 */
function formatGeminiContents(messages) {
  let systemInstructionText = '';
  const contents = [];

  for (const m of messages) {
    if (m.role === 'system') {
      systemInstructionText += (systemInstructionText ? '\n\n' : '') + m.content;
      continue;
    }

    const role = m.role === 'assistant' ? 'model' : 'user';
    const parts = [];

    if (m.content) {
      parts.push({ text: m.content });
    }

    if (m.image && m.image.dataBase64) {
      parts.push({
        inlineData: {
          mimeType: m.image.mimeType || 'image/jpeg',
          data: m.image.dataBase64
        }
      });
    }

    contents.push({ role, parts });
  }

  let systemInstruction;
  if (systemInstructionText) {
    systemInstruction = {
      parts: [{ text: systemInstructionText }]
    };
  }

  return { contents, systemInstruction };
}

export const geminiAdapter = {
  id: 'gemini',
  defaultBaseUrl: 'https://generativelanguage.googleapis.com',
  defaultModel: 'gemini-1.5-flash',

  hostPatterns() {
    return ['https://generativelanguage.googleapis.com/*'];
  },

  supportsVision(model) {
    if (!model || typeof model !== 'string') {
      return false;
    }
    const m = model.trim().toLowerCase().replace(/^models\//, '');
    return /^(?:gemini-1\.5-pro|gemini-1\.5-flash|gemini-2\.0-flash|gemini-3\.8-flash)(?:-(?:\d{4}-\d{2}-\d{2}|\d+|tiered))?$/.test(m);
  },

  async complete({ http, apiKey, baseUrl, model, messages }) {
    if (!apiKey || !apiKey.trim()) {
      throw new Error('未配置 Gemini API Key，请在设置中配置');
    }

    const targetModel = model || this.defaultModel;
    const url = buildGeminiUrl(baseUrl, targetModel);
    const { contents, systemInstruction } = formatGeminiContents(messages);

    const bodyObj = {
      contents,
      generationConfig: {
        temperature: 0.2
      }
    };
    if (systemInstruction) {
      bodyObj.systemInstruction = systemInstruction;
    }

    const res = await http.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey.trim()
      },
      body: JSON.stringify(bodyObj)
    });

    if (res.status < 200 || res.status >= 300) {
      let errMsg = `Gemini 接口调用失败 (HTTP ${res.status})`;
      if (res.json && res.json.error && res.json.error.message) {
        errMsg = `Gemini 接口错误: ${res.json.error.message}`;
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

    let outputText = '';
    if (data.candidates && data.candidates.length > 0) {
      const cand = data.candidates[0];
      if (cand.content && cand.content.parts) {
        outputText = cand.content.parts
          .map((p) => (p && typeof p.text === 'string' ? p.text : ''))
          .join('');
      }
    }
    assertNoSecretInText(outputText, apiKey);

    return {
      text: outputText,
      model: targetModel,
      usage: normalizeGeminiUsage(data)
    };
  }
};
