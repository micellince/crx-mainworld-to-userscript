# crx-mainworld-to-userscript (`crx2user`)

**English** | [简体中文](#简体中文说明)

Zero-dependency CLI & Node.js library that converts **Manifest V3 Chrome Extensions** built around the **Page-World (`MAIN` world) + Background CORS bridge** architecture into standalone **Tampermonkey / Violentmonkey userscripts (`.user.js`)**, with a **generic 4-stage sandbox verifier**.

It is a **general-purpose converter**: nothing about the target extension's message protocol, asset names or brand is hardcoded. Any MV3 extension that follows the page-world + background-fetch architecture can be converted.

---

## Why this exists

Many advanced extensions use a two-world architecture:

1. **Page-World (`MAIN` world) runtime** — runs inside the page's real `window` so it can hook native prototypes and read in-memory state.
2. **Background service worker CORS bridge** — receives messages from the page (usually via a content script that bridges `window.postMessage` ↔ `chrome.runtime.sendMessage`) and performs cross-origin `fetch()` calls that page CSP/CORS would block.

Generic userscript converters either wrap everything in one sandbox (breaking page-world hooks) or assume a single content script / message protocol. `crx2user` instead:

- **Keeps the extension as the single source of truth** — `background.js`, content scripts, page-world scripts and CSS are reused byte-for-byte.
- **Runs the extension's own content scripts as the bridge** — no hardcoded channel names. Page-world ↔ content-script ↔ background messaging keeps working exactly as designed.
- **Gates every script with its original Chrome match patterns** — multiple content-script groups, `world: MAIN` scripts and web-accessible page scripts only execute on the pages they were declared for.
- **Verifies the result** with a manifest-derived 4-stage test suite instead of trusting the transformation.

---

## Supported MV3 surface

| Area | Support |
| --- | --- |
| `background.service_worker` | Classic workers, including recursive **static `importScripts()`** inlined at their call sites (worker statement order preserved) |
| `content_scripts` | Multiple entries with independent `matches`, `exclude_matches`, `include_globs`, `exclude_globs`, `run_at`, `css`, `world: "MAIN"`, `all_frames`; each entry's `run_at` is honored at runtime, while the earliest one drives `@run-at` |
| Frame behavior | Emits `@noframes` unless a content script uses `all_frames: true` |
| `web_accessible_resources` | CSS / JS / binary assets, glob patterns (`assets/*.png`), per-entry `matches`; unknown assets are still reachable through a `chrome.runtime.getURL()` map |
| Metadata | `name`, `short_name`, `version`, `description`, `homepage_url`, icons → `@name`/`@version`/`@icon`; icon fallback to `action.default_icon` |
| Cross-origin | `host_permissions`, `optional_host_permissions` and host-like `permissions` → `@connect` (wildcards, ports and `<all_urls>` normalized) |
| `chrome.*` shims | `runtime.{id,getManifest,getURL,lastError,onMessage,sendMessage,onConnect,connect,onInstalled,onStartup,onSuspend,getPlatformInfo}`, `storage.{local,sync,session,onChanged}`, `alarms`, `action`, `notifications`, `contextMenus`, `tabs` / `scripting` stubs, minimal `i18n` |
| Networking | Background `fetch()` is transparently backed by `GM_xmlhttpRequest` / `GM.xmlHttpRequest` (headers, `AbortController`, timeout), with a native-`fetch` fallback |
| Page-world injection | `<script>` DOM injection, with a CSP probe and `unsafeWindow.eval` fallback |
| Styling | Content-script CSS + web-accessible CSS injected with `GM_addStyle`, `<style>` fallback |

---

## How the converted userscript is organized

```text
GM userscript sandbox                              page world
├─ background.js (+ inlined importScripts)         └─ web_accessible_resources JS
│    └─ fetch() → GM_xmlhttpRequest                      + content_scripts with world: "MAIN"
├─ original content scripts  ←── postMessage ──────  page scripts
├─ chrome.* shims (runtime / storage / getURL)
└─ CSS via GM_addStyle
```

Every section is guarded by the original Chrome match patterns (`hrefMatches(...)`), so a userscript running on several origins behaves like the original multi-entry extension.

The generated file also contains a `// __CRX2USER_AUDIT_JSON__` line with the generator version and the SHA-256 of every embedded payload, which the verifier uses for byte-level parity checks.

---

## Quick start

```bash
# Convert an unpacked MV3 extension and run the verifier
node src/cli.mjs convert ./path/to/unpacked-extension -o dist/my-extension.user.js --verify

# Same, using the --input alias
node src/cli.mjs convert --input ./path/to/unpacked-extension -o dist/my-extension.user.js

# Verify an existing userscript against its source extension
node src/cli.mjs verify dist/my-extension.user.js --source ./path/to/unpacked-extension

# Run the test suite (Node.js 20.11+ recommended)
npm test

# Self-contained bundle from the bundled generic fixture
npm run convert:fixture
```

CLI options: `-i/--input`, `-o/--output`, `-s/--source`, `--match <pattern>` (repeatable), `--url <url>` (page URL used by the sandbox test), `--name`, `--namespace`, `--update-url`, `--download-url`, `--verify`, `--no-verify`, `--json`, `-h/--help`.

### Programmatic API

```js
import {
  convertExtensionToUserscript,
  convertAndVerify,
  verifyUserscript
} from 'crx-mainworld-to-userscript';

// Convert + verify (throws if verification fails)
const { bundle, compiled, verification, warnings } = await convertAndVerify(
  './unpacked-extension',
  {
    outputPath: './dist/my-extension.user.js',
    url: 'https://app.example.com/dashboard', // optional sandbox page URL
    updateUrl: 'https://example.com/releases/my-extension.user.js'
  }
);

// Verify an existing artifact
const report = await verifyUserscript('./dist/my-extension.user.js', {
  sourceDir: './unpacked-extension'
});
```

Options: `outputPath`, `verify` (default `true`), `url`, `matches`, `name`, `namespace`, `updateUrl`, `downloadUrl`, `includeIcon`, `noframes`.

---

## The 4-stage verifier

| Stage | Check | What it proves |
| --- | --- | --- |
| 1 | `metadata_contract` | `@version`, `@match`, `@connect`, `@run-at` and required `@grant`s match the manifest |
| 2 | `payload_sha256_parity` | The embedded payload block is extracted from the artifact and every payload is re-hashed — declared hashes are never trusted — then matched against a fresh conversion of the source extension |
| 3 | `vm_syntax_compile` | The complete `.user.js` compiles with `node:vm` (`new Script`) — no syntax or escaping corruption |
| 4 | `sandbox_e2e_smoke_test` | Boots the generated userscript in a generic browser + Tampermonkey sandbox: boot marker, `GM_addStyle` CSS injection, content scripts, page scripts, `getURL` mapping, background startup and a runtime message-bus probe. Expected script sets are derived from the match patterns and can be checked against any page URL via `--url` |

Stage 4 is deliberately protocol-agnostic: it does **not** know your message names or DOM markers. It verifies the conversion pipeline and runtime plumbing; application behavior remains covered by the byte-level hash parity and by the extension's own tests.

---

## Security notes

- **Verification executes extension code.** Stage 4 boots the background worker, content scripts and page scripts inside a Node.js `node:vm` sandbox. `node:vm` is **not** a security boundary — only run `convert --verify` / `verify` on extensions you trust, or pass `--no-verify`.
- **Path containment:** manifest-referenced files are resolved with `realpath()`; symlinks that escape the unpacked extension directory are rejected, and symlinks encountered while expanding `web_accessible_resources` globs are skipped.
- **Payload integrity:** the verifier re-computes SHA-256 for every embedded payload and requires it to match a fresh conversion of the source extension (it never trusts declared hashes alone).
- **Storage isolation:** when the extension uses `chrome.storage`, the userscript requests `GM_getValue` / `GM_setValue` and namespaces keys per extension, so page scripts cannot read them. Without GM storage a namespaced `localStorage` fallback is used, which page scripts *can* read — avoid storing secrets in that case.
- **Header injection:** manifest values are sanitized before being written into the userscript metadata block.

## Known limitations

- **ES module service workers** (`background.type: "module"`) are not supported yet — bundle the worker into a classic script first (e.g. `esbuild --format=iife`). The parser raises an actionable error.
- **Dynamic `importScripts()`** (non-literal URLs) cannot be inlined. Conversion reports a warning; the runtime throws if such a call executes.
- **Static imports that are not standalone statements** (`const x = importScripts('a.js')`, conditional calls) cannot be spliced in place; they fall back to a top-level inline and the conversion warns about the ordering caveat.
- **Page-world injection** prefers inline `<script>` injection. On pages with a strict CSP the converter falls back to `unsafeWindow.eval`; environments blocking both may need manual handling.
- The sandbox shims only cover the `chrome.*` surface listed above. `tabs` and `scripting` are stubs (tab creation is approximated with `window.open`; `scripting.executeScript` rejects); `declarativeNetRequest`, `webRequest`, `devtools`, `sidePanel` etc. are not emulated.
- `chrome.storage` prefers GM storage (isolated), falls back to namespaced `localStorage`, and keeps `session` in memory; `chrome.i18n.getMessage` returns the message key.
- Files inside one `content_scripts` entry share top-level globals (as in Chrome); different content-script *entries* run in separate scopes, which differs from Chrome's single isolated world per frame.
- All web-accessible JS resources are assumed to be page-world scripts and are injected (with a warning for resources not referenced by any content script).
- The sandbox verifier is an approximation of a real browser, not a substitute for loading the userscript in a browser.

---

## License

MIT

---

## 简体中文说明

`crx-mainworld-to-userscript`（`crx2user`）是一个**零依赖、通用**的 Chrome MV3 扩展 → 油猴脚本（`.user.js`）转换器，专为「网页主环境 (`Page World` / `MAIN` world) + 后台 Service Worker 跨域桥」架构的扩展设计。它不是针对某一个插件的专用工具，不写死任何消息协议、资源名或品牌。

### 通用能力

- **后台脚本原样复用**：支持 `background.service_worker` 及递归静态 `importScripts()`（相对路径、嵌套导入，按调用位置内联以保持执行顺序）；后台里的 `fetch()` 自动改为经 `GM_xmlhttpRequest` 跨域。
- **多组 content_scripts**：每组保留自己的 `matches` / `exclude_matches` / `include_globs` / `exclude_globs` / `run_at` / `world` / `all_frames` / CSS；`world: "MAIN"` 自动进页面主环境；脚本只在声明的页面上执行，`run_at` 按组在运行时生效（`@run-at` 取最早值）。
- **原始 content script 即消息桥**：不写死 `postMessage` 通道名，页面主环境 ↔ content script ↔ 后台的通信保持原样。
- **web_accessible_resources**：CSS、JS、图片等二进制资源，支持 glob 模式；`chrome.runtime.getURL()` 返回虚拟 URL 或 data URL。
- **元数据与网络**：图标、`host_permissions` / `optional_host_permissions` 自动转 `@connect`，`<all_urls>`、通配域名、端口统一规范化。
- **chrome.* 垫片**：`runtime`（消息、端口、getManifest、getURL 等）、`storage`（local/sync/session）、`alarms`、`action`、`notifications`、`contextMenus`，以及 `tabs` / `scripting` 的降级桩。
- **通用 4 阶段验证**：元数据契约、内嵌载荷逐字节 SHA-256 重算（不信任声明哈希，并与源扩展重新转换的结果对比）、VM 语法编译、隔离沙箱启动测试；沙箱断言完全由 manifest 推导，与具体插件无关。

### 常用命令

```bash
# 转换 + 验证（源目录既可位置传参，也可用 --input）
node src/cli.mjs convert ./unpacked-extension -o dist/my-extension.user.js --verify
node src/cli.mjs convert --input ./unpacked-extension -o dist/my-extension.user.js

# 校验已有 .user.js
node src/cli.mjs verify dist/my-extension.user.js --source ./unpacked-extension

# 运行测试（21 项）与自包含示例
npm test
npm run convert:fixture
```

### 安全说明

- **验证过程会执行扩展代码**：第 4 阶段在 Node `node:vm` 沙箱中启动后台、content scripts 和页面脚本。`node:vm` 不是安全边界——只对信任的扩展运行 `convert --verify` / `verify`，或使用 `--no-verify`。
- **路径约束**：manifest 引用文件都会经过 `realpath()` 校验；指向扩展目录之外的符号链接会被拒绝，`web_accessible_resources` 通配展开时遇到的符号链接会被跳过。
- **载荷完整性**：验证器会提取内嵌载荷并重新计算 SHA-256，再与源扩展的重新转换结果比对，不信任声明的哈希。
- **存储隔离**：扩展使用 `chrome.storage` 时，脚本会申请 `GM_getValue` / `GM_setValue` 并按扩展名命名空间隔离，页面脚本读不到；没有 GM 存储时回退到带命名空间的 `localStorage`（页面可读，不要存敏感信息）。
- **头部注入防护**：manifest 字段写入油猴头前会做清洗。

### 已知限制

- 暂不支持 ESM service worker（`background.type: "module"`），请先用 esbuild 等打包成经典脚本。
- 动态 `importScripts()`（非字面量 URL）无法内联，转换时告警、运行时抛错；非独立语句位置的静态导入（如赋值、条件调用）只能回退为顶层内联，转换时会告警顺序风险。
- 页面主环境注入优先使用内联 `<script>`，严格 CSP 页面会回退到 `unsafeWindow.eval`；两者都被禁止时需手工处理。
- 仅模拟上表列出的 `chrome.*` API；`tabs` / `scripting` 只是降级桩，`declarativeNetRequest` / `webRequest` / `devtools` / `sidePanel` 等不支持。
- `chrome.storage` 优先用 GM 存储（与页面隔离），否则回退到命名空间 `localStorage`，`session` 仅内存；`chrome.i18n.getMessage` 返回 key。
- 同一 content_scripts 条目内的多个文件共享顶层全局变量；不同条目之间是独立作用域（Chrome 同一 frame 共用一个 isolated world，这里不同）。
- 所有 web_accessible_resources 中的 JS 都会按“页面主环境脚本”注入；未被任何 content script 引用的资源会给出告警。
- 沙箱验证是近似环境，不能替代真实浏览器加载测试。

### 许可证

MIT
