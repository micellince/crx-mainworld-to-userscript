# crx-mainworld-to-userscript (`crx2user`)

**English** | [简体中文](#简体中文说明)

Zero-dependency CLI & Node.js toolkit to convert **Manifest V3 Chrome Extensions** that use the **Page-World (`MAIN` world) + Background CORS Bridge** architecture into standalone **Tampermonkey / Violentmonkey Userscripts (`.user.js`)**, complete with an **automated 4-stage sandbox E2E verifier**.

---

## Why This Project Exists

Many advanced browser extensions (such as gaming companions, market terminals, TradingView overlays, and SPA enhancers) rely on a two-world architecture:
1. **Page-World (`MAIN` World) Runtime**: Runs directly inside the page's real `window` context so it can hook native application prototypes and read in-memory state (`window.services`, `window.repositories`, etc.).
2. **Background Service Worker CORS Bridge**: Receives messages from the page (`window.postMessage` → `chrome.runtime.sendMessage` → `background.js`) to perform cross-origin `fetch()` requests that the host page's CORS or CSP rules would block.

Existing generic converters either:
- Wrap everything in a single isolated closure where `window` is a Tampermonkey proxy (breaking prototype hooks and page-world globals), or
- Explicitly disallow combining `MAIN` world page scripts with privileged `GM_xmlhttpRequest` cross-origin routing, and
- Provide **zero automated verification** that the converted `.user.js` actually boots and routes cross-origin messages properly.

`crx-mainworld-to-userscript` solves this cleanly:
- **Zero Dual-Maintenance**: Keep your MV3 Chrome Extension as your single source of truth. Convert any built extension directory into a `.user.js` in `< 1 second`.
- **Dual-World Bridge Architecture**:
  - Runs your unmodified `background.js` inside the Userscript sandbox with `fetch()` seamlessly backed by `GM_xmlhttpRequest` / `GM.xmlHttpRequest` (supporting `AbortController`, timeouts, and rate-limit queues).
  - Injects your `assets/*.css` via `GM_addStyle` / `<style>`.
  - Injects your `js/main.js` into the real Page World (`<script>` DOM injection with automatic CSP-safe `unsafeWindow` fallback) and bridges `window.postMessage` directly to the in-sandbox `background.js`.
- **Built-in 4-Stage Automated Verifier**:
  1. **`metadata_contract`**: Verifies `@version`, `@match`, `@connect` (auto-extracted from `host_permissions`), and `@grant` parity against `manifest.json`.
  2. **`payload_sha256_parity`**: Verifies byte-for-byte SHA-256 hash parity for all embedded CSS, background, and page-world scripts.
  3. **`vm_syntax_compile`**: Compiles the generated `.user.js` via `node:vm` `Script` to guarantee zero syntax or escaping corruption.
  4. **`sandbox_e2e_smoke_test`**: Boots the compiled `.user.js` in a simulated browser + `GM_xmlhttpRequest` sandbox, verifies DOM CSS mounting and Page-World boot flags, and executes live `window.postMessage` → `GM_xmlhttpRequest` → `window.postMessage` round-trips.

---

## Quick Start

```bash
# 1. Convert an unpacked MV3 extension directory and run automated E2E verification
node src/cli.mjs convert ./path/to/unpacked-extension \
  -o ./dist/my-extension.user.js \
  --update-url https://example.com/releases/my-extension.user.js \
  --download-url https://example.com/releases/my-extension.user.js \
  --verify

# 2. Verify an existing .user.js against its source MV3 extension directory
node src/cli.mjs verify ./dist/my-extension.user.js --source ./path/to/unpacked-extension

# 3. Run unit & E2E verification tests
npm test
```

---

## 简体中文说明

`crx-mainworld-to-userscript` (`crx2user`) 是一个零依赖的 **Chrome MV3 扩展 → 油猴脚本 (Tampermonkey / Violentmonkey `.user.js`) 一键转换与自动化验证工具**，专为采用「**网页主环境 (`Page World`) + 后台跨域桥 (`Background CORS Bridge`)**」架构的复杂扩展打造。

### 核心特性

1. **单一代码源、零双端维护成本**：
   - 直接读取构建好的 Chrome MV3 扩展目录（如 `backups/v0.16.5/fc27-enhancer-ext`），无需修改一行核心业务代码（`js/main.js`、`background.js`、`assets/index.css` 100% 原样复用）。
   - 自动解析 `manifest.json` 提取版本号、`@match` 匹配规则、将 `host_permissions` 自动转换为油猴 `@connect` 跨域白名单，并将扩展图标自动编码为 Base64 `@icon`。
2. **双沙箱无损桥接架构**：
   - **特权沙箱层 (`GM Sandbox`)**：在油猴沙箱内提供 `gmFetch`（底层调用 `GM_xmlhttpRequest` / `GM.xmlHttpRequest`，完整支持 `AbortController` 超时信号与并发队列）和轻量级 `chrome.runtime.onMessage / sendMessage` 总线，直接运行原版 `background.js`。
   - **页面主环境层 (`Page World`)**：通过 `<script>` 节点注入（附带防 CSP 拦截的 `unsafeWindow` 自动回退）在真实网页 `window` 环境中运行 `js/main.js`，并通过 `window.postMessage` 与油猴沙箱无缝通信。
3. **内置 4 步自动化验证 (`Verifier`)**：
   - **`metadata_contract`**：校验油猴头部的 `@version`、`@match`、`@connect`、`@grant` 是否与 `manifest.json` 100% 对齐；
   - **`payload_sha256_parity`**：逐字节比对内嵌的 `assets/index.css`、`background.js`、`js/main.js` 的 SHA-256 哈希值；
   - **`vm_syntax_compile`**：使用 Node `vm.Script` 对生成的单文件 `.user.js` 进行完整语法编译检查；
   - **`sandbox_e2e_smoke_test`**：在隔离沙箱中模拟浏览器 DOM 与 `GM_xmlhttpRequest`，真实执行生成的 `.user.js`，并发起模拟行情请求验证 `postMessage` → `background` → `GM_xmlhttpRequest` → `postMessage` 全链路闭环。

### 常用命令

```bash
# 一键将 v0.16.5 成品扩展转换为油猴脚本并执行全套自动化验证
npm run build:futmarket

# 单独验证已生成的油猴脚本
npm run verify:futmarket

# 运行自动化测试套件
npm test
```

## License

MIT
