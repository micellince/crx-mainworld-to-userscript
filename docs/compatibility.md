# Chrome Extension vs Userscript: compatibility and permanent limits

`crx-to-userscript` converts a Chrome Manifest V3 extension into a Tampermonkey / Violentmonkey userscript.
"One-click conversion" and "dual release" are realistic **for the extension's page-world + background-bridge architecture** — but they are not universal. This document is the honest feature matrix.

**Legend**

| | Meaning |
| --- | --- |
| ✅ | Portable as-is: the converter reproduces the architecture. |
| 🟡 | Portable with a rewrite or degraded semantics: something must change in the product. |
| ❌ | **Impossible on the userscript platform.** No amount of conversion work can fix it — the browser / userscript manager simply does not expose the capability. |

---

## 1. ✅ Portable as-is

- Page-world (`MAIN` world) script injection and page ↔ sandbox messaging.
- Content scripts as an isolated bridge (`window.postMessage` ↔ background).
- Background worker logic executed inside the userscript sandbox.
- Cross-origin HTTP via `GM_xmlhttpRequest` / `GM.xmlHttpRequest` (`@connect` whitelist).
- CSS injection via `GM_addStyle`.
- `chrome.runtime` messaging: `onMessage` / `sendMessage` / ports (`connect` / `onConnect`).
- `chrome.storage.local/sync/session` (GM-storage backed, per-extension namespace, session in memory).
- Manifest metadata → userscript metadata: name/version/description/icon/`@match`/`@connect`/`@run-at`.
- Multiple `content_scripts` entries, per-entry matches, `exclude_matches`, `include_globs`, `exclude_globs`, `run_at`, `world: "MAIN"`, `all_frames`.
- Web-accessible CSS/JS/binary assets (served through a `getURL()` map).
- Polling-based data fetching while a matching page is open.

## 2. 🟡 Portable with a rewrite (behavior differs)

| Feature | Extension | Userscript reality | Recommended action |
| --- | --- | --- | --- |
| `chrome.alarms` | Wakes the service worker in the background | Timers only while a matching page is open (`setTimeout` approximation) | Move scheduled work to a backend; keep page-local refresh only |
| `chrome.tabs.create` | Open a tab and script into it | Can open a tab (`GM_openInTab` / `window.open`) but **cannot read or inject into it** | Replace scraping with direct HTTP + HTML parsing |
| `chrome.scripting.executeScript` | Read/inject any permitted tab | No equivalent | Direct HTTP + parse; impossible if the page needs JS rendering or user interaction |
| `chrome.action` (toolbar button/popup/badge) | Browser toolbar UI | No toolbar UI | Inject an in-page panel or use the userscript-manager menu |
| `chrome.contextMenus` | Native browser context menu | Userscript-manager menu only | `GM_registerMenuCommand` + in-page UI |
| `chrome.notifications` | OS-level notifications | `GM_notification` where the manager supports it | Feature-detect; degrade silently |
| `chrome.downloads` | Manage download items | Plain download (`GM_download` / anchor) | Do not rely on download-item state |
| `chrome.storage.sync` / `managed` | Cross-device / policy-backed | GM storage; sync depends on the manager | Sync through your backend if needed |
| Extension options page / popup | Separate `chrome-extension://` page | None | Settings UI injected into the page, or manager menu |
| Install/update lifecycle (`onInstalled`, `onStartup`) | Exact extension lifecycle events | Only fire when a matching page opens (best effort), updates controlled by the manager | Treat as best effort; never rely on migration events |
| Extension-ID website handshake (`externally_connectable`) | Website calls the extension by ID | No extension ID; page cannot address the userscript | Switch the website to a DOM-attribute + `postMessage` handshake |
| Isolated-world exactness | Per-extension isolated world | Manager sandbox semantics differ | Do not rely on strict isolation from page scripts |
| Content script globals across entries | Shared isolated world per frame | Same-entry files share globals; different entries do not | Keep related logic in one entry |

## 3. ❌ Never convertible (permanent userscript-platform limits)

These are the capabilities that **remain impossible forever**, not "not implemented yet". A dual-release strategy must accept that the userscript build either drops these features, moves them to the backend, or ships extension-only.

1. **Persistent background execution / service worker.**
   A userscript only runs while a matching page is open. There is no service worker, no browser-idle execution, no cross-tab coordinator, no wake-up on events.
   *Consequence:* 24/7 collectors, scheduled sync, background pollers, cross-tab state are impossible. Move them to your server or a companion app.

2. **Tab / window control and cross-tab scripting.**
   `chrome.tabs`, `chrome.windows`, `chrome.scripting`, `chrome.debugger`, `chrome.tabGroups`, `chrome.webNavigation`, `chrome.sessions`.
   *Consequence:* cannot open a hidden tab, read/inject another tab's DOM, automate another website, or scrape pages that require JavaScript execution. Only direct HTTP requests are possible.

3. **Network interception and browser-level request control.**
   `chrome.webRequest` (blocking/modify headers), `declarativeNetRequest`, `proxy`, `privacy`, `contentSettings`, `certificateProvider`.
   *Consequence:* cannot block/rewrite requests, add headers to page traffic, strip CSP, or change proxy settings. A userscript can only send its own requests via `GM_xmlhttpRequest`.

4. **Browser data and identity APIs.**
   `chrome.cookies`, `chrome.identity` (OAuth web-auth flow), `chrome.history`, `chrome.bookmarks`, `chrome.downloads` item control, `chrome.management`, `chrome.permissions`, `chrome.topSites`, `chrome.readingList`, `chrome.fontSettings`, `chrome.tts`.
   *Consequence:* no programmatic cookie access, no browser-history/bookmark access, no extension-managed OAuth; authenticate with tokens/logins instead.

5. **Extension origin, extension ID, extension pages, `externally_connectable`.**
   There is no `chrome-extension://` origin for a userscript and no extension ID. No popup/options/side-panel/devtools pages, no `chrome-extension://` `web_accessible_resources` origin, and websites cannot `chrome.runtime.sendMessage(extensionId, …)` to it.
   *Consequence:* websites cannot detect/allowlist the userscript as an extension; handshakes must use DOM attributes + `postMessage`; no separate trusted origin for secrets.

6. **OS / native integration.**
   Native messaging (`connectNative` / `sendNativeMessage`), USB/serial/Bluetooth/HID/raw sockets, filesystem providers, printing, enterprise APIs, platform keys.
   *Consequence:* hardware, native-app and enterprise features stay extension-only.

7. **Browser UI and global keyboard integration parity.**
   Toolbar action button/popup, extension keyboard commands, native context menus.
   *Consequence:* UX must live inside the page or in the userscript-manager menu; no global shortcuts.

8. **Guaranteed isolated-world and CSP privileges.**
   Extensions can inject resources under a separate origin and have stronger guarantees on strict-CSP pages. A userscript depends on the manager's sandbox and the page CSP; inline page-world injection can be blocked.
   *Consequence:* strict-CSP sites may require `unsafeWindow.eval` fallbacks; perfect parity is not guaranteed.

9. **Managed install/update, code signing and lifecycle guarantees.**
   Enterprise force-install, managed storage/policies, Web Store auto-update, immutable signed packages, reliable `onInstalled` migrations.
   *Consequence:* managed/enterprise distribution is extension-only; a userscript is editable plain text and its update timing belongs to the userscript manager.

10. **Runtime expansion to arbitrary origins.**
    Extensions with host permissions can inject on demand. A userscript can only run on `@match` patterns declared (and approved) at install/update time.
    *Consequence:* no dynamic host coverage; adding origins requires a script update and user approval.

11. **Secret storage.**
    Userscript source is world-readable and `GM_setValue` data is not protected against the user's own tooling. API keys cannot be hidden in a userscript.
    *Consequence:* never embed secrets; use per-user tokens and server-side rate limiting.

## 4. What the converter does about these limits

- **Detects** uses of permanently unavailable and degraded browser APIs and emits explicit conversion warnings (`bundle.browserApis`, printed by the CLI and included in `--json`).
- **Stubs** common MV3 APIs (`alarms`, `tabs`, `scripting`, `action`, `notifications`, `contextMenus`) so the background boots instead of crashing — but it does **not** pretend they work.
- **Verifies structure, not semantics:** all four verifier stages prove metadata/payload/syntax/boot integrity. They cannot prove that an extension-only feature works in a browser.
- **Dual-release guidance:** feature-flag unsupported features off in the userscript build, show a clear in-page notice, and move collectors/background jobs to a backend.

## 5. Dual-release checklist (Chrome extension + userscript)

1. Keep the Chrome extension as the single source of truth.
2. In CI: `npm run build` (extension) → `node src/cli.mjs convert … --verify` (userscript) → publish both artifacts.
3. Fail the userscript build if a **core** feature uses a ❌ API (parse `--json` warnings).
4. Keep backend APIs userscript-friendly: token auth (not cookies), no CORS requirement for `GM_xhr`, rate limits and caching.
5. Prefer server-side collection and stable read APIs; treat the userscript as a client + optional low-frequency contributor, not a 24/7 worker.
6. Document per-build feature differences in the release notes.

---

## 中文要点

- **能 1:1 转的**：页面主世界注入、content script 桥、后台逻辑、跨域 `GM_xhr`、CSS、`chrome.runtime` 消息、GM 存储、多组 content scripts（匹配/排除/glob/帧/`MAIN` world）、轮询取数。
- **要改写但能做的**：`alarms`（只在页面打开时用定时器模拟）、`tabs.create`（能开页但不能读/注入）、`scripting`（改为直接 HTTP + 解析）、`action`/`contextMenus`/`notifications`/`downloads`（用页面 UI 或 GM 等价 API）、扩展设置页（改为页面内设置）、扩展 ID 握手（改为 DOM + postMessage）。
- **永远做不到的**：真正的后台常驻/SW、标签页/窗口控制与跨站注入、`webRequest`/`declarativeNetRequest` 网络拦截、`cookies`/`history`/`bookmarks`/`identity` 等浏览器数据 API、扩展 origin/ID/扩展页面/`externally_connectable`、原生消息与 USB/串口/蓝牙等 OS 集成、浏览器工具栏/全局快捷键、严格隔离世界与 CSP 特权、企业托管安装/强制更新/签名、安装后动态扩展到任意域名、油猴里安全藏密钥。
- 转换器会在检测到这些 API 时**明确告警**并生成可启动的桩，但不会假装它们可用；验证器只保证结构/载荷/语法/启动，不保证扩展专属语义。
