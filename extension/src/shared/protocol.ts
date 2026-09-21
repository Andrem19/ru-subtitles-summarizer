// Chat clients: OpenAI-compatible (LM Studio, paas/v4, ...) and
// Anthropic-compatible (Z.ai Coding Plan at https://api.z.ai/api/anthropic).

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type ApiProtocol = 'openai' | 'anthropic';

export interface ApiConfig {
  endpoint: string;
  apiKey: string;
  model: string;
  temperature: number;
  /** default: 'openai' */
  protocol?: ApiProtocol;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly kind: 'unreachable' | 'auth' | 'notFound' | 'rateLimit' | 'server' | 'badResponse' | 'timeout',
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

function chatUrl(endpoint: string): string {
  return `${endpoint.replace(/\/+$/, '')}/chat/completions`;
}

function modelsUrl(endpoint: string): string {
  return `${endpoint.replace(/\/+$/, '')}/models`;
}

function messagesUrl(endpoint: string): string {
  return `${endpoint.replace(/\/+$/, '')}/v1/messages`;
}

function headers(apiKey: string): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) h['Authorization'] = `Bearer ${apiKey}`;
  return h;
}

async function readBody(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

function mapHttpStatus(status: number, snippet: string): ProviderError {
  if (status === 401 || status === 403) {
    return new ProviderError(
      `Ошибка авторизации (${status}). Проверьте API-ключ в настройках расширения. ${snippet.slice(0, 200)}`,
      'auth',
      status,
    );
  }
  if (status === 404) {
    return new ProviderError(
      `Endpoint или модель не найдены (404). Проверьте URL endpoint и название модели. ${snippet.slice(0, 200)}`,
      'notFound',
      status,
    );
  }
  if (status === 429) {
    return new ProviderError(`Слишком много запросов (429). Повтор... ${snippet.slice(0, 200)}`, 'rateLimit', status);
  }
  return new ProviderError(
    `Сервер перевода вернул ошибку ${status}. ${snippet.slice(0, 200)}`,
    'server',
    status,
  );
}

/** Single chat completion. Returns assistant text content. */
export async function chatCompletion(
  fetchImpl: typeof fetch,
  cfg: ApiConfig,
  messages: ChatMessage[],
  opts: { maxTokens?: number; timeoutMs?: number } = {},
): Promise<string> {
  if (cfg.protocol === 'anthropic') {
    return chatCompletionAnthropic(fetchImpl, cfg, messages, opts);
  }
  return chatCompletionOpenAI(fetchImpl, cfg, messages, opts);
}

async function chatCompletionOpenAI(
  fetchImpl: typeof fetch,
  cfg: ApiConfig,
  messages: ChatMessage[],
  opts: { maxTokens?: number; timeoutMs?: number } = {},
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 180_000);
  let res: Response;
  try {
    res = await fetchImpl(chatUrl(cfg.endpoint), {
      method: 'POST',
      headers: headers(cfg.apiKey),
      body: JSON.stringify({
        model: cfg.model,
        temperature: cfg.temperature,
        stream: false,
        max_tokens: opts.maxTokens ?? 4000,
        messages,
      }),
      signal: controller.signal,
    });
  } catch (e) {
    if (controller.signal.aborted) {
      throw new ProviderError('Истекло время ожидания ответа от сервера перевода.', 'timeout');
    }
    throw new ProviderError(
      `Не удалось подключиться к ${cfg.endpoint}. Проверьте, что сервис перевода доступен (и ваш интернет — для облачных endpoint).`,
      'unreachable',
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw mapHttpStatus(res.status, await readBody(res));
  }
  const bodyText = await readBody(res);
  let json: unknown;
  try {
    json = JSON.parse(bodyText);
  } catch {
    throw new ProviderError('Ответ сервера — не JSON.', 'badResponse');
  }
  const content = extractAssistantContent(json);
  if (!content) {
    throw new ProviderError('Пустой ответ модели (нет choices[0].message.content).', 'badResponse');
  }
  return content;
}

/**
 * Anthropic-compatible /v1/messages (Z.ai Coding Plan).
 * Subtitle translation does not need reasoning — thinking is disabled for speed.
 */
async function chatCompletionAnthropic(
  fetchImpl: typeof fetch,
  cfg: ApiConfig,
  messages: ChatMessage[],
  opts: { maxTokens?: number; timeoutMs?: number } = {},
): Promise<string> {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const rest = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role, content: m.content }));

  const body: Record<string, unknown> = {
    model: cfg.model,
    max_tokens: opts.maxTokens ?? 4000,
    temperature: cfg.temperature,
    thinking: { type: 'disabled' },
    messages: rest,
  };
  if (system) body['system'] = system;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 180_000);
  let res: Response;
  try {
    res = await fetchImpl(messagesUrl(cfg.endpoint), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    if (controller.signal.aborted) {
      throw new ProviderError('Истекло время ожидания ответа от сервера перевода.', 'timeout');
    }
    throw new ProviderError(
      `Не удалось подключиться к ${cfg.endpoint}. Проверьте, что сервис перевода доступен (и ваш интернет — для облачных endpoint).`,
      'unreachable',
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw mapHttpStatus(res.status, await readBody(res));
  }
  const bodyText = await readBody(res);
  let json: unknown;
  try {
    json = JSON.parse(bodyText);
  } catch {
    throw new ProviderError('Ответ сервера — не JSON.', 'badResponse');
  }
  const blocks = (json as { content?: unknown })?.content;
  const content = Array.isArray(blocks)
    ? blocks
        .map((b) => (typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'text'
          ? (b as { text?: unknown }).text
          : ''))
        .filter((t): t is string => typeof t === 'string')
        .join('')
    : '';
  if (!content) {
    throw new ProviderError('Пустой ответ модели (нет content-блоков).', 'badResponse');
  }
  return content;
}

export function extractAssistantContent(json: unknown): string {
  const choices = (json as { choices?: unknown })?.choices;
  if (!Array.isArray(choices) || choices.length === 0) return '';
  const message = (choices[0] as { message?: { content?: unknown } }).message;
  const content = message?.content;
  return typeof content === 'string' ? content : '';
}

export interface ModelsResult {
  models: string[];
  ok: boolean;
  error?: string;
}

export async function listModels(
  fetchImpl: typeof fetch,
  cfg: Pick<ApiConfig, 'endpoint' | 'apiKey' | 'protocol'>,
  timeoutMs = 10_000,
): Promise<ModelsResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const h = cfg.protocol === 'anthropic'
    ? { 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' }
    : headers(cfg.apiKey);
  try {
    const res = await fetchImpl(modelsUrl(cfg.endpoint), { headers: h, signal: controller.signal });
    if (!res.ok) throw mapHttpStatus(res.status, await readBody(res));
    const json = (await res.json()) as { data?: Array<{ id?: unknown }> };
    const models = (json.data ?? [])
      .map((m) => (typeof m.id === 'string' ? m.id : ''))
      .filter((id) => id.length > 0);
    return { models, ok: true };
  } catch (e) {
    if (controller.signal.aborted) {
      return { models: [], ok: false, error: 'Нет ответа (таймаут).' };
    }
    if (e instanceof ProviderError) return { models: [], ok: false, error: e.message };
    return { models: [], ok: false, error: `Не удалось подключиться к ${cfg.endpoint}.` };
  } finally {
    clearTimeout(timer);
  }
}
