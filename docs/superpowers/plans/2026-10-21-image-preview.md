# 消息图片点击放大 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户消息里的图片缩略图可以点击，在面板内用全屏遮罩查看原图，并支持键盘与三种关闭方式。

**Architecture:** 复用现有 `<dialog>` 机制新增一个轻量图片预览框；缩略图仍是现有 `userFilesHtml()` 生成的 `<img class="att-img">`，只补可聚焦语义；打开/关闭由 `#messages` 的事件委托和 `setupImagePreview()` 接线。预览直接使用消息里已有的 `data:` URL，不发网络请求。

**Tech Stack:** 原生浏览器 JavaScript、HTML `<dialog>`、CSS。

**Spec:** `docs/superpowers/specs/2026-10-15-mobile-design.md`（新增 §8.95）

## Global Constraints

- 只处理用户消息里已渲染的 `.att-img`；工具返回图片目前没有 `<img>`，本次不扩范围。
- 不发额外网络请求，预览复用 `img.src` 的 `data:` URL。
- 关闭方式：关闭按钮、点遮罩、`Esc`；关闭时清掉预览 `src`，避免长期占用内存。
- 桌面和手机共用同一套 DOM；手机用 `html.narrow` 走整屏样式，不另设断点变量。
- 公共提交不含内部标识；测试数据使用合成内容。

## Review Focus

- 消息里有多张图片时，点击哪张就预览哪张（不能总取第一张）。
- 图片文件名含 HTML 或很长时，预览标题不注入 HTML、不把按钮挤出屏幕。
- 图片 `data:` URL 很大时，关闭后应释放预览节点上的 `src`。
- 键盘 `Enter` / `Space` 只对图片生效，不影响现有子会话收工行的键盘打开逻辑。
- 点遮罩关闭，但点图片本身或顶栏按钮不能误关。

---

### Task 1: 图片预览框与缩略图入口

**Files:**
- Modify: `public/index.html`
- Modify: `public/styles.css`
- Modify: `public/app.js`
- Test: `test/ui-attach.html`

**Interfaces:**
- Produces: `openImagePreview(src: string, name: string) -> boolean`
- Produces: `closeImagePreview() -> void`
- Produces: `setupImagePreview() -> void`
- Consumes: existing `openDlg(dialog)` / `closeDlg(dialog)` and `#messages` delegated events.

- [ ] **Step 1: Write the failing browser tests**

In `test/ui-attach.html`, add `#dlgImage` markup and assertions for: thumbnail has `role="button"` / `tabindex="0"`; clicking opens with the correct `src` and filename; `Enter` and `Space` open; close button, backdrop click, and `close` event clear `src`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node test/ui-attach-run.js`
Expected: FAIL because `#dlgImage` / `openImagePreview` and the delegated click are missing.

- [ ] **Step 3: Add markup, styles, and handlers**

Add `#dlgImage` to `public/index.html`, `.att-img` affordance + `.dlgimage` styles to `public/styles.css`, `openImagePreview()` / `closeImagePreview()` / `setupImagePreview()` and delegated click/keydown branches to `public/app.js`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node test/ui-attach-run.js`
Expected: all pass, 0 failed.

- [ ] **Step 5: Add regression locks and docs**

Add the §8.95 static lock to `test/smoke.sh`, describe the feature in `README.md` and `docs/superpowers/specs/2026-10-15-mobile-design.md`.

- [ ] **Step 6: Run full regression**

Run: `/tmp/opencode/perf/regress-887.sh`
Expected: smoke / ui-capabilities / ui-stream / ui-attach all pass; optional real-model cases may skip.

- [ ] **Step 7: Commit and push**

```bash
git add public/index.html public/styles.css public/app.js test/ui-attach.html test/smoke.sh README.md docs/superpowers/specs/2026-10-15-mobile-design.md docs/superpowers/plans/2026-10-21-image-preview.md
git commit -m "新增：消息图片点击放大预览"
git push origin main
git push github main
```
