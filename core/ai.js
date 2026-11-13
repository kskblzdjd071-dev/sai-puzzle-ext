// 职责：AI 提示词装配、密钥安全检测、多服务商路由与请求执行调度
// 作者：Apple

import { openaiAdapter } from './providers/openai.js';
import { deepseekAdapter } from './providers/deepseek.js';
import { geminiAdapter } from './providers/gemini.js';

/**
 * 校验文本中绝无明文 API Key 泄漏风险
 * @param {string} text
 * @param {string} apiKey
 */
export function assertNoSecretInText(text, apiKey) {
  if (!text || typeof text !== 'string') {
    return;
  }
  if (apiKey && typeof apiKey === 'string' && apiKey.length > 5) {
    if (text.includes(apiKey)) {
      throw new Error('严重安全违规：文本中侦测到 API Key 泄漏风险');
    }
  }
}

/**
 * 构造线索提取 Prompt
 * @param {string} delta
 * @param {boolean} hasImage
 */
export function buildExtractPrompt(delta, hasImage) {
  const system =
    '你是一位专业的解谜游戏助手。请从用户提供的网页游戏最新文本增量或画面中，提炼出具有解谜价值的关键线索、密码、物品、位置信息。必须以 JSON 数组格式输出，字段格式：[{"text":"线索简述","tags":["标签"]}]。若无新线索，返回空数组 []。不要输出任何 Markdown 代码围栏之外的多余解释。';
  let user = '';
  if (delta && delta.trim()) {
    user += `【最新页面文本增量】\n${delta.trim()}\n\n`;
  }
  if (hasImage) {
    user += '【画面线索】附带了一张游戏现场截图，请结合画面提炼线索。';
  }
  if (!user.trim()) {
    user = '请根据提供的画面提炼线索。';
  }
  return { system, user };
}

/**
 * 构造解谜问答 Prompt
 * @param {string} question
 * @param {Array<import('./models.js').Clue>} clues
 */
export function buildAnswerPrompt(question, clues = []) {
  const system =
    '你是一位解谜智囊。以下是当前游戏已记录的所有已知线索。请根据这些客观事实回答玩家当前的疑问，并给出后续探索建议。输出必须包含三部分：1. 现状线索总结；2. 建议的下一步；3. 针对问题的具体解答。';

  let cluesBlock = '';
  if (clues.length === 0) {
    cluesBlock = '（暂无已记录的历史线索）';
  } else {
    cluesBlock = clues
      .map((c, i) => {
        const tagStr = c.tags && c.tags.length ? ` [${c.tags.join(',')}]` : '';
        return `${i + 1}. ${c.text}${tagStr}`;
      })
      .join('\n');
  }

  const user = `【已知线索池】\n${cluesBlock}\n\n【玩家当前疑问】\n${question}\n\n请针对上述疑问给出详细推演、线索总结及下一步行动建议。若能按结构化标记【总结】、【建议】、【解答】作答更佳。`;

  return { system, user };
}

/**
 * 根据设置选择对应的 Provider 适配器
 * @param {import('./models.js').Settings} settings
 */
export function selectProvider(settings) {
  const p = settings.provider;
  if (p === 'deepseek') {
    return deepseekAdapter;
  }
  if (p === 'gemini') {
    return geminiAdapter;
  }
  return openaiAdapter;
}

/**
 * 提取 AI 文本中的 JSON 结构
 * @param {string} rawText
 */
function parseJsonFromText(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    return null;
  }
  const trimmed = rawText.trim();

  try {
    return JSON.parse(trimmed);
  } catch (_) {}

  const match = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (match) {
    try {
      return JSON.parse(match[1].trim());
    } catch (_) {}
  }

  return null;
}

/**
 * 归一化 Token 用量统计结构
 * @param {any} usage
 */
function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') {
    return undefined;
  }
  const promptTokens = usage.promptTokens ?? usage.prompt_tokens ?? usage.promptTokenCount;
  const completionTokens =
    usage.completionTokens ?? usage.completion_tokens ?? usage.candidatesTokenCount;
  const totalTokens = usage.totalTokens ?? usage.total_tokens ?? usage.totalTokenCount;

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
 * 解析问答回复为三大结构化字段
 * @param {string} raw
 */
function parseAnswerText(raw) {
  const text = (raw || '').trim();
  let summary = '';
  const suggestions = [];
  let answer = text;

  const lines = text.split('\n');
  let currentSection = '';
  const sectionContent = {
    summary: [],
    suggestions: [],
    answer: []
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^(#+|\*+)?\s*(1\.|【|现状)?(现状)?线索总结[】:]?/i.test(trimmed)) {
      currentSection = 'summary';
      continue;
    } else if (/^(#+|\*+)?\s*(2\.|【)?(建议的?下一步|后续建议)[】:]?/i.test(trimmed)) {
      currentSection = 'suggestions';
      continue;
    } else if (/^(#+|\*+)?\s*(3\.|【)?(针对问题|具体解答|解答)[】:]?/i.test(trimmed)) {
      currentSection = 'answer';
      continue;
    }

    if (currentSection) {
      sectionContent[currentSection].push(line);
    }
  }

  if (sectionContent.summary.length > 0) {
    summary = sectionContent.summary.join('\n').trim();
  }
  if (sectionContent.suggestions.length > 0) {
    for (const item of sectionContent.suggestions) {
      const clean = item.replace(/^[-*•\d.]+\s*/, '').trim();
      if (clean) suggestions.push(clean);
    }
  }
  if (sectionContent.answer.length > 0) {
    answer = sectionContent.answer.join('\n').trim();
  }

  if (!summary) {
    summary = text.length > 120 ? text.slice(0, 120) + '...' : text;
  }
  if (suggestions.length === 0) {
    for (const line of lines) {
      const trimmed = line.trim();
      if (/^[-*•]\s+/.test(trimmed)) {
        suggestions.push(trimmed.replace(/^[-*•]\s+/, ''));
      }
    }
  }

  return { summary, suggestions, answer: answer || text };
}

/**
 * 创建 AI 客户端
 * @param {{ http: import('./models.js').HttpAdapter, getSettings: () => Promise<import('./models.js').Settings>, now?: () => number }} param0
 */
export function createAiClient({ http, getSettings, now = Date.now }) {
  if (!http) {
    throw new Error('缺少必需的 http 适配器');
  }
  if (typeof getSettings !== 'function') {
    throw new Error('缺少必需的 getSettings 回调');
  }

  function resolveBaseUrl(settings, provider) {
    if (settings && settings.provider === 'openai_compatible') {
      return settings.baseUrl;
    }
    return provider.defaultBaseUrl;
  }

  return {
    async extractClues(delta, image) {
      let deltaText = delta;
      let imageRef = image;
      if (delta && typeof delta === 'object' && !Array.isArray(delta)) {
        const payload = delta;
        deltaText = payload.delta;
        imageRef = payload.image;
      }

      const hasDelta = Boolean(
        deltaText && typeof deltaText === 'string' && deltaText.trim().length > 0
      );
      const hasImage = Boolean(imageRef && imageRef.dataBase64);

      if (!hasDelta && !hasImage) {
        return {
          clues: [],
          model: 'none'
        };
      }

      const settings = await getSettings();
      const provider = selectProvider(settings);
      let model = settings.model || provider.defaultModel;

      if (hasImage && !provider.supportsVision(model)) {
        const rawModel = (settings.model || '').toLowerCase();
        const isDeepSeek =
          settings.provider === 'deepseek' ||
          rawModel.includes('deepseek') ||
          rawModel === 'x-deepseek-v4.1-flash';

        if (settings.provider === 'openai_compatible' && isDeepSeek) {
          model = 'gemini-3.8-flash';
        } else if (settings.provider === 'gemini') {
          model = 'gemini-3.8-flash';
        } else {
          throw new Error(
            '当前选用的 AI 模型不支持图像识别，请在设置中更换为支持视觉的模型（如 gpt-4o 或 gemini-1.5-flash）'
          );
        }
      }

      const prompts = buildExtractPrompt(deltaText || '', hasImage);
      assertNoSecretInText(prompts.system, settings.apiKey);
      assertNoSecretInText(prompts.user, settings.apiKey);

      const messages = [
        { role: 'system', content: prompts.system },
        {
          role: 'user',
          content: prompts.user,
          image: hasImage ? imageRef : undefined
        }
      ];

      const res = await provider.complete({
        http,
        apiKey: settings.apiKey,
        baseUrl: resolveBaseUrl(settings, provider),
        model,
        messages
      });

      assertNoSecretInText(res.text, settings.apiKey);

      const parsed = parseJsonFromText(res.text);
      let rawClues = [];
      if (Array.isArray(parsed)) {
        rawClues = parsed;
      } else if (parsed && Array.isArray(parsed.clues)) {
        rawClues = parsed.clues;
      }

      const source = hasImage && !hasDelta ? 'screenshot' : 'text';
      const clues = rawClues
        .filter((c) => c && typeof c.text === 'string' && c.text.trim().length > 0)
        .map((c) => ({
          text: c.text.trim(),
          tags: Array.isArray(c.tags)
            ? c.tags.map((t) => String(t).trim()).filter(Boolean)
            : [],
          source: c.source === 'screenshot' || c.source === 'text' ? c.source : source
        }));

      return {
        clues,
        rawSummary: res.text,
        model: res.model || model,
        usage: normalizeUsage(res.usage)
      };
    },

    async answerQuestion(question, clues = []) {
      let questionText = question;
      let clueList = clues;
      if (question && typeof question === 'object') {
        const payload = question;
        questionText = payload.question;
        clueList = Array.isArray(payload.clues) ? payload.clues : [];
      }

      if (!questionText || typeof questionText !== 'string' || !questionText.trim()) {
        throw new Error('提问内容不能为空');
      }

      const settings = await getSettings();
      const provider = selectProvider(settings);
      const model = settings.model || provider.defaultModel;

      const prompts = buildAnswerPrompt(
        questionText.trim(),
        Array.isArray(clueList) ? clueList : []
      );
      assertNoSecretInText(prompts.system, settings.apiKey);
      assertNoSecretInText(prompts.user, settings.apiKey);

      const messages = [
        { role: 'system', content: prompts.system },
        { role: 'user', content: prompts.user }
      ];

      const res = await provider.complete({
        http,
        apiKey: settings.apiKey,
        baseUrl: resolveBaseUrl(settings, provider),
        model,
        messages
      });

      assertNoSecretInText(res.text, settings.apiKey);

      const structured = parseAnswerText(res.text);

      return {
        ...structured,
        model: res.model || model,
        usage: normalizeUsage(res.usage)
      };
    }
  };
}
