# Single-page crawler API — prototype2

A backend-only Tavily-style retrieval prototype that accepts one public HTTP/HTTPS URL, retrieves it through a bounded anti-bot strategy ladder, extracts useful content, and returns structured JSON in the same API request.

**Stack:** Node.js 24 LTS, strict TypeScript, Express 5, tRPC 11, Zod 4, Crawlee 3 (`@crawlee/cheerio`), Impit browser-profile HTTP, Patchright Chromium, Cheerio, Pino, and Vitest. Normal pages use the low-overhead Crawlee HTTP path; protected pages can escalate to a browser-profile HTTP request and then JavaScript rendering.

## Quick start

Run these commands from `prototype2`:

```bash
npm install
cp .env.example .env
npm run browser:install
npm run dev
```

Defaults also work without an `.env` file. With nvm, `nvm use` selects Node 24.

On a Windows-mounted/WSL filesystem that rejects executable links, use `npm install --no-bin-links`. The npm scripts invoke their JavaScript entry points directly and work with either installation method.

### Commands

```bash
npm run dev        # development server with reload
npm run typecheck  # strict type checking, including tests
npm test           # deterministic local-fixture tests
npm run build     # compile src/ into dist/
npm start         # run compiled server; build first
npm run browser:install       # download Chromium for the browser fallback
npm run browser:install-deps  # install Linux browser libraries where permitted
```

The server listens on port 3000 by default. SIGINT/SIGTERM stop accepting connections, cancel active crawls, close browser contexts, stop the guarded egress proxies, and close outbound connection pools.

## API

### Health

```bash
curl http://localhost:3000/health
```

```json
{"status":"ok"}
```

### Crawl a URL

`crawler.crawl` is a tRPC **mutation**, mounted at `/trpc`.

```bash
curl --request POST http://localhost:3000/trpc/crawler.crawl \
  --header 'Content-Type: application/json' \
  --data '{"url":"https://example.com"}'
```

With the default JSON transformer, a non-batched tRPC 11 request takes the plain input object above. The response has tRPC's standard envelope. For example, a page containing a heading and link could return:

```json
{
  "result": {
    "data": {
      "url": "https://example.com",
      "finalUrl": "https://example.com/",
      "httpStatus": 200,
      "title": "Example Domain",
      "description": null,
      "language": "en",
      "headings": [{"level": 1, "text": "Example Domain"}],
      "text": "Example Domain Learn more",
      "links": [{"text": "Learn more", "url": "https://www.iana.org/domains/example"}],
      "meta": {
        "durationMs": 180.25,
        "fetchedAt": "2026-01-01T12:00:00.000Z",
        "textTruncated": false,
        "linksTruncated": false,
        "headingsTruncated": false,
        "strategy": "http",
        "rendered": false,
        "attemptCount": 1,
        "retrievalDurationMs": 180.1,
        "extractionDurationMs": 4.2
      }
    }
  }
}
```

Content and timings depend on the actual upstream response. `durationMs` is measured using a monotonic clock; `fetchedAt` is the extraction-completion timestamp. The original input URL is preserved, and `finalUrl` includes redirects.

The optional input mode selects a strategy for diagnosis:

```json
{"url":"https://example.com","mode":"auto"}
```

Supported modes are `auto`, `http`, `tls`, and `browser`. `auto` tries the normal HTTP path first, escalates to Impit's browser-profile HTTP transport for a plausible bot denial, and then uses the Patchright browser when JavaScript or browser verification is required. A successful strategy for the exact URL is remembered in a bounded in-process hint cache until its session TTL expires.

Extraction strips script/style/template/noscript and similar non-content elements, inserts block separators, and normalizes whitespace. Relative links honor the first usable HTML `<base>` element, defaulting to the final URL. HTTP/HTTPS links are deduplicated after removing fragments; empty, fragment-only, credential-bearing, and unsupported-protocol links are skipped. Missing scalar metadata is `null`; missing collections are empty arrays. Raw HTML is not returned.

Title, description, language, link text, and heading text also have fixed size caps (1,000 / 2,000 / 100 / 500 / 1,000 characters respectively). Collection and body-text truncation are reported in `meta`.

### Minimal typed client

`@trpc/client` is installed. A Node/TypeScript caller can use the exported router type:

```typescript
import { createTRPCClient, httpLink } from '@trpc/client';
import type { AppRouter } from './src/trpc/router.js';

const client = createTRPCClient<AppRouter>({
  links: [httpLink({ url: 'http://localhost:3000/trpc' })],
});

const result = await client.crawler.crawl.mutate({ url: 'https://example.com' });
console.log(result.title, result.meta.durationMs);
```

The import path assumes the caller is at this project's root; adjust it to your client location. This is a typed client example, not a frontend application.

## Configuration

Environment values are validated at startup; invalid values fail fast.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | HTTP listen port |
| `NODE_ENV` | `development` | `development`, `test`, or `production` |
| `LOG_LEVEL` | `info` | Pino level; `silent` is available for tests |
| `CRAWL_TIMEOUT_MS` | `10000` | Overall operation deadline; range 100–60000 ms |
| `MAX_CONCURRENT_CRAWLS` | `5` | Per-process active-operation cap; range 1–100 |
| `MAX_RESPONSE_BYTES` | `2097152` | Decoded response-body limit; range 1024–10485760 bytes |
| `MAX_TEXT_LENGTH` | `50000` | Maximum extracted body-text length |
| `MAX_LINKS` | `100` | Maximum returned distinct links |
| `MAX_HEADINGS` | `100` | Maximum returned headings |
| `MAX_REDIRECTS` | `5` | HTTP redirect cap; range 0–10 |
| `HTTP_TIMEOUT_MS` | `8000` | Per-HTTP-strategy timeout |
| `BROWSER_TIMEOUT_MS` | `15000` | Per-browser-strategy timeout |
| `MAX_STRATEGY_ATTEMPTS` | `3` | Maximum automatic retrieval strategies |
| `MAX_BROWSER_CONCURRENCY` | `2` | Active browser operations |
| `MAX_SESSIONS` | `10` | In-process anonymous session limit |
| `SESSION_TTL_MS` | `300000` | Idle session lifetime |
| `MAX_BROWSER_REQUESTS` | `100` | Per-browser-operation network request budget |
| `MAX_BROWSER_NETWORK_BYTES` | `8388608` | Decoded browser network budget |
| `TLS_BROWSER_PROFILE` | `chrome151` | Impit profile; also supports `chrome142` and `firefox144` |
| `BROWSER_ENABLED` | `true` | Enable browser escalation |
| `PROXY_URL` | unset | Optional configured upstream HTTP/HTTPS proxy |

## Execution and resource limits

- Each call uses CheerioCrawler with exactly one static, in-memory request list, no retries, and no discovered-link enqueueing.
- Result state, Crawlee configuration, storage, and lifecycle resources are isolated per operation.
- A public HTTP-client extension caps content length and streaming **decompressed** bytes before HTML parsing. Unsupported content and upstream errors are rejected when headers arrive.
- HTTP/HTTPS keep-alive agents are shared and bounded. HTTP/2 is disabled to make validated socket lookup behavior predictable.
- DNS results are checked against private, loopback, link-local, multicast, reserved, and other non-public address ranges, including IPv4-mapped IPv6. A hostname with any non-public DNS answer is rejected.
- Socket lookups are pinned to the validated DNS addresses to prevent DNS rebinding. Redirect destinations are validated before following them; the overall deadline also bounds a stalled DNS lookup.
- At capacity, new work immediately receives `TOO_MANY_REQUESTS`; no unbounded wait queue is created. Slots remain held until cleanup completes.
- An AbortSignal cancels outbound requests at the deadline. JavaScript's synchronous HTML parsing cannot be preempted midway; bounded input/output sizes keep that work limited, and brief cleanup can add to wall-clock time.
- Retrieval uses a bounded ladder: Crawlee HTTP → Impit browser-profile HTTP → Patchright browser. A browser is not launched for a normal successful page.
- The browser has isolated, exclusively leased in-process sessions. Cookie state is not transferred blindly between browser and native HTTP strategies, and idle sessions expire without Redis.
- A loopback CONNECT egress guard is used by Impit and Patchright. It validates public DNS answers, connects to validated numeric addresses, blocks private redirects/subresources, and keeps the browser's TLS/SNI profile intact.
- `cf-mitigated: challenge`, active CAPTCHA gates, login walls, rate limits, browser challenges, and ordinary upstream errors are classified separately. CAPTCHA solving is intentionally not included yet. CAPTCHA errors use tRPC `PRECONDITION_FAILED`/HTTP 412; a denial that remains after the ladder uses `BOT_BLOCKED`/HTTP 502.
- Crawlee storage is explicitly memory-only, without metadata/dataset artifacts. The configuration adapter avoids Crawlee's synchronous `crawlee.json` probing in the request path.

## Errors

Procedure failures use tRPC's error envelope, for example:

```json
{
  "error": {
    "message": "Local and non-public destinations are not allowed.",
    "code": -32003,
    "data": {
      "code": "FORBIDDEN",
      "httpStatus": 403,
      "path": "crawler.crawl",
      "reason": "DISALLOWED_DESTINATION"
    }
  }
}
```

| Failure | tRPC code | HTTP status |
| --- | --- | --- |
| Invalid input URL | `BAD_REQUEST` | 400 |
| Non-public destination | `FORBIDDEN` | 403 |
| DNS/connection failure, failed redirects, upstream non-2xx | `BAD_GATEWAY` | 502 |
| Deadline exceeded | `TIMEOUT` | 408 |
| Non-HTML content | `UNSUPPORTED_MEDIA_TYPE` | 415 |
| Oversized response | `PAYLOAD_TOO_LARGE` | 413 |
| Content extraction failure | `UNPROCESSABLE_CONTENT` | 422 |
| Capacity exhausted | `TOO_MANY_REQUESTS` | 429 |
| Service shutting down | `SERVICE_UNAVAILABLE` | 503 |
| Unexpected internal error | `INTERNAL_SERVER_ERROR` | 500 |
| Bot-blocked after fallback | `BAD_GATEWAY` | 502 |
| Active browser challenge | `BAD_GATEWAY` | 502 |
| CAPTCHA gate | `PRECONDITION_FAILED` | 412 |
| Rate limited | `TOO_MANY_REQUESTS` | 429 |

Classified crawl failures include a stable `data.reason`. Input-validation errors have `reason: null`. Stack traces are removed in every environment, and internal-error messages are generic. Malformed/oversized HTTP request bodies are handled by Express with a small JSON error; those fail before tRPC runs. Each HTTP response carries an `x-request-id` for log correlation. Complete page contents are never logged.

## Measure observed latency

With the API running, repeat this command to compare cold/warm connections:

```bash
curl --silent --show-error --output /dev/null \
  --write-out 'HTTP %{http_code} | total %{time_total}s\n' \
  --request POST http://localhost:3000/trpc/crawler.crawl \
  --header 'Content-Type: application/json' \
  --data '{"url":"https://example.com"}'
```

`curl` measures client-observed total latency. The result's `meta.durationMs` measures the service operation including cleanup. Pino records total inbound HTTP duration. DNS, TLS handshakes, remote response time, transfer size, and machine/filesystem speed all affect the result; there is no guaranteed response-time claim. The transport is loaded at application startup to avoid a lazy module import on the first crawl.

## Structure

```text
src/
  app/          Express composition and server lifecycle
  config/       Validated environment, logging, memory-only Crawlee configuration
  middleware/   Request logging and HTTP-level errors
  trpc/         Context, initialization, root router, exported AppRouter
  routers/      Thin crawler procedure and tRPC error mapping
  schemas/      Zod input schema and inferred input type
  services/     Crawl orchestration, bounded HTTP client, errors, pure HTML extraction
    antibot/    Retrieval ladder, response classifier, Impit, Patchright, egress guard, sessions
  types/        Shared result and extraction-limit contracts
  utils/        URL validation/public destination checks and text normalization
tests/
  extraction.test.ts
  crawler.test.ts
  antibot.test.ts
```

Tests use HTML strings and a local HTTP fixture. Only the test transport redirects validated public-address connections to that fixture; production safeguards stay active. They cover extraction, links, missing metadata, output caps, URL/address validation, private redirects, DNS failure/deadlines, gzip/chunked limits, HTTP failures, concurrent isolation, capacity recovery, shutdown, actual Express/tRPC envelopes, and a typed tRPC client. Tests never depend on a public website.

## Prototype limitations and extension points

The browser fallback executes JavaScript for the submitted page, but it does not solve CAPTCHAs, log into sites, or recursively crawl discovered links. It detects active CAPTCHA gates and returns `CAPTCHA_REQUIRED`. Results are returned immediately and not persisted.

Concurrency is bounded per Node process. Future multi-process deployments can add shared coordination when needed.

- **Multi-page crawling:** extend crawl orchestration in `crawler.service.ts` with an explicit crawl budget.
- **Browser rendering:** the initial Patchright strategy is in `src/services/antibot/browser.strategy.ts`; a later managed browser provider can implement the same retrieved-page contract.
- **Persistence:** add a dedicated storage service after extraction.
- **Background jobs:** have workers call the existing services, preserving transport-independent extraction.
- **Search/embeddings:** add separate post-processing services that consume extracted results.

No frontend, database, Redis, BullMQ, external browser service, authentication, or search infrastructure is required by this prototype. The local browser fallback does require the Chromium runtime installed by `npm run browser:install`.
