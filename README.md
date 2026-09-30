# Model Cockpit for the Turing College OpenRouter key

The cockpit runs on your computer. It shows:

- **Catalog.** All models that Turing College lists, with slugs (copy with one click), availability, prices for input, output and cache, context, parameters, benchmark scores, and your own usage per model. You can filter, sort, select columns, mark favorites and compare models.
  - **Available models**: the models that work now. **All Turing models**: the full Turing list. Models that do not work are greyed out.
  - Tiers add up. Basic is for all learners in the first sprint. From the second sprint, the advanced models are also available. The tier column shows the Turing tier of each model. Advanced models are not greyed out.
- **Usage.** Your Turing credit, your daily spend per model, spend by model, a value map (price against intelligence) and your recent requests.

It has three parts:

| Part | What it does |
| --- | --- |
| Server (`server/`) | Serves the UI at `http://localhost:8787`. Runs an OpenRouter proxy at `http://localhost:8787/api/v1` that logs model, tokens and cost of each call. Stores all data in `data/cockpit.db`. |
| Web UI (`web/`) | React app in the Turing College colors. |
| Chrome extension (`extension/`) | Reads your model list, tier and credit from the Turing College usage tracker every hour, and sends them to the server. |

## Requirements

- Node.js **22.13 or newer** (the server uses the built-in `node:sqlite`). Check with `node -v`.
- Google Chrome (or another Chromium browser).

## 1. Start the server

```bash
cd turing-cockpit
npm install
cp .env.example .env        # Windows: copy .env.example .env
npm start
```

Open `http://localhost:8787`. Keep the terminal open.

`npm start` builds the UI and starts the server. Next time, use `npm run serve` to start faster.

Windows: you can also double-click `start-cockpit.cmd`. It checks the Node.js version, installs the packages if necessary, and runs `npm start`.

## 2. Install the Chrome extension

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the `extension` folder.
4. Pin **Turing Cockpit Sync** to the toolbar and open it.
5. Enter your course email and click **Save and sync**.

The popup shows the result. The extension then syncs every hour (you can change this). A red "!" on the icon shows a problem.

## 3. Send your calls through the proxy

Change only the base URL in your course code. Keep your key.

```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:8787/api/v1", api_key=os.environ["OPENROUTER_API_KEY"])
```

LangChain: `ChatOpenAI(base_url="http://localhost:8787/api/v1", ...)`.
Plain HTTP: `POST http://localhost:8787/api/v1/chat/completions`.

The proxy forwards each request to OpenRouter without changes. It only adds `usage: {"include": true}` so that OpenRouter returns the cost. Streamed answers pass through at once. When an answer has no cost, the proxy gets it from the generation endpoint a few seconds later.

The per-model data starts on the day you start to use the proxy. The Turing total (dashed line in the Usage chart) includes all calls.

## 4. Benchmark scores

The Intelligence, Coding and Agentic columns work without a key. The OpenRouter model list carries these Artificial Analysis indexes for many models (about 260 of 628 in September 2026), with the exact model id, so no name matching is necessary.

For output speed and time to first token, add a free Artificial Analysis key:

1. Get a free API key at https://artificialanalysis.ai.
2. Put it in `.env` as `AA_API_KEY=...`.
3. Restart the server.

The free tier (`GET /api/v2/language/models/free`, 100 requests per day) sends the three indexes, output speed and time to first token. It does not send Math and GPQA, so these two columns are hidden by default. The cockpit loads the data once per day. After an error, it tries again after 1 hour and shows the error below the table.

Each benchmark column has an info icon. Hover over it to see the source and what the score measures. Artificial Analysis requires attribution; the UI shows it.

## 5. Availability

The Status column shows if a model works now. The automatic checks are free:

| Check | Cost | When | What it finds |
| --- | --- | --- | --- |
| Key model list | Free, needs `OPENROUTER_API_KEY` | At start, every 6 hours, for new Turing models at once, and with **Check availability** | `GET /api/v1/models/user`: the models that your key may use. Turing College limits its keys with guardrails, so this is the real answer for chat models. "Not for your key" = greyed out. |
| Providers | Free, no key | Same | `GET /api/v1/models/{id}/endpoints`: the providers that serve the model. "Retired" = the OpenRouter page exists, but no provider serves it (greyed out). |
| Test call | A fraction of a cent, for one model | Only when you click the small button in a row | One request with max. 16 tokens and reasoning off where the model allows it. It tries the Turing slug first, then the OpenRouter id. The result shows for 3 seconds, then the provider label comes back. The tooltip keeps the last result with its cost. A confirmation shows the expected cost first when it is above $0.001 or when the model always reasons. |

Click the provider label (for example "3 providers") to see every provider of the model: status, uptime (30 min, 1 day), latency, speed, prices, context, max output and quantization. Each row has a copy button for the **provider slug** (for example `google-vertex/global`). Use it in `provider.order` or `provider.only` of a request. "Copy example request body" copies a request with the healthy providers in order.

The real key list does not contain embedding, transcription, image or rerank models, and it is not clear if the key cannot use them or if the list leaves out these types. So these models show "Not in key list" in orange and are **not** greyed out.

There is no "test all models" button any more. In September 2026 it cost $0.77 for one run, mostly for reasoning tokens: several models reason by default (for example GPT-5.x) or always (for example Gemini 3.x Flash), and reasoning tokens bill as output tokens even with a small `max_tokens`. The free key model list gives the same answer for chat models without cost.

## 6. Free NVIDIA models (optional)

With `NVIDIA_API_KEY=nvapi-...` in `.env` (one key for all models, from https://build.nvidia.com/settings), the catalog gets a green **NVIDIA free** tab. Without the key, nothing about NVIDIA shows.

- **Which models:** only the models with the "Free Endpoint" label on build.nvidia.com. The cockpit reads this list from the public NGC catalog search (the same data as the filter on build.nvidia.com), every 6 hours, and keeps the models that the OpenAI-compatible API (`/v1/models`) also lists. On 26 September 2026: 38 free endpoints, of which 23 are chat and embedding models. Speech, video and other endpoints use other APIs and are left out.
- **How to call them:** `base_url = http://localhost:8787/api/nvidia/v1` and the model id from the table (for example `z-ai/glm-5.3`). The cockpit adds your NVIDIA key; any other key in the request (for example the OpenRouter key in your course code) is replaced. An own `nvapi-` key in the request is kept.
- **Logging:** calls show in the Usage tab with cost $0 and an "NVIDIA" label (model prefix `nim:`).
- **Turing tab:** a Turing model that is also free on NVIDIA shows a green line "Free on NVIDIA: <id>" with a copy button.
- **Benchmarks:** from the same model in the OpenRouter list, when the cockpit finds it.
- **Test call:** free, no confirmation. It counts against the NVIDIA rate limit. A 404 or 403 greys the row out for 24 hours.
- **Limits:** free for development and testing only. The rate limit is about 40 requests per minute and can be different per model. NVIDIA does not publish context lengths in the API, so the Context column is empty.

## 7. New Turing models and different model names

The extension sends the Turing list every hour. The server then:

1. Marks slugs that were not in the last list as **new** (for 14 days). The extension popup shows them too.
2. Finds the OpenRouter model for each slug, in this order:
   1. a link that you set by hand (see below)
   2. the exact id, or a known spelling difference (table below)
   3. the same words in another order or spelling, for example `claude-4.5-haiku` = `claude-haiku-4.5` = `claude-haiku-4-5`. Only one clear hit counts. These rows show a "check" label.
   4. the OpenRouter endpoints API. It also knows models that left the OpenRouter model list.
3. Runs the free availability check for the new slugs at once (key model list and providers).

If the match is wrong or missing, click **Link an OpenRouter model** below the slug, select the OpenRouter id and click Save. The link stays in `data/cockpit.db`.

Known spelling differences (checked with the real lists in September 2026: 58 of 59 Turing slugs are in the OpenRouter list):

| Difference | Example |
| --- | --- |
| Router alias needs `~` | `anthropic/claude-sonnet-latest` → `~anthropic/claude-sonnet-latest` |
| `xai/` instead of `x-ai/` | `xai/grok-4.5` → `x-ai/grok-4.5` |
| `-batch` instead of `:batch` | `google/gemini-3.7-flash-batch` → `google/gemini-3.7-flash:batch` |
| Short date suffix | `deepseek/deepseek-v4-flash-0423` → `deepseek/deepseek-v4-flash` |
| Other provider prefix | `rerank/rerank-4-pro` → `cohere/rerank-4-pro` |
| Canonical slug | `google/gemma-4-31b-it-20260402` → `google/gemma-4-31b-it` |
| Other word order or separator | `claude-4.5-haiku`, `claude-haiku-4-5` → `anthropic/claude-haiku-4.5` |

`anthropic/claude-3.5-haiku` is not in the OpenRouter model list. Its page https://openrouter.ai/anthropic/claude-3.5-haiku still exists, but the endpoints API shows 0 providers (checked 25 September 2026), so calls to it fail. The cockpit shows it as "Retired". The test `server/match.test.ts` checks all real Turing slugs against the real OpenRouter list (`server/fixtures/`). When Turing adds names, add them to `server/fixtures/turing-slugs-2026-09.txt` and run `npm test`.

## Settings (`.env`)

| Name | Use |
| --- | --- |
| `PORT` | Port of the cockpit. Default `8787`. If you change it, change the address in the extension popup too. |
| `OPENROUTER_API_KEY` | Optional. Used when a proxy request has no `Authorization` header, for `/api/key` (key limit from OpenRouter), for the key model list and for test calls. |
| `AA_API_KEY` | Optional. Speed and time to first token (the benchmark indexes work without it). |
| `NVIDIA_API_KEY` | Optional. Shows the **NVIDIA free** tab and opens the proxy at `/api/nvidia/v1`. |

## How the data is collected

| Data | Source |
| --- | --- |
| Model list per tier, your tier, credit, daily usage | Turing College usage tracker (Supabase table `model_tiers` and function `lookup-learner`), through the extension. The extension reads the site's public key from the site's own code each day. |
| Prices, context, modalities, features | `https://openrouter.ai/api/v1/models?output_modalities=all`, cached 6 hours. |
| Benchmarks | Intelligence, Coding, Agentic: the `benchmarks` field of the OpenRouter model list (data from Artificial Analysis). Speed and time to first token: Artificial Analysis API with `AA_API_KEY`, cached 24 hours. |
| Availability | OpenRouter `/models/user` with your key and the endpoints API (both free). Test calls only when you click the button of one model. |
| Your usage per model | The local proxy log. |

## Privacy

- The server listens only on the loopback addresses `127.0.0.1` and `::1`. Other computers cannot connect.
- The proxy does not save prompts or answers. It saves only model, token counts, cost, latency and time.
- The proxy does not save your API key.
- A test call sends only the text "Reply with OK." to the model, with the key from `.env`.
- The extension saves your email in Chrome's sync storage (`chrome.storage.sync`). If Chrome sync is on, Chrome syncs it with your Google account, like other extension settings.
- The extension sends your email only to the Turing College usage tracker (function `lookup-learner`). It does not send your email to the cockpit.
- `.env` (your keys) and `data/` (your usage log and synced Turing data) are in `.gitignore`. Do not commit them.

## Development

```bash
npm run dev        # server with reload on :8787, UI with hot reload on :5173
npm test           # server and extension tests
npm run typecheck
```

## Problems

| Problem | Fix |
| --- | --- |
| `node:sqlite` not found | Install Node.js 22.13 or newer. |
| Popup: "The cockpit is not reachable" | Start the server (`npm run serve`). Check the address in the popup. |
| Popup: "Turing College does not know this email" | Use the email that you use on the Turing usage tracker. |
| Popup: "Could not find the Supabase settings" | The Turing site changed. The file `extension/sync.js` reads the settings. |
| A benchmark cell is empty | OpenRouter has no score for this model. For speed and time to first token, add `AA_API_KEY` to `.env` and restart. |
| No test call button, or "Not for your key" never shows | Add `OPENROUTER_API_KEY` to `.env` and restart. |
| A model is greyed out, but it works for you | Hover over the info icon in the Status column to see the check result. Run a test call for this row. |

## Changes (25 September 2026)

Fixes after a full test (server, proxy, UI and extension with mocked OpenRouter and Turing services):

| Problem | Fix |
| --- | --- |
| Any web site that you opened could send calls through the proxy with the key from `.env` (a simple `text/plain` POST needs no CORS check), or overwrite the synced Turing data. | The server refuses `/api/*` requests with an `Origin` from another site (403). Python, curl, LangChain and the extension still work. |
| The proxy answered 502 for large requests from clients that send `Expect: 100-continue` (curl does this above 1 MB). | The proxy removes `Expect` and other hop-by-hop headers. It also does not send local cookies, `Origin` and `Referer` to OpenRouter. |
| On Windows, `localhost` resolves to `::1` first. The server listened only on `127.0.0.1`, so Python clients waited about 2 s for each new connection. | The server also listens on `::1` (still only this computer). |
| A second `npm start` crashed with a long `EADDRINUSE` stack trace. | Clear message: the port is in use. |
| The usage of a `:batch` model was counted twice when the base model was also in the list. | Each logged model counts under one catalog row only. |
| Compare drawer: the last rows (My spend, My calls) were hidden in a small nested scroll area. | The table keeps its full height. The drawer scrolls. |
| Usage chart: the Y axis showed the same label twice (for example `$1`, `$1`). | Two decimals below $10. |
| The 7-day chart filter used the UTC date. The server groups by local date. | Both use the local date. |
| The page scrolled sideways on narrow screens. | The header hides the title text below 520 px. |
| `POST /api/benchmarks/override` with a bad body gave 500. | 400 with a clear message. |
| A hanging OpenRouter or Artificial Analysis request could block the catalog. | 20 s time limit. The cockpit uses cached data after a failure. |

The server code is now in `server/app.ts` (the app) and `server/index.ts` (start). The tests cover the new fixes (`npm test`).

## Changes (25 September 2026, second round)

| Request | Change |
| --- | --- |
| Do not grey out advanced models; keep the tier distinction | Tiers add up (basic ⊂ advanced). The tier column stays. Only models that do not work are greyed out. |
| "Ping" the models | New Status column and **Check availability**: free OpenRouter check (automatic), key model list, and optional test calls. Views **Available models** and **All Turing models**. |
| Benchmarks are empty | Cause: `AA_API_KEY` was empty in `.env`. The UI now says this in each benchmark tooltip, and shows API errors below the table. New Agentic column. Info icons with the source of each score. |
| `claude-3.5-haiku` | It is retired on OpenRouter (page exists, 0 providers). The cockpit now reads the endpoints API and shows "Retired" with name and description. |
| New and changed Turing names | Name matching with other word order and separators, more provider aliases, endpoints API fallback, manual links, "new" labels, and a test with the real lists. |

## Changes (26 September 2026)

| Request | Change |
| --- | --- |
| "Test all" cost $0.77 | Removed. Replaced by the free key model list (`/models/user`), which shows the guardrails of the Turing key. Checked with the real key: 44 of 59 Turing slugs are allowed. Test calls now run only for one model, with reasoning off where possible and a cost confirmation. |
| Test result should vanish | The result shows for 3 seconds, then the provider label comes back. The tooltip keeps the last result. |
| Provider details | Click the provider label: all providers with metrics and a copy button for the provider slug. |
| Also | Benchmark indexes without `AA_API_KEY` (from the OpenRouter model list). "retires <date>" label when OpenRouter plans to remove a model. `claude-3-haiku` is now retired on OpenRouter too (0 providers on 26 September 2026). |

## Changes (26 September 2026, NVIDIA)

| Request | Change |
| --- | --- |
| Integrate the free NVIDIA models | New **NVIDIA free** tab (only with `NVIDIA_API_KEY`): the "Free Endpoint" chat and embedding models, a green NVIDIA label on each row, a banner with the base URL and a Python example. Proxy at `/api/nvidia/v1` with the key from `.env`. |
| Show where the free models come from | "free · NVIDIA" label (links to the model page on build.nvidia.com), "NVIDIA free" in the tier column, "Free on NVIDIA" line on matching Turing models, "NVIDIA" label in the Usage tab. |
