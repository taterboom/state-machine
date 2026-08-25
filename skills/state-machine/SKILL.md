---
name: state-machine
description: >
  Structure a small script (scraper, data pipeline, job poller, retry loop) as a tiny declarative
  state machine so it stays readable months later. Use this skill when the user wants to write or
  refactor a script that has genuine control-flow state — retries, polling/waiting, multiple exits,
  or failure recovery — and asks things like "用状态机管理这个脚本", "make this script readable",
  "add retry/polling logic", "画个状态图", "state machine for my crawler/data script". The pattern
  (inspired by statecharts and vuex) is: a pure-data machine in xstate-shaped JSON (nested groups
  with initial, parent edges, named-event mutations; one machine per parallel region) + actions as
  plain async functions holding all business logic + an observation layer that prints a live ASCII
  state diagram. FIRST run the judgment gate below — if the script is a linear pipeline, decline
  and write plain functions instead.
---

# 小脚本状态机

一个让爬虫 / 数据处理 / 轮询类小脚本**长期可读**的分层模式(受 statechart 与 vuex 启发):

```
machine(state + mutation)   纯数据、xstate 形态的嵌套 JSON;transition(EVENT) 唯一改状态口
actions(普通 async 函数)     业务层:顺序写业务,每步进展 commit 一个事件;guard 是可选的补充
观察层(log + render)        单行日志(带事件名)+ 实时 ASCII 状态图(带群缩进)
文档层(skill 自带脚本)       scripts/machine-to-mermaid.mjs 吃 machine.json 出 mermaid 图,与项目语言无关
```

statechart 三件套在小脚本里的形态:

- **hierarchy(群/parent)**:嵌套书写 `"working": { "initial": "creating", "on": { "CANCEL": "idle" }, "states": {...} }`——群边(`on`)子状态共享,进群落到 `initial`。
- **concurrency(并行区域)**:每个区域一台 machine、一个独立 json(`job ∥ report`),互不干扰。
- **guard**:action 函数开头的早退判断;跨区域条件就是读另一台机器的 state。

核心实现原则:**嵌套是书写界面,平铺是运行语义**——引擎在 `createMachine` 时把嵌套定义编译一次(target 解析、群 initial 下钻、群边下发全在编译期),运行时 transition 永远只是一次查表。

时间久了回头看:一张状态图看懂结构,一行 trail 看懂这次跑了什么,一个 action 函数从上到下读懂一个操作。

参考实现见 [`references/`](references/):两个 json + 一个 runtime + 一个用例 ——
`machine.json`(主机器,含群)、`report-machine.json`(并行区域示例)、`machine-runtime.ts`(编译 + 转移引擎 + 观察层/`render()` 合一)、`main.ts`(直接可用的用法)。设计期出图工具在 [`scripts/machine-to-mermaid.mjs`](scripts/machine-to-mermaid.mjs)(skill 自带,不进用户项目)。
那是**形态参考**,不是要求用 TypeScript。核心是 **machine 定义永远是纯数据(独立的 `machine.json`)**,不要把它内联进代码。

---

## 第 0 步:判断闸门(先判断,再动手)

**这个模式不适合所有脚本。** 硬套到线性脚本上只会增加仪式感、降低可读性。

只有满足**至少一条**才用状态机:

- 有**重试 / 回边**:`failed → creating`(跳回去重来)
- 有**轮询 / 等待**:`waiting → success / failed`
- 有**多出口 / 失败恢复**的分支
- 状态之间会**来回跳**,而不是一条道走到底

判据口诀:**画不出一张带回边或多出口的图,就别用。**

如果脚本是纯线性管道(`fetch → parse → transform → write`,顺着走一遍就结束),**明确劝退**:告诉用户直接写几个顺序函数更清楚,不要引入状态机。不要在这种脚本上生成脚手架。

同理,群和并行区域也要过闸门:没有"多个子状态共享同一条边"就别嵌套群;没有真正正交、各自演化的两条生命周期就别开第二台 machine。

---

## 第 1 步:选语言

读用户的项目和需求,选**最贴合的语言**,照 `references/` 的结构翻译(纯数据 `machine.json` + 编译/引擎/观察合一的 `machine-runtime`,`main` 演示用法)。action 就是普通的 async 函数,任何语言都有。常见映射:

| 场景 | 语言 |
|------|------|
| 爬虫 / 数据处理 / 已有 Python 项目 | Python(dict 存 machine,函数闭包做 runtime/log) |
| Node / 前端工具链 / TS 项目 | TypeScript / JavaScript |
| CLI / 后端 / 已有 Go 项目 | Go(map/struct 存 machine,struct + 方法) |
| Shell 胶水脚本 | Bash(无嵌套结构,可手写编译后的平铺表:`state|EVENT → target`) |

**跟随项目现状优先**:已有代码库就沿用它的语言和风格;是全新脚本才按场景挑。翻译时下面的「设计契约」必须保持不变。

**翻译清单(machine-runtime 三件都要带上)**:① 编译(嵌套 → 平铺);② `transition` / `can`;③ log / render。**设计期出图不用翻译**——skill 自带的 `scripts/machine-to-mermaid.mjs` 直接吃 machine.json,Java / Go / Python 项目都用同一份(machine.json 跨语言不变,这正是定义放纯 JSON 的回报:定义、图、出图工具全部零迁移)。

静态语言(Java / Go / …)里,状态名与事件名建议用分组常量(`States.` / `Events.`)做**指向 JSON 的把手**,并在启动时与编译后的模型做漂移校验(集合不一致就直接报错)——常量是引用,不是第二份定义。

---

## 第 2 步:设计契约(跨语言不可动摇)

无论用什么语言,这六条必须守住 —— 它们是可读性的来源:

1. **machine 定义 = 纯数据,xstate 形态,存成独立文件。** 形状:

   ```json
   {
     "initial": "idle",
     "states": {
       "idle": { "on": { "SUBMIT": "working" } },
       "working": {
         "initial": "creating",
         "on": { "CANCEL": "idle" },
         "states": { "creating": { "on": { "CREATED": "waiting" } }, "...": {} }
       }
     }
   }
   ```

   每条边有名字(事件),一事件一落点——业务的每种结果都是显式事件(`CREATED` / `CREATE_FAILED`),日志与图因此会讲故事。群的 `on` 是子状态共享的边(hierarchy)。**事件按业务语义命名与归并,不按落点**:同一落点的不同语义要用不同事件(超时关单 ≠ 用户取消,即使都到 `closed`);同一语义的多条入边才共享一个事件名(群边 `CANCEL` 就是合法的归一)。guard 和副作用**进不了 JSON,也不该进**——它们属于 actions 层。**不要内联进代码**。

2. **transition(EVENT) 是唯一改状态的口(mutation),嵌套在编译期消化。** 调用方说"发生了什么",落点由定义决定——**问"发生了什么",不问"去哪"**。`createMachine` 启动时把嵌套编译成「叶子状态 → { EVENT: 叶子落点 }」的平铺表:target 名先在同级找、再逐层向外;落到群则沿 `initial` 进入叶子;子状态的边优先、群边兜底;找不到的 target 启动即报错。运行时只查表,不含任何业务副作用。同时暴露 `can(EVENT)` 供 guard 引用。

3. **action 是概念,不是 API:一个操作 = 一个普通 async 函数。** 从上到下顺序写业务,每步进展 commit 一个事件。guard 是**可选的补充**——函数开头的一个早退判断(`m.can(EVENT)` + 业务条件如重试次数;跨区域条件就是读另一台机器的 state),用于优雅拒绝;不写 guard,机器也会兜底拒绝非法状态变更(见第 6 条)。**但兜底只保状态,不保副作用**——机器能拒绝状态变更,拒绝不了已发出的副作用:凡有副作用的 action,必须先确认拿到推进权(检查占位转移的 `accepted`,或 `can()`),再执行副作用。**不要为 actions 造框架**(不需要 dispatcher / 注册表)。

4. **观察逻辑 = 全部集中在 log。** 单行转移日志(带事件名:`SUBMIT: idle → working.creating`)+ `render()` 状态图。`history` 是实例私有的,存在 log 内部。log 与编译、转移引擎**放在同一个 `machine-runtime` 文件里**——引擎只需一个文件,观察逻辑仍与业务/数据隔离。观察层**不得向业务调用处索取参数**(实例名 / 日志 tag 之类必须可省略、有默认值)——写 action 的人不该感知日志。

5. **机器无 onEnter,副作用全在 action 函数里。** 进入状态不自动触发任何动作,不会有隐藏的连锁反应——控制流在函数里一眼可见。

6. **非法事件也返回完整 result,统一用 `accepted` 判断。** 当前状态下没有这条边时不抛异常、不静默,而是返回 `accepted: false` 的完整结果,交给 log 记一条 Invalid。机器层只有这一条错误通道。注意:它保证的是**状态不会非法改变**,不是副作用不重复——副作用永远放在确认 `accepted` 之后(见第 3 条)。

**并行区域(concurrency)= 每个区域一台 machine、一个独立 json**,每台各自持有 current + history,互不干扰;多实例同理。

---

## 第 3 步:render() —— 完整 ASCII 状态图

这是长期可读性的核心卖点,**必须真正实现**,不能留空。规范(实现以 `references/machine-runtime.ts` 里的 `render()` 为准):

每次转移后,打印整张图,按定义的书写顺序、**带群缩进**,每个状态一块:

- 状态头:当前状态用 `●` + **加粗**;其余用 `○`。父级 initial 标 `[initial]`,群标 `[群]`。
- **走过的**状态/边 → **绿色**;**当前状态的出边**(下一步可走)→ 正常亮度;其余 → **变暗**。
- 每个状态列出**本层声明的**出边(群行的边即群边),**带事件名**,target 显示**编译后的完整落点**(含群 initial 下钻):`├─ EVENT ─▶ working.waiting`。
- 群的「当前/走过/边走过」按群内任一子状态判定;当前在群内时,群边为正常亮度(可走)。
- 末尾一行轨迹(叶子状态):`trail: idle → working.creating → working.waiting`。

效果示意(当前在 `working.waiting`):

```
○ idle  [initial]                      ← 绿(走过)
  └─ SUBMIT ─▶ working.creating

● working  [群]                        ← 加粗(当前在群内)
  └─ CANCEL ─▶ idle                    ← 正常亮度(可走,群边)

  ○ creating  [initial]                ← 绿(走过)
    ├─ CREATED ─▶ working.waiting
    └─ CREATE_FAILED ─▶ working.failed ← 暗(没走这条)
  ● waiting                            ← 加粗(当前)
    ├─ POLL_OK ─▶ done
    └─ POLL_FAIL ─▶ working.failed
  ○ failed                            ← 暗(整块)
    └─ RETRY ─▶ working.creating
○ done

trail: idle → working.creating → working.waiting
```

从 `history` 推导「走过的状态」和「走过的边」,不要另存一份状态。

### 两种"看见":ASCII 管运行期,mermaid 管设计期

machine.json 内容少时直接可读;状态和事件多了以后,**以生成的图为主要阅读入口**。设计期出图**不放在逻辑代码里**——skill 自带 `scripts/machine-to-mermaid.mjs`,接受 json 路径,输出 mermaid `stateDiagram-v2`(群画成复合状态、`[*]` 标 initial、群边从群出发)。分工:

- **ASCII render(运行期)**:随每次转移刷新,带当前/走过高亮和 trail——回答"这次跑到哪了"。
- **mermaid(设计期)**:结构文档,给评审和未来的自己——回答"这个脚本长什么样"。

两者都是**生成物**,源永远只有 machine.json——图不被维护,而是被生成,永不过期。

用法(与项目语言无关,Java / Go / Python 项目同样适用):

```bash
node <skill>/scripts/machine-to-mermaid.mjs path/to/machine.json
```

输出粘进 README 的 ```` ```mermaid ```` 块、PR 描述或 [mermaid.live](https://mermaid.live) 即渲染。脚本零依赖单文件,项目想在 CI 里常驻生成时直接拷进 repo 即可。

```
stateDiagram-v2
  state "idle" as s0
  state "working" as s1 {
    state "creating" as s2
    ...
    [*] --> s2
  }
  [*] --> s0
  s0 --> s1 : SUBMIT
  s1 --> s0 : CANCEL
```

(节点 id 用 s0/s1… 序号、显示名走 alias——路径直接替换成 id 不是一一映射,`a_b` 与 `a.b` 会碰撞,且状态名含特殊字符时会产出非法 id。)

---

## 第 4 步:actions 承载业务(普通 async 函数)

生成脚手架后,在 `main` 里演示用法:

```
const job = createMachine(machine, 'job')
const report = createMachine(reportMachine, 'report') // 并行区域 = 再开一台

async function submit(payload) {
  // 先拿到推进权再做副作用(被拒时副作用不得发出)→ working.creating(进群落到 initial)
  if (!job.transition('SUBMIT', payload).accepted) return
  const ok = await doCreate()                        // 副作用在函数里,控制流一眼可见
  job.transition(ok ? 'CREATED' : 'CREATE_FAILED')   // 结果是显式事件
}

function cancel() {
  job.transition('CANCEL')   // 群边:working 群内任何子状态都能取消
}

async function publish() {
  // 跨区域 guard:读另一台机器的状态
  if (job.state !== 'done') return console.warn(`publish 被拒(job 还在 ${job.state})`)
  report.transition('UPLOAD')
  ...
}
```

---

## 持久化状态:长生命周期实体(后端/服务)

机器不总是从 initial 活到进程结束。状态存在数据库里的实体(邀请、订单、任务)每个请求只苏醒一次:

- **`resolveState(persistedState)`**(名字取自 xstate)把持久化状态解析回机器,trail 从解析点开始。
- **编译一次,实例多次**:machine(编译产物)进程内共享,每次请求 `spawn` / `resolveState` 一个实例;禁止每请求重新解析定义。
- **action = 端点 / 用例函数**,形状固定:
  `resolveState(状态) → can(EVENT) guard(拒绝时走该端点原有的错误码)→ CAS 占位(UPDATE ... WHERE version = 旧值,抢到执行权)→ 副作用(确定性幂等键)→ transition(EVENT) → 用落点 result.current CAS 写回`
  ——不手写目标状态,落点由定义决定。
- **多写者铁律:`can` 通过 ≠ 拿到执行权。** 两个请求会同时读到同一版本、同时过 can、同时执行副作用——进程内的机器只能拒绝状态变更,拒绝不了已发出的副作用。所以副作用之前必须先用数据库 version CAS 占位(`affected = 1` 者才许调外部服务),副作用本身用确定性幂等键防重放;CAS 管执行权、幂等键管重复 RPC,两者不能互相替代。完整示例见仓库 `playground/play-layered.ts`。
- **反模式:在通用的 `update(target)` 持久化层做 (prev, target) 反查白名单。** 那是"问去哪":持久化层只知道目标不知道事件,guard 必须放在知道"发生了什么"的层(端点/用例)。

## xstate 对照表(翻译到其他语言时抄经典命名)

| skill 概念 | xstate 对应 |
|------|------|
| 编译定义 | `createMachine` |
| `transition(EVENT)` | `actor.send({ type })` |
| `can(EVENT)` | `state.can(event)` |
| 持久化状态解析 | `machine.resolveState(...)` |
| 落点叶子 | `state.value` |
| 群 / 并行区域 | compound state / parallel state |
| 编译产物 vs 实例 | machine vs `createActor` / spawn |

---

## 升级阶梯(长大了怎么办)

- 同一个条件被多个 action 引用、忘了检查会出事 → 把条件升为机器里的**命名 guard**;需要 history state、延迟转移、更深的嵌套 → 考虑直接换 [XState](https://stately.ai/docs)(定义格式本就同形,迁移成本低)。
- 脚本长成了 web 服务(并发、数据库、审计)→ 见仓库根目录的文章《动作游戏、web 与状态机》与 `playground/`(version CAS、幂等键、能力求值的完整版)。

---

## 验证

- 跑一遍 `main` 段(编译/直接执行),肉眼确认 ASCII 图的「事件名 + 群缩进 + 绿/加粗/暗 + trail」符合规范。
- 确认进群事件落到群的 `initial`(如 `SUBMIT: idle → working.creating`)。
- 触发一次**群边**(如在群内任意子状态 CANCEL),确认落点正确、群行的边变绿。
- 触发一次非法事件(当前状态下没有这条边),确认走 Invalid 通道、不崩。
- 检查每个有副作用的 action:副作用必须在 `accepted` / `can()` 确认**之后**执行(转移被拒时副作用不得发出)。
- 若有并行区域:确认两台机器各自渲染、互不干扰,跨区域 guard 生效。
- 跑一次 `scripts/machine-to-mermaid.mjs`,输出粘进 mermaid 渲染器(或 markdown 预览)确认可渲染、群与边完整。
- 持久化场景:`resolveState` 后 trail 从解析点开始;action 用落点驱动持久化,没有手写的目标状态。
- 对照判断闸门再确认一次:这个脚本确实有真状态,而不是被硬套的线性管道。
