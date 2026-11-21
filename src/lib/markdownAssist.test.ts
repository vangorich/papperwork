import { createServer, type RequestListener } from 'node:http'
import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { assistMarkdown, normalizeMarkdownEndpoint } from './markdownAssist'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); invoke.mockReset() })

// Every server binds an OS-assigned loopback port. No DNS, real provider, key or document needed.
async function localServer(handler: RequestListener, test: (base: string) => Promise<void>) {
  const server = createServer(handler)
  server.listen(0, '127.0.0.1')
  try {
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing test port')
    await test(`http://127.0.0.1:${address.port}`)
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}
const valid = { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '# 本地结果\n' } }] }

describe('Markdown API boundary', () => {
  it('discloses the exact normalized POST address without making a request', () => {
    for (const base of ['https://api.invalid', 'https://api.invalid/v1/', 'https://api.invalid/v1/chat/completions']) {
      expect(normalizeMarkdownEndpoint(base)).toBe('https://api.invalid/v1/chat/completions')
    }
    expect(normalizeMarkdownEndpoint('http://[::1]:8080/team/v1')).toBe('http://[::1]:8080/team/v1/chat/completions')
    expect(normalizeMarkdownEndpoint('http://localhost:8080/chat/completions/')).toBe('http://localhost:8080/chat/completions')
    for (const invalid of ['file:///tmp/a', 'http://remote.invalid/v1', 'http://localhost.evil.invalid', 'http://127.1',
      'https://name:secret@api.invalid', 'https://@api.invalid', 'https://api.invalid/v1?', 'https://api.invalid/v1#',
      'http:////localhost', 'https://api.invalid\\@other.invalid', 'https://api.invalid/other/../v1']) {
      expect(() => normalizeMarkdownEndpoint(invalid)).toThrow()
    }
  })
  it('posts only the selected preview with an optional bearer, not nearby synthetic document text', async () => {
    const synthetic = 'UNSELECTED BEFORE\n  甲 “quoted”\r\n二 📝  \nUNSELECTED AFTER %PDF-1.7'
    const preview = synthetic.slice(synthetic.indexOf('  甲'), synthetic.indexOf('\nUNSELECTED AFTER'))
    let seen: { path?: string; method?: string; bearer?: string; cookie?: string; body: string } | undefined
    const fetch = vi.spyOn(globalThis, 'fetch')
    await localServer(async (req, res) => {
      let body = ''; for await (const chunk of req) body += chunk
      seen = { path: req.url, method: req.method, bearer: req.headers.authorization, cookie: req.headers.cookie, body }
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(valid))
    }, async endpoint => {
      expect(await assistMarkdown(preview, { endpoint, model: 'mock-model', apiKey: 'fake-test-only' })).toBe('# 本地结果\n')
    })
    expect(seen).toMatchObject({ path: '/v1/chat/completions', method: 'POST', bearer: 'Bearer fake-test-only', cookie: undefined })
    expect(JSON.parse(seen!.body)).toEqual({ model: 'mock-model', messages: [
      { role: 'system', content: expect.any(String) }, { role: 'user', content: preview },
    ] })
    expect(seen!.body).not.toMatch(/UNSELECTED|%PDF|fake-test-only/)
    expect(fetch.mock.calls[0][1]).toMatchObject({ credentials: 'omit', redirect: 'error', cache: 'no-store', mode: 'cors', referrerPolicy: 'no-referrer' })
  })
  it('never follows a redirect and does not echo endpoint error bodies', async () => {
    let hits = 0
    await localServer((req, res) => {
      hits++
      if (req.url?.startsWith('/redirect/')) res.writeHead(307, { Location: '/leak' })
      else res.writeHead(401)
      res.end('synthetic-preview fake-test-only')
    }, async base => {
      const config = { endpoint: base + '/redirect/v1', model: 'mock', apiKey: 'fake-test-only' }
      await expect(assistMarkdown('synthetic-preview', config)).rejects.toThrow(/连接|网络/)
      await expect(assistMarkdown('synthetic-preview', { ...config, endpoint: base })).rejects.toThrow(/^API 拒绝了访问，请检查密钥和模型权限。$/)
      expect(hits).toBe(2)
    })
  })
  it('rejects malformed, incomplete, empty, refused, oversized and error replies', async () => {
    const bad: Array<[string, RegExp]> = [
      ['{', /有效的 Markdown/], [JSON.stringify({ ...valid, error: { message: 'SECRET_BODY' } }), /API 请求未成功/],
      [JSON.stringify({ choices: [{ message: { content: 'SECRET_BODY' }, finish_reason: 'length' }] }), /未完整/],
      [JSON.stringify({ choices: [{ message: { content: 'SECRET_BODY' } }] }), /未完整/],
      [JSON.stringify({ choices: [{ message: { content: ' ' }, finish_reason: 'stop' }] }), /有效的 Markdown/],
      [JSON.stringify({ choices: [{ message: { content: 'SECRET_BODY', refusal: 'refused' }, finish_reason: 'stop' }] }), /有效的 Markdown/],
      [' '.repeat(4 * 1024 * 1024 + 1), /超出 4 MiB/],
    ]
    let i = 0
    await localServer((_req, res) => { res.writeHead(200); res.write(bad[i++][0]); res.end() }, async endpoint => {
      for (const [, expected] of bad) await expect(assistMarkdown('合成', { endpoint, model: 'm' })).rejects.toThrow(expected)
      expect(i).toBe(bad.length)
    })
  })
  it('cancels the in-flight connection, and never sends an already-aborted or oversized preview', async () => {
    const abort = new AbortController()
    let hits = 0
    let closed!: () => void
    const disconnected = new Promise<void>(resolve => { closed = resolve })
    await localServer((_req, res) => { hits++; res.once('close', closed); abort.abort() }, async endpoint => {
      const config = { endpoint, model: 'mock' }
      await expect(assistMarkdown('选区', config, abort.signal)).rejects.toMatchObject({ name: 'AbortError' })
      await disconnected
      await expect(assistMarkdown('选区', config, abort.signal)).rejects.toMatchObject({ name: 'AbortError' })
      await expect(assistMarkdown('字'.repeat(350_000), config)).rejects.toThrow('1 MiB')
      const extra = { ...config, files: ['SECRET_PATH'], messages: [] }
      await expect(assistMarkdown('text', extra)).rejects.toThrow()
      await expect(assistMarkdown('text', { ...config, apiKey: 'bad\r\nheader' })).rejects.toThrow()
      expect(hits).toBe(1)
    })
  })
  it('uses typed native IPC, never browser fetch, and ignores any late result after cancel', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
    const fetch = vi.spyOn(globalThis, 'fetch')
    let started!: () => void, finish!: (value: string) => void
    const ready = new Promise<void>(resolve => { started = resolve })
    invoke.mockImplementationOnce(() => { started(); return new Promise<string>(resolve => { finish = resolve }) }).mockResolvedValue(undefined)
    const abort = new AbortController()
    const result = assistMarkdown(' only the selection ', { endpoint: 'http://127.0.0.1:3456/v1', model: 'mock' }, abort.signal)
    await ready
    expect(invoke.mock.calls[0]).toEqual(['assist_markdown', { request: {
      requestId: expect.any(String), text: ' only the selection ', endpoint: 'http://127.0.0.1:3456/v1/chat/completions', model: 'mock',
    } }])
    abort.abort()
    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
    expect(invoke.mock.calls[1]).toEqual(['cancel_markdown_assist', { requestId: invoke.mock.calls[0][1].request.requestId }])
    finish('late result')
    expect(fetch).not.toHaveBeenCalled()
  })
  it('redacts arbitrary native failures and never retries through a different transport', async () => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
    const fetch = vi.spyOn(globalThis, 'fetch')
    invoke.mockRejectedValueOnce('bad args: TOKEN and FULL PRIVATE PREVIEW')
    await expect(assistMarkdown('FULL PRIVATE PREVIEW', { endpoint: 'http://localhost', model: 'mock', apiKey: 'TOKEN' }))
      .rejects.toThrow(/^无法连接到 API。请检查地址和网络；浏览器模式还需要服务允许跨域请求。$/)
    expect(fetch).not.toHaveBeenCalled()
  })
})
