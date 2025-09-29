## PDP Rewriter

An MV3 browser extension that detects PDPs (Product Detail Pages) with a pluggable strategy (WebLLM in-page, backend LLM, or fast heuristics), proposes improved copy for key fields, and auto-applies safe DOM edits with revert/re-apply support. A lightweight Vercel Edge proxy provides OpenAI-backed analysis and copy generation.

### Features
- **PDP detection**: Decide if current page is a merchant PDP.
- **Field extraction**: Title, description, shipping, returns.
- **Rewrite proposals**: Safe, minimal-HTML copy with constraints.
- **Auto-apply**: Patch DOM with an audit summary; revert/re-apply from popup.
- **Strategies**: `webllmStrategy` (local WebGPU), `llmStrategy` (backend), `heuristicsStrategy` (fast local).
- **Whitelist + per-domain strategy overrides**: Configure from Options.

### Monorepo Layout
- `packages/extension/`: MV3 extension (background service worker, content script, popup, options, strategies)
- `packages/proxy-vercel/`: Vercel Edge API for `analyze` and `generate`

### How It Works
1) `content/content.js` sanitizes the current DOM into a reduced HTML excerpt + metadata; asks background to resolve a plan.
2) `background.js` picks a strategy per domain/global setting and resolves a plan:
   - `webllmStrategy`: Runs WebLLM in the page (WebGPU). Fallbacks to backend on error.
   - `llmStrategy`: Calls the Vercel `analyze` endpoint (OpenAI backed) to return a plan.
   - `heuristicsStrategy`: Fast local signal scoring + selector discovery.
3) If `plan.is_pdp` is true, background applies `plan.patch` in-page via `page/applyPatchInPage.js` and caches an apply summary.
4) `popup/` shows diffs (previous vs current), applied steps, and provides Revert/Re-apply.

Selectors and content are validated to avoid script injection; patch operations are restricted to `setText` (title) and `setHTML` (others), with a denylist and automatic value prefixing (`[PDP]`) unless explicitly suppressed by internal flows.

### Strategies
- `webllmStrategy`: Executes a strict prompt client-side using WebLLM. Requires WebGPU and a WebLLM runtime available in the page context. The repo includes a vendored build at `packages/extension/vendor/webllm.min.js`, but it’s not injected by default; the strategy attempts to use existing globals (`window.WebLLM`/`window.webllm`) and falls back to backend if unavailable.
- `llmStrategy`: Calls the Edge API `POST /api/analyze` which uses OpenAI to return a strict JSON plan.
- `heuristicsStrategy`: Fast PDP signal scoring and best-effort selector discovery; returns a schema-compatible plan with empty patches.

### Options
Open the extension’s Options page:
- **Whitelist**: If empty, extension runs on all sites; otherwise restrict by host patterns (supports wildcards like `*.shopify.com`).
- **Global Strategy**: Choose default strategy.
- **Per-domain Overrides**: Map host pattern → specific strategy.

### Development
Prereqs:
- Node 18+ (or 20+), npm
- macOS for Safari tooling (optional)

Install:

```bash
npm install
```

Run the Edge proxy locally (optional; otherwise use a deployed URL):

```bash
# In another terminal, with Vercel CLI installed and OPENAI env configured
npm -w packages/proxy-vercel run dev
```

Environment for proxy (Vercel):
- `OPENAI_API_KEY` (required)
- `OPENAI_MODEL` (default: `gpt-4.1`)
- `OPENAI_BASE_URL` (optional; default OpenAI API)

Update the extension background endpoints if you deploy the proxy:
- In `packages/extension/background.js` set `PROXY_URL` and `PROXY_GENERATE_URL` to your deployment.

Load the extension in Chrome:
1) Open chrome://extensions
2) Enable Developer mode
3) Load unpacked → select `packages/extension`

Popup shows status for the active tab. The badge cycles: `…` (working), `PDP` (detected), `AP` (applying), `ERR` (error).

### Deploy the Proxy (Vercel)
1) `cd packages/proxy-vercel`
2) `vercel` (or GitHub → Vercel integration)
3) Add env vars in Vercel Project Settings → Environment Variables
4) Note the deployment URL and update the extension background constants.

### Manual Packaging
- Chrome: zip the contents of `packages/extension` and upload to the Chrome Web Store dashboard.
- Safari: generate an Xcode project using Apple’s converter, then build/sign in Xcode.

Chrome (local):

```bash
cd packages/extension
zip -r ../pdp-rewriter-chrome.zip . -x "**/node_modules/**" "**/.DS_Store"
```

Safari (local):

```bash
# Requires Xcode 13+ on macOS
xcrun safari-web-extension-converter "$(pwd)/packages/extension" \
  --app-name "PDP Rewriter" \
  --project-location "$(pwd)/build-safari" \
  --copy-resources --no-open --force --macos-only
```

This produces an Xcode project under `build-safari/` you can open and sign.

### GitHub Releases (CI)
On tag pushes like `v0.1.0`, CI can:
- Package a Chrome zip
- Generate a Safari Xcode project directory
- Attach both as release assets

See `.github/workflows/release.yml` in this repo. You can also run those steps locally.

### Safety & Limitations
- DOM patching is restricted and sanitized; selectors targeting meta/script/link tags are excluded.
- WebLLM requires WebGPU-capable browsers/devices; it gracefully falls back to backend.
- The Safari converter only generates a project; you must sign/build in Xcode to distribute.

### License
MIT
