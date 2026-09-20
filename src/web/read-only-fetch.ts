import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { extractPromptUserText } from '../agent/prompt';

const MAX_URLS = 3;
const MAX_BYTES = 2_000_000;
const MAX_TEXT = 40_000;
const TIMEOUT_MS = 15_000;
const MAX_CONCURRENT_FETCHES = 6;
let activeFetches = 0;
const fetchWaiters: Array<() => void> = [];

export async function enrichPromptWithWebPages(prompt: string): Promise<string> {
  const urls = [...new Set(extractUrls(extractPromptUserText(prompt)))].slice(0, MAX_URLS);
  if (urls.length === 0) return prompt;

  const pages = await Promise.all(urls.map((url) => fetchReadablePage(url)));
  const readable = pages.filter((page): page is string => Boolean(page));
  if (readable.length === 0) return prompt;
  return `${prompt}\n\n## 只读网页资料\n${readable.join('\n\n')}`;
}

/** Fetch one public page for the bridge's read-only research pipeline. */
export async function fetchPublicPage(url: string): Promise<string | null> {
  return fetchReadablePage(url);
}

function extractUrls(prompt: string): string[] {
  return (prompt.match(/https?:\/\/[^\s<>"']+/gi) ?? []).map((value) => value.replace(/[),.;!?]+$/g, ''));
}

async function fetchReadablePage(initialUrl: string): Promise<string | null> {
  try {
    return await fetchReadablePageUnsafe(initialUrl);
  } catch {
    return null;
  }
}

async function fetchReadablePageUnsafe(initialUrl: string): Promise<string | null> {
  let current = initialUrl;
  for (let hop = 0; hop <= 3; hop += 1) {
    const url = new URL(current);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    await assertPublicHost(url.hostname);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let response: Response;
    await acquireFetchSlot();
    try {
      response = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: { accept: 'text/html,application/xhtml+xml,text/plain;q=0.9' },
      });
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      releaseFetchSlot();
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return null;
      current = new URL(location, url).toString();
      continue;
    }
    if (!response.ok) return null;
    const type = response.headers.get('content-type') ?? '';
    if (!type.includes('text/html') && !type.includes('application/xhtml+xml') && !type.includes('text/plain')) {
      return `[${initialUrl}] 页面已返回 ${type || '未知类型'}，当前只读抓取器暂不解析该文件类型。`;
    }
    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > MAX_BYTES) return `[${initialUrl}] 页面超过 2 MB，已跳过。`;
    const body = await response.text();
    const text = cleanHtml(body).slice(0, MAX_TEXT).trim();
    return text ? `[来源: ${url}]\n${text}` : null;
  }
  return null;
}

async function acquireFetchSlot(): Promise<void> {
  if (activeFetches < MAX_CONCURRENT_FETCHES) {
    activeFetches += 1;
    return;
  }
  await new Promise<void>((resolve) => fetchWaiters.push(resolve));
  activeFetches += 1;
}

function releaseFetchSlot(): void {
  activeFetches = Math.max(0, activeFetches - 1);
  fetchWaiters.shift()?.();
}

async function assertPublicHost(hostname: string): Promise<void> {
  const addresses = isIP(hostname) ? [hostname] : (await lookup(hostname, { all: true })).map((entry) => entry.address);
  if (addresses.some(isPrivateAddress)) throw new Error('private network address is not allowed');
}

function isPrivateAddress(address: string): boolean {
  if (address === '::1' || address.startsWith('fc') || address.startsWith('fd') || address.startsWith('fe80:') || address.startsWith('::ffff:127.')) return true;
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  const first = parts[0] ?? -1;
  const second = parts[1] ?? -1;
  return first === 10 || first === 127 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168) || (first === 169 && second === 254);
}

function cleanHtml(input: string): string {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ');
}
