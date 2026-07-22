---
name: state-machine
description: >
  Structure a small script (scraper, data pipeline, job poller, retry loop) as a tiny declarative
  state machine so it stays readable months later. Use this skill when the user wants to write or
  refactor a script that has genuine control-flow state — retries, polling/waiting, multiple exits,
  or failure recovery — and asks things like "用状态机管理这个脚本", "make this script readable",
  "add retry/polling logic", "画个状态图", "state machine for my crawler/data script". The pattern
  is: pure-data machine definition + pure transition engine + an observation layer that prints a
  live ASCII state diagram. FIRST run the judgment gate below — if the script is a linear pipeline,
  decline and write plain functions instead.
---

# 小脚本状态机

一个让爬虫 / 数据处理 / 轮询类小脚本**长期可读**的三层模式:声明式状态定义(纯数据)+ 纯转移引擎 + 可视化观察层。时间久了回头看,一张状态图 + 一行 trail 就能看懂整个脚本在干什么。

参考实现见 [`references/`](references/):只有两个引擎文件 + 一个用例 ——
`machine.json`(纯数据定义)、`machine-runtime.ts`(转移引擎 + 观察层/`render()` 合一)、`main.ts`(直接可用的用法)。
那是**形态参考**,不是要求用 TypeScript。核心是 **machine 定义永远是纯数据(独立的 `machine.json`)**,不要把它内联进代码。

---

## 第 0 步:判断闸门(先判断,再动手)

**这个模式不适合所有脚本。** 硬套到线性脚本上只会增加仪式感、降低可读性。

只有满足**至少一条**才用状态机:

- 有**重试 / 回边**:`failed → RETRY → creating …`
- 有**轮询 / 等待**:`waiting → SUCCESS / FAILURE`
- 有**多出口 / 失败恢复**的分支
- 状态之间会**来回跳**,而不是一条道走到底

判据口诀:**画不出一张带回边或多出口的图,就别用。**

如果脚本是纯线性管道(`fetch → parse → transform → write`,顺着走一遍就结束),**明确劝退**:告诉用户直接写几个顺序函数更清楚,不要引入状态机。不要在这种脚本上生成脚手架。

---

## 第 1 步:选语言

读用户的项目和需求,选**最贴合的语言**,照 `references/` 的结构翻译(纯数据 `machine.json` + 引擎/观察合一的 `machine-runtime`,`main` 演示用法)。常见映射:

| 场景 | 语言 |
|------|------|
| 爬虫 / 数据处理 / 已有 Python 项目 | Python(dict 存 machine,函数闭包做 runtime/log) |
| Node / 前端工具链 / TS 项目 | TypeScript / JavaScript |
| CLI / 后端 / 已有 Go 项目 | Go(map 存 machine,struct + 方法) |
| Shell 胶水脚本 | Bash(case 查表 + printf 上色) |

**跟随项目现状优先**:已有代码库就沿用它的语言和风格;是全新脚本才按场景挑。翻译时下面的「设计契约」必须保持不变。

---

## 第 2 步:设计契约(跨语言不可动摇)

无论用什么语言,这五条必须守住 —— 它们是可读性的来源:

1. **machine 定义 = 纯数据,存成独立文件。** 只有「状态有哪些」「什么事件到哪个状态」。优先放进**独立的 `machine.json`**(或对应语言的纯数据文件:Python 可用单独的 dict 模块、Go 用 map、Bash 用关联数组)。**不要把它内联进代码逻辑里** —— 数据与引擎分离,才能一眼看懂脚本有哪些状态、怎么跳。

2. **转移引擎 = 纯查表。** 只做:查表 → 换当前状态 → 把结果交给 log。**不含任何业务副作用。**

3. **观察逻辑 = 全部集中在 log。** 单行转移日志 + `render()` 状态图。`history` 是实例私有的,存在 log 内部。log 与转移引擎**放在同一个 `machine-runtime` 文件里**(引擎调它,但业务代码不碰)——这样引擎只需一个文件,观察逻辑仍与业务/数据隔离。

4. **无 onEnter,副作用留在调用处。** 进入状态不自动触发任何动作。副作用由调用方在 `transition()` 返回后、在调用点自己执行 —— 这样控制流一眼可见,不会有隐藏的连锁反应。

5. **无效转移也返回完整 result,统一用 `accepted` 判断。** 非法事件不抛异常、不静默,而是返回 `accepted: false` 的完整结果,交给 log 记一条 invalid。调用方只有这一条错误通道。

多实例互不干扰(每次 create 独立持有自己的 current + history)。

---

## 第 3 步:render() —— 完整 ASCII 状态图

这是长期可读性的核心卖点,**必须真正实现**,不能留空。规范(实现以 `references/machine-runtime.ts` 里的 `render()` 为准):

每次转移后,打印整张图,每个状态一块:

- 状态头:当前状态用 `●` + **加粗**;其余用 `○`。初始状态标 `[initial]`。
- **走过的**状态/边 → **绿色**;
- **当前状态的出边**(下一步可走)→ 正常亮度;
- 其余(没走过、当前走不到)→ **变暗**。
- 每个状态列出它的出边:`├─ EVENT ────▶ target`(箭头对齐)。
- 末尾一行轨迹:`trail: idle → creating → waiting`。

效果示意(当前在 `waiting`):

```
○ idle  [initial]        ← 绿(走过)
  └─ CREATE ────▶ creating

○ creating               ← 绿(走过)
  ├─ CREATED ───▶ waiting
  └─ FAILURE ───▶ failed  ← 暗(没走这条)

● waiting                ← 加粗(当前)
  ├─ SUCCESS ───▶ success ← 正常亮度(可走)
  └─ FAILURE ───▶ failed

...(failed / success 整块变暗)

trail: idle → creating → waiting
```

从 `history` 推导「走过的状态」和「走过的边」,不要另存一份状态。

---

## 第 4 步:调用处接副作用

生成脚手架后,在 `main` 里演示用法:每次 `transition()` 后,用 `if (m.state === '…')` 在调用点写副作用。控制流全部显式可见,没有藏在状态机内部的动作。

```
const r = m.transition('CREATE', payload)
if (!r.accepted) { /* 唯一的错误处理通道 */ }
if (m.state === 'creating') { /* doCreate() ... */ }
```

---

## 验证

- 跑一遍 `main` 段(编译/直接执行),肉眼确认 ASCII 图的「绿/加粗/暗 + trail」符合规范。
- 触发一次非法事件,确认走 invalid 通道、不崩。
- 对照判断闸门再确认一次:这个脚本确实有真状态,而不是被硬套的线性管道。
