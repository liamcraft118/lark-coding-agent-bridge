import { readFile } from 'node:fs/promises';
import { buildBridgeSystemPrompt } from '../bridge-system-prompt';
import { AgentPreflightError, type AgentAvailability } from '../preflight';
import type { AgentAdapter, AgentBotIdentity, AgentEvent, AgentRun, AgentRunOptions } from '../types';
import { searchWeb } from '../../web/search';

interface ChatAdapterOptions {
  baseUrl: string;
  model: string;
  apiKeyFile: string;
}

export class ChatAdapter implements AgentAdapter {
  readonly id = 'codex';
  readonly displayName = 'Chat API';
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKeyFile: string;
  private botIdentity: AgentBotIdentity | undefined;

  constructor(opts: ChatAdapterOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.model = opts.model;
    this.apiKeyFile = opts.apiKeyFile;
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).ok;
  }

  async checkAvailability(): Promise<AgentAvailability> {
    try {
      await readFile(this.apiKeyFile, 'utf8');
      return { ok: true };
    } catch {
      const diagnostic = { code: 'agent-binary-not-found' as const, agentId: 'codex' as const, agentName: 'Chat API', command: 'chat-api' };
      return { ok: false, diagnostic, error: new AgentPreflightError(diagnostic, 'chat API credential file is unavailable') };
    }
  }

  run(opts: AgentRunOptions): AgentRun {
    const controller = new AbortController();
    let stopped = false;
    const events = this.events(opts, controller.signal, () => stopped);
    return {
      runId: opts.runId,
      events,
      async stop() {
        stopped = true;
        controller.abort();
      },
      async waitForExit(): Promise<boolean> {
        return true;
      },
    };
  }

  private async *events(
    opts: AgentRunOptions,
    signal: AbortSignal,
    isStopped: () => boolean,
  ): AsyncGenerator<AgentEvent> {
    try {
      const auth = JSON.parse(await readFile(this.apiKeyFile, 'utf8')) as { OPENAI_API_KEY?: string };
      if (!auth.OPENAI_API_KEY) throw new Error('chat API credential is missing');
      const searchContext = await searchWeb(opts.prompt);
      const requestBody = {
        model: this.model,
        instructions: `${buildBridgeSystemPrompt(this.botIdentity)}\n\n## 文件生成\n当用户明确要求生成文件时，在最终回答中追加一个 JSON 代码块，格式为 {"file":{"format":"pdf|docx|xlsx|csv|md|txt","filename":"建议的文件名","content":"文件完整内容"}}。多个文件使用 {"files":[...]}。文件内容必须完整，代码块之外保留简短说明。不要为普通回答输出 file/files 标记。`,
        input: searchContext
          ? `${opts.prompt}\n\n以下是通过只读公开搜索得到的候选结果。请核对时间、来源和内容，不要把搜索摘要当作已确认事实：\n${searchContext}`
          : opts.prompt,
        ...(opts.threadId ? { previous_response_id: opts.threadId } : {}),
      };
      let response: Response;
      try {
        // The gateway's native web_search tool is unreliable in practice;
        // searchWeb() supplies read-only public results before this request.
        response = await this.post(requestBody, auth.OPENAI_API_KEY, signal, false);
      } catch (err) {
        if (isStopped() || signal.aborted) throw err;
        // Some compatible gateways accept the web_search schema but never
        // complete the tool call. Keep chat usable while making the fallback
        // explicit in the prompt so the model does not claim fresh research.
        response = await this.post(
          {
            ...requestBody,
            input: `实时搜索未获取到结果。不要声称已完成联网搜索；请基于已有知识回答，并说明当前没有可靠的实时来源。\n\n${opts.prompt}`,
          },
          auth.OPENAI_API_KEY,
          signal,
          false,
        );
      }
      if (!response.ok && response.status !== 401 && response.status !== 403) {
        response = await this.post(
          {
            ...requestBody,
            input: `实时搜索未获取到结果。不要声称已完成联网搜索；请基于已有知识回答，并说明当前没有可靠的实时来源。\n\n${opts.prompt}`,
          },
          auth.OPENAI_API_KEY,
          signal,
          false,
        );
      }
      if (!response.ok) throw new Error(`chat API returned HTTP ${response.status}`);
      const payload = (await response.json()) as { id?: string; output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> };
      if (payload.id) yield { type: 'system', threadId: payload.id, model: this.model };
      const text = payload.output_text ?? payload.output?.flatMap((item) => item.content ?? []).map((part) => part.text ?? '').join('') ?? '';
      if (text) yield { type: 'final_text', content: text };
      yield { type: 'done', terminationReason: isStopped() ? 'interrupted' : 'normal' };
    } catch (err) {
      if (isStopped()) {
        yield { type: 'done', terminationReason: 'interrupted' };
      } else {
        yield { type: 'error', message: err instanceof Error ? err.message : String(err), terminationReason: 'failed' };
      }
    }
  }

  private async post(
    body: Record<string, unknown>,
    apiKey: string,
    parentSignal: AbortSignal,
    withSearch: boolean,
  ): Promise<Response> {
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    parentSignal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), withSearch ? 35_000 : 90_000);
    try {
      return await fetch(`${this.baseUrl}/v1/responses`, {
        method: 'POST',
        signal: controller.signal,
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(withSearch ? { ...body, tools: [{ type: 'web_search' }] } : body),
      });
    } finally {
      clearTimeout(timer);
      parentSignal.removeEventListener('abort', onAbort);
    }
  }
}
