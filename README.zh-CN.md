# pi-code-render

> 把 Pi 终端里的代码块渲染成带一键复制按钮的卡片。

[English](./README.md) | 中文

`pi-code-render` 是 [Pi coding agent](https://pi.dev/) 的扩展。它把 assistant 消息中的
围栏代码块渲染成主题配色的整宽卡片，右上角带一个 `[COPY]` 按钮，点击卡片任意位置
即可切回原始 markdown 文本。

![pi-code-render 卡片效果](https://raw.githubusercontent.com/chengyayu/pi-code-render/main/docs/card.png)

## 效果对比

| Pi 原生渲染 | 使用 pi-code-render |
| --- | --- |
| ![原生围栏代码块](https://raw.githubusercontent.com/chengyayu/pi-code-render/main/docs/before.png) | ![卡片效果](https://raw.githubusercontent.com/chengyayu/pi-code-render/main/docs/card.png) |

## 功能

- **代码卡片** — assistant 消息中的代码块渲染成主题配色的整宽面板，风格与 Pi 原生的
  codemode 面板一致。`[COPY]` 按钮位于代码首行行尾，因此代码上方没有多余的语言标签行，
  代码紧接着卡片顶部开始。
- **一键复制** — 右上角 `[COPY]` 按钮把该代码块源码（已去掉围栏）复制到剪贴板。
  `Ctrl+Alt+C` 可在任意位置复制最近渲染的代码块。
- **原文切换** — 点击卡片任意位置可在卡片与原始围栏文本之间切换，再次点击即恢复。
- **智能高亮** — 形如 ` ```js workflow ` 的 info string 会按 JavaScript 高亮；
  未知语言保留纯文本渲染。
- **剪贴板优先用原生实现** — 优先使用 Pi 的原生剪贴板助手，失败时回退到
  `pbcopy` / `wl-copy` / `xclip` / `clip`。
- **临时提示** — 复制成功后在页脚显示状态，2 秒后自动清除，不会留在对话记录里。
- **不动你的消息** — 你自己发的消息和 thinking 块中的代码块保持 Pi 原生渲染。

## 安装

```bash
pi install npm:pi-code-render
```

安装后重启 Pi，或执行 `/reload`。

## 使用

| 操作 | 结果 |
| --- | --- |
| 点击 `[COPY]` | 复制该代码块源码到剪贴板 |
| 点击卡片其他位置 | 在卡片与原始围栏文本之间切换 |
| 点击原始文本里的代码 | 折回卡片 |
| 在原始文本的代码上拖动 | 按普通文本选中（Pi 的选中即复制会一并复制） |
| `Ctrl+Alt+C` | 复制最近渲染的代码块 |

原始围栏文本保持可选中：代码区域交给 Pi 的文本选择，拖动或双击即可选中并复制；
原地单击则把该块折回卡片。

## 兼容性

- 需要 Pi 0.99.0 或更高版本。
- 在 regular 和 fullscreen TUI 模式下均可工作；非 TUI 模式不受影响。
- 卡片效果通过 patch Pi 内部的 Markdown 渲染器实现，该渲染器目前没有公开的
  transcript 样式钩子。未来 Pi 版本可能需要本包跟进更新。

## 卸载

```bash
pi remove npm:pi-code-render
```

## License

MIT

## 开发

```bash
npm run typecheck   # tsc --noEmit
npm test            # 渲染测试（node test/render.test.mjs）
```
