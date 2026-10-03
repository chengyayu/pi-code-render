# 推广 PR 与文案材料

本目录内容由 AI 协助准备，供你本人提交。**没有任何内容会自动提交到第三方仓库。**

---

## 1. awesome-pi（中文列表）PR

**目标仓库**：https://github.com/BubblePtr/awesome-pi
**贡献说明**：仓库根目录没有 CONTRIBUTING.md，按其现有格式提交即可。

### 修改步骤

1. Fork https://github.com/BubblePtr/awesome-pi
2. 编辑 `README.md`
3. 定位到 `### UI Enhancement` 一节
4. 在 `- [@juicesharp/rpiv-btw]...` 之后、`---` 之前**追加一行**
5. 提 PR

### 要追加的那一行（直接复制）

```
- [pi-code-render](https://github.com/chengyayu/pi-code-render) - 把代码块渲染成带 `[COPY]` 一键复制按钮的主题配色卡片，点击卡片可切回原始围栏文本；复制成功后在页脚短暂提示，不污染对话。`pi install npm:pi-code-render`
```

### PR 标题

```
Add pi-code-render to UI Enhancement
```

### PR 描述

```markdown
新增 `pi-code-render`，归入 UI Enhancement 分类。

它把 assistant 消息中的围栏代码块渲染成主题配色的整宽卡片，右上角提供
`[COPY]` 一键复制按钮，点击卡片任意位置可在卡片与原始 markdown 之间切换。

- npm: https://www.npmjs.com/package/pi-code-render
- 源码: https://github.com/chengyayu/pi-code-render
- 许可: MIT
- 已发布版本: 0.1.8

对比截图见 README 的 Before / After 一节。感谢维护这个列表。
```

---

## 2. awesome-pi-agent（英文列表）PR

**目标仓库**：https://github.com/thevibeworks/awesome-pi-agent
**贡献要求**（摘自其 CONTRIBUTING.md）：
1. Alive — 未归档，一年内有提交
2. Documented — README 说明用途与用法
3. Actually about pi — 为 pi 构建
4. One line — `- [name](url) — what it does and why it's useful.`
5. Alphabetical — 章节内按字母序

### 修改步骤

1. Fork https://github.com/thevibeworks/awesome-pi-agent
2. 编辑 `README.md`
3. 定位到 `## UI & Interaction` 一节
4. 按**字母序**插入（`pi-code-render` 应排在 `pi-canvas` 之后、`pi-design-deck` 之前）
5. 提 PR

### 要插入的那一行（直接复制）

```
- [pi-code-render](https://github.com/chengyayu/pi-code-render) — Renders fenced code blocks as theme-colored cards with a one-click `[COPY]` button and a click-to-toggle raw-text view.
```

插入后的上下文应是：

```markdown
- [pi-canvas](https://github.com/jyaunches/pi-canvas) — Interactive TUI canvases (calendar, document, flights) rendered inline.
- [pi-code-render](https://github.com/chengyayu/pi-code-render) — Renders fenced code blocks as theme-colored cards with a one-click `[COPY]` button and a click-to-toggle raw-text view.
- [pi-design-deck](https://github.com/nicobailon/pi-design-deck) — Present multi-slide design options with high-fidelity previews.
```

### PR 标题

```
Add pi-code-render to UI & Interaction
```

### PR 描述

```markdown
Adding `pi-code-render` to UI & Interaction.

It renders fenced code blocks in assistant messages as theme-colored, full-width
cards with a right-aligned `[COPY]` button on the code's first line, and a
click-to-toggle raw-text view. `Ctrl+Alt+C` copies the most recently rendered block.

Meets the listed bar:
- Alive: repo created 2026-10-01, active
- Documented: README covers features, install, usage, compatibility
- Actually about pi: a Pi extension shipped as a Pi package (`pi-package` keyword)
- One line, placed alphabetically within UI & Interaction

- npm: https://www.npmjs.com/package/pi-code-render
- License: MIT
```

---

## 3. 中文介绍文（可发 V2EX / 掘金 / 少数派 / 小红书）

标题备选：
- 《给 Pi 的代码块加个一键复制按钮》
- 《我写了 Pi 的第一个代码卡片扩展》
- 《Pi 终端里的代码块，现在能一键复制了》

### 正文草稿

我用 Pi 写代码有一阵子了。它是个终端里的 AI coding agent，输出里经常夹带大段代码。

但有个小地方一直不太顺手：**代码块没有复制按钮**。想复制一段配置或者一段 SQL，得用鼠标从围栏标记外面一点点拖选，稍不注意就把 ``` 也选进去了，或者少选几行。

Pi 的扩展机制是开放的，我就花了个周末写了个扩展解决这件事，叫 `pi-code-render`。

**它做了什么**

把 assistant 消息里的围栏代码块，渲染成主题配色的整宽卡片：

- 代码首行行尾有个 `[COPY]`，点一下就把这段代码（不含围栏）复制到剪贴板
- 卡片首末两行留了对称的上下边距，看起来不像糊在文字里
- 点击卡片任意位置，可以切回 Pi 原本的 markdown 原始文本，方便你确认真实内容
- 想复制最近一段代码？`Ctrl+Alt+C`，不用往上翻

有一点我特意处理了：**你自己发的消息和 thinking 块不受影响**，仍然是 Pi 的原生渲染。这个扩展只作用于 assistant 的输出，避免干扰你对自己消息的阅读。

**安装**

```bash
pi install npm:pi-code-render
```

装完重启 Pi，或者 `/reload` 一下。

**关于实现**

Pi 目前没有公开的 transcript 样式钩子，所以卡片效果是通过 patch 内部 Markdown 渲染器的 `renderToken` / `render` / `handleMouse` 实现的。这意味着未来 Pi 版本更新可能会需要本包跟进适配，README 里我也写明了这一点。

复制功能优先用 Pi 的原生剪贴板助手，失败时回退到 `pbcopy` / `wl-copy` / `xclip` / `clip`。

**链接**

- GitHub: https://github.com/chengyayu/pi-code-render
- npm: https://www.npmjs.com/package/pi-code-render

MIT 许可。如果你也在用 Pi，欢迎试试；有想法或者遇到问题，开 issue 就行。

---

## 4. 提交前的自检清单

- [ ] 两个 PR 都基于最新 main
- [ ] 每行只描述价值，不堆形容词
- [ ] 链接可访问
- [ ] 没有重复提交同一个项目到多个分类
- [ ] 发帖后 24 小时内回复评论

---

## 备注：不做的事

本材料**不包含**任何刷量手段（模拟安装、CI 定时拉取、代理轮换、买 star、虚假宣传）。
这类操作会被 npm 清洗统计并可能触发风控，也会损害包本身的信誉。
