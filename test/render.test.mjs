import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { transform } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const arg = process.argv[2];
const extensionPath = arg
  ? resolve(process.cwd(), arg)
  : resolve(here, "../extensions/pi-code-render.ts");

// Node 22 (CI) cannot import TypeScript directly, so the extension is
// transpiled to a temp file inside the repo first: the harness and the extension
// must share one `@earendil-works/pi-tui` instance, since the patch replaces
// methods on that module's `Markdown.prototype`.
const source = await readFile(extensionPath, "utf8");
const { code } = await transform(source, { loader: "ts", format: "esm", target: "node22" });
const staging = await mkdtemp(resolve(here, ".staged-"));
const stagedFile = resolve(staging, "pi-code-render.mjs");
await writeFile(stagedFile, code, "utf8");
const { default: extension } = await import(pathToFileURL(stagedFile).href);
await rm(staging, { recursive: true, force: true });

const { Markdown, stripTerminalSequences } = await import("@earendil-works/pi-tui");

const id = (value) => value;
// Real themes emit ANSI for emphasis, and the extension searches stripped rows.
// Styling inline tokens with actual escape codes keeps this harness faithful:
// with an identity theme, `**bold [COPY]**` would keep its literal asterisks.
const ansi = (code) => (value) => `\x1b[${code}m${value}\x1b[0m`;
const theme = {
  heading: ansi("1"), link: id, linkUrl: id, code: ansi("36"), codeBlock: id,
  codeBlockBorder: id, quote: id, quoteBorder: id, hr: id, listBullet: id,
  bold: ansi("1"), italic: ansi("3"), strikethrough: ansi("9"), underline: ansi("4"),
  fg: (_name, value) => value, bg: (_name, value) => value,
  codeBlockIndent: "  ",
};

// Install the real extension through its public entry point.
const handlers = {};
extension({ registerShortcut() {}, on(name, fn) { handlers[name] = fn; } });
const tuiContext = { mode: "tui", ui: { theme, setStatus() {}, notify() {} } };
handlers.session_start({}, tuiContext);

const WIDTH = 80;
// 渲染行里带不可见的零宽锚点（\u200b 按钮锚点、\u2060 raw 起点锚点）。用户看不到它们，
// 比较可见内容时一并去掉，断言才对应「实际看到的东西」而不是实现细节。
const plain = (lines) => lines.map((line) => stripTerminalSequences(line).replace(/[\u200b\u2060]/g, ""));
const cardRows = (lines) => plain(lines).flatMap((l, i) => (l.includes("[COPY]") ? [i] : []));
const cardCount = (lines) => cardRows(lines).length;
const has = (lines, needle) => plain(lines).some((l) => l.includes(needle));

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  | ${detail}` : ""}`);
};

const mouseAt = (x, y, type = "press") => ({
  type, button: "left", x, y, screenX: x, screenY: y, width: WIDTH, height: 40,
  shift: false, alt: false, ctrl: false,
});
const rowOf = (md, needle) => plain(md.render(WIDTH)).findIndex((l) => l.includes(needle));
const rowIsCard = (md, needle) => (plain(md.render(WIDTH))[rowOf(md, needle)] ?? "").includes("[COPY]");

/** 扩展自己的手势路径：press -> release。 */
const pressRelease = (md, y, x = 1) => {
  md.handleMouse(mouseAt(x, y, "press"));
  md.handleMouse(mouseAt(x, y, "release"));
};
/** Pi 的选区路径：press 未被捕获 -> release ->（未拖动时）click。 */
const selectClick = (md, y, x = 1, clickCount = 1) => {
  md.handleMouse(mouseAt(x, y, "press"));
  md.handleMouse(mouseAt(x, y, "release"));
  md.handleMouse({ ...mouseAt(x, y, "click"), clickCount });
};
/** 点卡片正文，折成 raw。 */
const toRaw = (md, needle) => pressRelease(md, rowOf(md, needle));
/**
 * raw 块的起始 fence 行（折叠手柄）。扩展在那里打了不可见锚点 \u2060，用它定位比
 * 「只由围栏组成的行」可靠：后者会同时匹配到闭合围栏行和含围栏的代码行。
 */
const rawHandleRows = (lines) => lines.flatMap((l, i) => (l.includes("\u2060") ? [i] : []));

console.log(`\n=== 被测扩展: ${extensionPath} ===`);

// ===========================================================================
// 1. 围栏解析 -> 卡片划分
//    CommonMark 的围栏嵌套规则会让内容里的围栏行进入 code token，扩展必须按
//    「最后一个围栏行才是 Pi 补的闭合行」来切卡片，并且只对真正的代码块画卡片。
// ===========================================================================
console.log("\n-- 1. 围栏解析 -> 卡片划分 --");
{
  // 内容本身就是一段 markdown（含裸围栏行），外层必须比内层长
  const nested = [
    "正文：", "",
    "````markdown",
    "### 2.2 新建智能体与小队", "",
    "```text",
    "提示词内容",
    "```", "",
    "4. 核对 MiKa 的执行结果",
    "````",
  ].join("\n");
  const md = new Markdown(nested, 0, 0, theme);
  const lines = plain(md.render(WIDTH));
  check("嵌套围栏：只有一张卡片", cardCount(lines) === 1, `卡片数 = ${cardCount(lines)}`);
  check("嵌套围栏：内容里的裸围栏行没有被当成闭合行（尾部不丢）", has(lines, "4. 核对 MiKa 的执行结果"));
  check("嵌套围栏：内容里的 ```text 行完整保留", has(lines, "```text"));
}

{
  // 末尾一个未闭合的围栏解析成空 code token，不能画成空卡片
  const stray = ["前言", "", "```js", "const a = 1;", "```", "", "```"].join("\n");
  const lines = plain(new Markdown(stray, 0, 0, theme).render(WIDTH));
  check("孤立围栏：不生成空卡片", cardCount(lines) === 1, `卡片数 = ${cardCount(lines)}`);
  check("孤立围栏：正常块的内容不受影响", has(lines, "const a = 1;"));
}

{
  // 缩进代码块没有围栏，但 Pi 对每个 code token 都会补围栏行，所以它也是卡片
  const indented = ["    indented_line_one", "    indented_line_two"].join("\n");
  const md = new Markdown(indented, 0, 0, theme);
  check("缩进代码块：渲染为卡片", cardCount(plain(md.render(WIDTH))) === 1);
  const y = rowOf(md, "indented_line_one");
  check("缩进代码块：卡片可点（命中区未被跳过）", md.handleMouse(mouseAt(1, y, "press"))?.capture === true);
}

// ===========================================================================
// 2. 锚点唯一性
//    卡片锚点必须只有真按钮能命中：正文、行内代码、粗体标题剥掉 ANSI 后都可能
//    恰好以 [COPY] 结尾。
// ===========================================================================
console.log("\n-- 2. 锚点唯一性 --");
{
  const doc = [
    "说明：点右边的 [COPY] 就能复制，行内 `[COPY]` 也一样。",
    "",
    "**粗体标题里的 [COPY]**",
    "",
    "```js",
    "const a = 1;",
    "```",
  ].join("\n");
  const md = new Markdown(doc, 0, 0, theme);
  const lines = plain(md.render(WIDTH));
  const cardRow = rowOf(md, "const a = 1;");
  const hijackRows = lines.flatMap((l, i) =>
    l.includes("[COPY]") && i !== cardRow ? [i] : [],
  );

  check("锚点唯一性：正文/粗体标题里的 [COPY] 行确实存在（复现前提）", hijackRows.length >= 2, `候选行 = ${JSON.stringify(hijackRows)}`);
  check("锚点唯一性：卡片真实按钮仍被捕获", md.handleMouse(mouseAt(lines[cardRow].indexOf("[COPY]"), cardRow, "press"))?.capture === true);
  const hijacked = hijackRows.filter((y) => md.handleMouse(mouseAt(lines[y].indexOf("[COPY]"), y, "press")) !== undefined);
  check("锚点唯一性：任何非按钮行都不落入命中区", hijacked.length === 0, `被劫持的行 = ${JSON.stringify(hijacked)}`);
}

// ===========================================================================
// 3. 命中区 -> 块的映射
//    每一行点击必须映射到它所在的那个块，且与上下文无关：多块、逐字节相同的块、
//    引用前缀、折行、流式重排。
// ===========================================================================
console.log("\n-- 3. 命中区 -> 块的映射 --");
{
  const doc = ["```ts", "const a = 1;", "```", "", "```python", "print(1)", "```", "", "```sql", "select 1;", "```"].join("\n");
  const md = new Markdown(doc, 0, 0, theme);
  check("多块：三张卡片且按顺序排列", cardCount(plain(md.render(WIDTH))) === 3);
  toRaw(md, "select 1;");
  check("多块：只有被点的那块变 raw（按源码区分）", !rowIsCard(md, "select 1;") && rowIsCard(md, "const a = 1;") && rowIsCard(md, "print(1)"));
}

{
  // 逐字节相同：靠 index + source 区分，raw 收缩后的位移也不能串扰
  const doc = ["A", "", "```js", "same", "```", "", "B", "", "```js", "same", "```", "", "C", "", "```js", "same", "```"].join("\n");
  const md = new Markdown(doc, 0, 0, theme);
  check("相同源码：初始三张卡片", cardCount(plain(md.render(WIDTH))) === 3);

  // 切中间那张：raw 应落在两张卡片之间
  pressRelease(md, cardRows(md.render(WIDTH))[1]);
  const handles = rawHandleRows(md.render(WIDTH));
  check("相同源码：只切换被点的那一张", cardCount(plain(md.render(WIDTH))) === 2 && handles.length === 1, `卡片 ${cardCount(plain(md.render(WIDTH)))} / raw ${handles.length}`);
  check("相同源码：raw 块落在两张卡片之间", cardRows(md.render(WIDTH))[0] < handles[0] && handles[0] < cardRows(md.render(WIDTH))[1]);

  // 再切最后那张：此时它已因第一块变 raw 而上移，index 必须仍指向它
  pressRelease(md, cardRows(md.render(WIDTH))[1]);
  check("相同源码：raw 位移后仍能切换第三张", rawHandleRows(md.render(WIDTH)).length === 2 && cardCount(plain(md.render(WIDTH))) === 1);

  // 每次重新定位：前一块折回后，后面 raw 块的行号会位移
  for (let guard = 0; guard < 4 && rawHandleRows(md.render(WIDTH)).length > 0; guard++) {
    pressRelease(md, rawHandleRows(md.render(WIDTH))[0]);
  }
  check("相同源码：逐个点回卡片", cardCount(plain(md.render(WIDTH))) === 3);
}

{
  // 引用会给每行加 "│ " 前缀，按行首 ``` 找块起点会扫到别的块
  const doc = ["> ```js", "> QUOTE_FIRST();", "> ```", "", ">> 间隔正文", "", "```js", "PLAIN_SECOND();", "```"].join("\n");
  const md = new Markdown(doc, 0, 0, theme);
  toRaw(md, "QUOTE_FIRST");
  toRaw(md, "PLAIN_SECOND");
  check("引用前缀：两块都进入 raw", !rowIsCard(md, "QUOTE_FIRST") && !rowIsCard(md, "PLAIN_SECOND"));

  selectClick(md, rowOf(md, "PLAIN_SECOND"));
  check("引用前缀：点普通块不会切到引用块", !rowIsCard(md, "QUOTE_FIRST"), "修复前会指到后面那个块的 fence");
  check("引用前缀：被点的普通块回到卡片", rowIsCard(md, "PLAIN_SECOND"));
  selectClick(md, rowOf(md, "QUOTE_FIRST"));
  check("引用前缀：引用里的 raw 块自身也能折回", rowIsCard(md, "QUOTE_FIRST"));
}

{
  // 长代码行会被 Pi 二次折行，fence 行之外的行数不能靠 renderToken 的行数推算
  const longLine = "const veryLongIdentifier = someFunction(argumentOne, argumentTwo, argumentThree);";
  const doc = ["前言", "", "```ts", longLine, longLine, "const tail = 2;", "```", "", "结语"].join("\n");
  const width = 60;
  const md = new Markdown(doc, 0, 0, theme);
  const before = plain(md.render(width));
  const y0 = before.findIndex((l) => l.includes("veryLongIdentifier"));
  pressRelease(md, y0);
  const raw = plain(md.render(width));
  const fence = rawHandleRows(md.render(width))[0];
  const closing = raw.findIndex((l, i) => i > fence && l.trim() === "```");
  check("折行：raw 块确实比 renderToken 行数高（复现前提）", closing - fence + 1 > 5, `实际 ${closing - fence + 1} 行`);
  pressRelease(md, fence);
  check("折行：起始 fence 行折回卡片", cardCount(plain(md.render(width))) === 1);
}

{
  // 按住期间流式更新在上方插入新块，release 不能切到被顶下来的那一块
  const doc = ["前言", "", "```js", "const a = 1;", "```", "", "结语"].join("\n");
  const md = new Markdown(doc, 0, 0, theme);
  const y = rowOf(md, "const a = 1;");
  md.handleMouse(mouseAt(1, y, "press"));
  md.setText(["新块", "", "```js", "const NEW = 1;", "```", "", ...doc.split("\n")].join("\n"));
  md.render(WIDTH);
  md.handleMouse(mouseAt(1, y, "release"));
  // 块被重编号后，按下的那个块已经不在原 index 上：宁可不动作，也不能切到别的块
  check("流式重排：块被重编号时不错切（宁可不动）", rawHandleRows(md.render(WIDTH)).length === 0);
}

// ===========================================================================
// 4. 鼠标手势
//    终端在按住时按单元格上报移动，所以「抖动」不能取消点击；只有离开目标才算拖拽。
// ===========================================================================
console.log("\n-- 4. 鼠标手势 --");
{
  const doc = ["前言", "", "```js", "const a = 1;", "```", "", "结语"].join("\n");
  const dragged = (events) => {
    const md = new Markdown(doc, 0, 0, theme);
    const y = rowOf(md, "const a = 1;");
    for (const [type, dx, dy] of events) md.handleMouse(mouseAt(1 + dx, y + dy, type));
    return !rowIsCard(md, "const a = 1;");
  };

  check("抖动：原地 press+release 切换", dragged([["press", 0, 0], ["release", 0, 0]]));
  check(
    "抖动：drag 右移 1 格后松开仍切换",
    dragged([["press", 0, 0], ["drag", 1, 0], ["release", 1, 0]]),
    "修复前 drag 直接丢弃手势，点击无反应",
  );
  check(
    "抖动：move 下移 1 行后松开仍切换",
    dragged([["press", 0, 0], ["move", 0, 1], ["release", 0, 1]]),
    "修复前 move 直接丢弃手势，点击无反应",
  );
  check("抖动：抖出去再回到原格松开仍切换", dragged([["press", 0, 0], ["drag", 1, 0], ["release", 0, 0]]));
  check("拖拽：拖出卡片再松开不切换", !dragged([["press", 0, 0], ["drag", 0, 20], ["release", 0, 20]]));
}

// ===========================================================================
// 5. raw 视图：代码可选中，同时保持单击折叠
//    raw 块的代码行不捕获 press，Pi 才能起选区；未拖动的点击由 Pi 回派 click，
//    那时再折回卡片。起始 fence 行仍是带容错的手柄。
// ===========================================================================
console.log("\n-- 5. raw 视图：可选中 + 单击折叠 --");
{
  const doc = ["```js", "const first = 1;", "const second = 2;", "```"].join("\n");
  const fresh = () => {
    const md = new Markdown(doc, 0, 0, theme);
    toRaw(md, "const first");
    return md;
  };
  const rawFence = (md) => rawHandleRows(md.render(WIDTH))[0];
  const isRaw = (md) => !rowIsCard(md, "const first");

  {
    const md = fresh();
    check("raw 选区：代码正文的 press 不被捕获", md.handleMouse(mouseAt(1, rowOf(md, "const second"), "press")) === undefined, "捕获了就没法拖选");
  }
  {
    const md = fresh();
    const y = rowOf(md, "const second");
    md.handleMouse(mouseAt(1, y, "press"));
    md.handleMouse(mouseAt(12, y, "drag"));
    md.handleMouse(mouseAt(12, y, "release"));
    check("raw 选区：拖动后保持 raw（选中不被打断）", isRaw(md));
  }
  {
    const md = fresh();
    selectClick(md, rowOf(md, "const second"));
    check("raw 选区：正文原地单击折回卡片", !isRaw(md));
  }
  {
    const md = fresh();
    selectClick(md, rowOf(md, "const second"), 1, 2);
    check("raw 选区：双击选词不折回卡片", isRaw(md), "折回会立刻清掉选中的词");
  }
  {
    const md = fresh();
    pressRelease(md, rawFence(md));
    check("raw 选区：起始 fence 行是带容错的手柄", !isRaw(md));
  }
  {
    // 手柄 release 之后 Pi 还会回派一个 echo click，不能造成二次切换
    const md = fresh();
    const y = rawFence(md);
    pressRelease(md, y);
    md.handleMouse(mouseAt(1, y, "click"));
    check("raw 选区：手柄的 echo click 不二次切换", !isRaw(md), "否则会切回 raw，看着没反应");
  }
}

// ===========================================================================
// 6. 重新安装 patch（README 让用户 /reload）
//    重复安装必须先还原旧 patch，否则 renderToken 会自我包裹：卡片会重复或行数翻倍。
// ===========================================================================
console.log("\n-- 6. 重新安装（/reload）--");
{
  const doc = ["前言", "", "```js", "const a = 1;", "```", "", "结语"].join("\n");
  const snapshot = () => plain(new Markdown(doc, 0, 0, theme).render(WIDTH));
  const baseline = snapshot();

  handlers.session_shutdown();
  handlers.session_start({}, tuiContext);
  const afterReload = snapshot();

  handlers.session_start({}, tuiContext); // 不 shutdown 直接再装一次
  const afterRepeat = snapshot();

  check(
    "重新安装：shutdown + start 后输出不变",
    afterReload.join("\n") === baseline.join("\n"),
    `行数 ${baseline.length} -> ${afterReload.length}`,
  );
  check("重新安装：重复 start 不叠加", afterRepeat.join("\n") === baseline.join("\n"));
}

console.log(failures === 0 ? "\n全部通过 ✅" : `\n${failures} 项失败 ❌`);
process.exit(failures === 0 ? 0 : 1);
