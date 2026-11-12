// 职责：提供统一网络请求抽象，支持 Fetch 生产环境与测试 Mock 注入
// 作者：架构组

/**
 * 创建基于标准 Fetch API 的 HTTP 请求适配器
 * @returns {import('../core/models.js').HttpAdapter}
 */
export function createFetchHttpAdapter() {
  return {
    async request(url, init = {}) {
      const method = init.method || 'GET';
      const timeoutMs = typeof init.timeoutMs === 'number' ? init.timeoutMs : 30000;
      const headers = { ...(init.headers || {}) };
      const body = init.body;

      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, timeoutMs);

      try {
        const response = await fetch(url, {
          method,
          headers,
          body,
          signal: controller.signal
        });

        const text = await response.text();
        let json;
        try {
          json = JSON.parse(text);
        } catch (_) {
          json = undefined;
        }

        return {
          status: response.status,
          text,
          json
        };
      } catch (err) {
        throw new Error('网络请求异常，请检查网络连接');
      } finally {
        clearTimeout(timer);
      }
    }
  };
}

/**
 * 创建测试专用的 Mock HTTP 适配器
 * @param {(url: string, init?: any) => Promise<any> | any} handler
 * @returns {import('../core/models.js').HttpAdapter}
 */
export function createMockHttpAdapter(handler) {
  if (typeof handler !== 'function') {
    throw new Error('Mock 处理器必须为函数');
  }

  return {
    async request(url, init = {}) {
      const res = await handler(url, init);
      if (!res || typeof res.status !== 'number' || typeof res.text !== 'string') {
        throw new Error('Mock HTTP 处理器返回值不符合 HttpResponse 规范');
      }
      return {
        status: res.status,
        text: res.text,
        json: res.json
      };
    }
  };
}
