# playground 心路历程:一个 invoice 状态机的六次重写

同一个发票业务(支付 / 风控 / 重试 / 退款 / 超时关单 / 宕机恢复),我们用状态机重写了六遍。每一遍其实都在回答同一个问题——**异步的业务逻辑应该放在哪里**。最终答案:不放在状态机里。

这是《动作游戏、web 与状态机:转移是枚举的,还是计算的?》一文的实验记录。所有文件都可直接运行:`node playground/<file>.ts`(Node ≥ 23.6)。

## 路线图

| 站 | 文件 | 形态 | 回答的问题 |
|---|---|---|---|
| 1 | `play-xstate.ts` | xstate 全包,invoke 编排 | 框架怎么用?服务器环境怎么办? |
| 2 | `play-actions.ts` | 动作索引,零框架 | 太复杂了,按"一个动作一个对象"组织行不行? |
| 3 | `play-hybrid.ts` | 状态索引 + 边上带 run / 多落点 | 能不能保留 statechart 组织,又把业务放回边上? |
| 4 | `play-xstate-sugar.ts`(v1,已被 v2 覆盖) | 40 行编译器 → xstate | xstate 装得下我的语法吗? |
| 5 | `play-layered.ts` | machine(mutation)+ actions,自制引擎 | 顿悟:同步图与异步编排分层 |
| 6 | `play-xstate-sugar.ts`(v2,现存) | 同上分层,xstate 做第 1 层 + parallel | 最终形态 |

---

## 第 1 站:play-xstate.ts —— 把一切交给框架

从"用 statechart 建模发票"开始,这个文件自己就经历了四个小版本:

1. **常驻 actor**:每张发票一个内存 actor。立刻撞上服务器现实——controller 进来时没有常驻 actor 给你调用。
2. **每请求重建**:`SELECT 行 → machine.resolveState(行) → 判定 → CAS 写回 → 丢弃`。机器降格为**无状态的纯求值器**,事实只有一份,在数据库的行里。附带收获:`dispatch` 和 `callback` 不需要两套判定——can 只有一份(机器的边 + guard),差别只是"被拒"的 HTTP 语义(用户操作回 4xx + 原因,webhook 回 ACK 200 防渠道重试)。
3. **invoke 编排**:读了 xstate 文档,把风控和扣款做成 `invoke` 状态(`checking` / `charging`),onDone/onError 驱动转移。摩擦随之而来:`resolveState` 恢复的快照**不会**重启 invoke(那是完整持久化快照的能力),恢复任务只好加 `RESUME` 自转移(`reenter: true` 重启 invocation);attempts 自增必须从 entry 挪到入边,否则重入会改变幂等键。
4. **三防线硬化**:
   - **version CAS 防 ABA**:status 会回头(`pending → checking → 风控拒绝 → pending`),按 status 比较的 CAS 会误成功;version 单调递增,永不回头。
   - **hierarchy 按不变量重划**:`processing.failed` + 过期后无路可走(RETRY 被 guard 挡、CLOSE 只在 pending 上)。病因是群划错了——**状态群的边界应该是共享的不变量(资金结局未知),不是业务叙事(支付流程)**。群划错的症状就是死角。
   - **幂等键**:CAS 管"谁有权推进状态",管不了"同一副作用只生效一次"。幂等键从 `(id, 第几次尝试)` 确定性导出——宕机重放同一次尝试,天然同 key,渠道去重。

**本站结论**:防线分三道,各管各的——guard/can 管合法性,version CAS 管推进权,幂等键管副作用。但业务逻辑被 invoke 拆得七零八落,读一个"支付"要跨 guard、两个 invoke 状态、onDone 分支拼起来。

## 第 2 站:play-actions.ts —— 按动作组织

"这太复杂了。一个用户动作就是:guard 判断能不能、核心业务逻辑、switch 结果到状态。"于是按动作组织:

```ts
PAY: {
  from: ['pending'],           // 边的出发点(声明)
  guard: [...],                // 准入 + 拒绝原因
  claim: ...,                  // 副作用前 CAS 占位
  run: async (c) => {...},     // 业务,return 就是 switch
  outcomes: ['pending', 'processing'],  // 落点白名单,fail-fast
}
```

executor 40 行,对所有动作一视同仁。**学到三件事**:

- **索引方式跟着查询方向走**(文章第 7 节的代码版):拉模式的请求以动作进门,动作索引读起来顺;"pending 时能发生什么"反而要扫全表。
- **状态数没有变少**:in-flight 状态(charging)没消失——宕机恢复本质上需要知道"死在哪一步",这个复杂度是问题固有的,xstate 只是把它画了出来。
- `from/outcomes` + fail-fast 就是文章 10.1/10.2 的元数据声明 + 收口点;图从元数据生成(10.3)。**绕了 xstate 一圈,回到了文章第三档的设计,这次带着理由。**

## 第 3 站:play-hybrid.ts —— 状态索引 + 边上带 run

但 statechart 的组织(parent、concurrency)确实好。想要的效果:

```ts
pending: {
  on: {
    PAY: { guard, claim, target: ['processing.waiting', 'pending'], run: payCore },
  },
}
```

自制 80 行引擎实现了它。**Vuex 类比在此成型**:run = action(异步编排),引擎最后的 CAS 提交 = mutation(同步、纯、唯一改状态处),target[] = mutation 的合法落点声明;没有 run 的边 = 纯 mutation。父级边显示了实战价值:PSP webhook 挂在 processing 父级,**早到的 webhook(行还停在 charging)也接得住**。

## 第 4 站:play-xstate-sugar.ts v1 —— xstate 装得下吗?

"xstate 能实现我的需求吗,还是我想错了?"写了个 40 行的 `compile()`,把上面的语法原样编译成 xstate(自动生成 `pending__PAY` in-flight 状态 + onDone 按 run 返回值分支)。**两个认知升级**:

1. **async 放边上必然坍缩成一个中间状态**。xstate 拒绝"边上的 run"不是 API 偷懒,是语义承诺:转移瞬时,机器任何时刻(包括 async 进行中)必须处于确定状态。而 hybrid 的 `claim` 占位就是那个中间状态——只是写在配置里而不是画在图上。**两者同构,编译器是同构的构造证明。**
2. **"一个事件多种落点"可以换元消解**:区分命令与事实。PAY 是命令,"风控拒绝""扣款受理"是事实;每个事实自成事件,一事件一落点就回来了,审计日志还多出 `RISK_DENIED` 这一行。

顺带发现:Vuex 类比 xstate 自己也遵守——transition = mutation,invoked actor = action。它没有乱拆,只是把"action 进行中"表示为状态而不是边属性。

## 第 5 站:play-layered.ts —— 顿悟:分层

"是我过分想把同步的状态定义和异步逻辑合在一起,才怎么搞都不太对。"拆成两层:

- **第 1 层 machine(state + mutation)**:纯数据的图 + 同步校验 + version CAS。`commit()` 是唯一的 mutation。因为纯,图可直接生成、可模型检查、每次 commit 天然是审计日志。**这一层就是本仓库 skill 的形态(machine.json + 纯转移引擎)——从 skill 出发绕一大圈,底层回到了它。**
- **第 2 层 actions**:`guard` 是能力求值(`isPayable = canFire(row,'PAY')`,单源,GET 直接亮按钮),`run` 随便 async,每步进展发 mutation。

**多落点问题自动消解**(结果事件化不用刻意做,分层做完它自己发生);**入口二分**变干净:用户 API → action(命令),渠道 webhook → 直达 mutation(事实)。四条纪律:action guard 只准引用 canFire 不许复述;commit 是唯一改状态口;in-flight 状态留在图上;恢复也是 action。

## 第 6 站:play-xstate-sugar.ts v2 —— 最终形态

分层架构 + xstate 做第 1 层。因为机器里没有 async,**第 1 站的全部框架摩擦(invoke 拆散、RESUME reenter、resolveState 坑)消失**,换回三样净收益:hierarchy、`snap.can`、Stately 可视化。再加两个建模精炼:

- **删掉 pay_failed**:成功/失败是"一次尝试(attempt)"的属性,不是发票的属性。PSP_FAIL 只是送发票回 pending,重试 = 再 PAY 一次。这和"expired 不是状态"是同一条原则:**想清楚一个事实归属于谁,再决定它是不是状态。**
- **refund 是并行区域**:payment ∥ refund 各自演化,payment 在退款全程诚实地停在 `paid`;"能不能退"用跨区域 guard(`stateIn('#invoice.payment.paid')`)表达;"已退款"是 `refund.done` 的派生显示。

至此 Stately 那句话里的三个特性凑齐且各干正事:hierarchy(processing 群)、concurrency(payment ∥ refund)、guard(含跨区域 stateIn);communication ≈ webhook 事件。

---

## 全程幸存的原则(每一版都保留的不变量)

1. **expired 不是状态**:判断权永远归求值(精确、无延迟),记录权才可给物化;状态可以缓存,时间窗口的判定不能缓存。
2. **展示状态是派生物**:`displayStatus = f(state, context, now)`,单一 selector,算好下发;同一个 `now ≥ expiresAt` 在不同 state 下含义不同。
3. **规则单源**:`RULES` 只有一份,guard、拒绝原因、展示层共用;规则漂移是能力模型的头号腐化路径(SQL 复述、两层 guard 互相复述、各端各自实现)。
4. **commit 是唯一改状态的口**:can 校验 → 纯 transition → 落库;生产版落库带 version CAS(防 ABA)+ 幂等键(防重放双扣),粗筛 SQL 只用稳定条件。
5. **事实归属决定状态形状**:失败属于尝试,过期属于时刻,退款属于正交区域——归属想错,状态图就会爆炸或出死角。
6. **群与区域的边界 = 共享不变量 / 正交关注点**,不是业务叙事。
7. **图不被维护,而是被生成**;每次 mutation 是一行审计日志,run 的结果是显式事件。
8. **机器保持同步纯净,异步编排在 actions 层**——这是整场探索的最终答案。

## 与文章的对应

- 第 5 节的阶梯(纯 FSM → statechart → 能力模型):第 2 站是第三档,第 6 站证明第二档与第三档可以分层共存——**statechart 当 mutation 校验器,能力/编排层当 action**。
- 第 7 节推/拉:第 2 站的"索引方式跟着查询方向走"是它的代码版。
- 第 9 节判断权/记录权:全程原则 1、2。
- 第 10 节三层口诀(逻辑在求值、形状在元数据、事实在日志):第 5、6 站的 commit + 显式结果事件 + 生成图,就是它的完整落地。
