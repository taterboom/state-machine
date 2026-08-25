// ============================================================
// invoice × 动作中心(action-centric)组织 —— 与 play-xstate.ts 同一业务
// 对应《动作游戏、web 与状态机:转移是枚举的,还是计算的?》第三档:能力模型
//
// 组织原则:一个用户动作 = 一个对象,从上往下一口气读完 ——
//   from     这条边从哪些状态出发(结构前提,纯数据,可生成图/亮按钮)
//   guard    准入条件(便宜、纯,可报拒绝原因)
//   claim    副作用前的 CAS 占位(防双扣的互斥锁,可选)
//   run      核心业务逻辑(RPC 随便调,顺序写),return 就是"switch 结果 → 落点"
//   outcomes 声明可能落到哪些状态(纯数据;executor 对 run 的返回 fail-fast 校验)
//
// 没有状态机框架:状态是 DB 里的一列字符串,"机器"只是一个 40 行的
// executor,对所有动作执行同一套:from → guard → claim → run → 落库。
// 图不再驱动运行,而是从 from/outcomes 元数据【生成】(见文末 renderGraph)。
//
// 与 play-xstate.ts 的对照点,见文件末尾的注释块。
//
// 运行:node playground/play-actions.ts   (Node ≥ 23.6 原生跑 TS)
// ============================================================

const MIN = 60_000
const DAY = 24 * 60 * MIN

// 假时钟:now 永远显式传入
let NOW = Date.parse('2026-08-24T14:00:00Z')
const advance = (ms: number, label: string) => {
  NOW += ms
  console.log(`\n⏰ 时间推进 ${label} → ${new Date(NOW).toISOString()}`)
}

// ------------------------------------------------------------
// 1. 状态与规则。状态是拍平的字符串;"资金结局未知"的不变量现在体现为:
//    charging / processing / refund_calling / refunding 不出现在任何
//    用户动作的 from 里 —— 群不变量变成了"入边名单上没有你"。
// ------------------------------------------------------------
type Status =
  | 'pending' // 待支付(稳定)
  | 'charging' // 扣款请求在途(宕机恢复的落脚点)
  | 'processing' // 已受理,等 webhook(稳定)
  | 'pay_failed' // 扣款失败(稳定,可重试/可关单)
  | 'paid'
  | 'refund_calling' // 退款请求在途
  | 'refunding' // 已受理,等 webhook
  | 'refund_failed'
  | 'refunded'
  | 'closed'

type Ctx = {
  id: string
  amountYen: number
  expiresAt: number
  attempts: number
  refundAttempts: number
  paidAt: number | null
}

const MAX_ATTEMPTS = 3
const REFUND_WINDOW = 90 * DAY

const RULES = {
  notExpired: (c: Ctx, now: number) => now < c.expiresAt,
  isExpired: (c: Ctx, now: number) => now >= c.expiresAt,
  retriesLeft: (c: Ctx) => c.attempts < MAX_ATTEMPTS,
  refundWindowOpen: (c: Ctx, now: number) =>
    c.paidAt !== null && now - c.paidAt <= REFUND_WINDOW,
}

// ------------------------------------------------------------
// 2. 假的第三方。幂等键规则同 play-xstate.ts:
//    新的一次业务尝试 = 新 key(attempts 在 claim 时自增);
//    同一次尝试的重发(宕机恢复)= 同 key,stripe 去重。
// ------------------------------------------------------------
const stripeSeen = new Set<string>()

const riskService = {
  async check(c: Ctx) {
    const ok = c.amountYen < 1_000_000
    console.log(`   ☎ riskService.check(${c.id}) → ${ok ? '通过' : '拒绝(大额触发人工审核)'}`)
    return { ok }
  },
}
const stripe = {
  async call(kind: 'charge' | 'refund', key: string, c: Ctx) {
    if (stripeSeen.has(key)) {
      console.log(`   ☎ stripe.${kind} key=${key} → 幂等命中:该请求已受理过,不重复执行`)
      return
    }
    stripeSeen.add(key)
    console.log(`   ☎ stripe.${kind}(${c.id}, ¥${c.amountYen}) key=${key} → 已受理,结果将由 webhook 通知`)
  },
}
const chargeKey = (c: Ctx) => `${c.id}:charge:${c.attempts}`
const refundKey = (c: Ctx) => `${c.id}:refund:${c.refundAttempts}`

// ------------------------------------------------------------
// 3. 动作表:一个动作一个对象,guard / 业务 / 结果落点都在眼前
// ------------------------------------------------------------
type Outcome = { to: Status; patch?: Partial<Ctx>; note?: string }
type ActionDef = {
  from: Status[] // 边的出发点(声明)
  guard?: [string, (c: Ctx, now: number) => boolean][] // 准入 + 拒绝原因
  claim?: (c: Ctx) => Outcome // 副作用前的占位(可选)
  run: (c: Ctx, now: number) => Promise<Outcome> // 业务逻辑 + "switch 结果"
  outcomes: Status[] // 可能的落点(声明,executor 据此 fail-fast)
}

const ACTIONS: Record<string, ActionDef> = {
  // —— 用户动作 ——
  PAY: {
    from: ['pending'],
    guard: [['尚未过期', RULES.notExpired]],
    claim: (c) => ({ to: 'charging', patch: { attempts: c.attempts + 1 } }), // 占位 + 计一次新尝试
    async run(c, now) {
      if (!(await riskService.check(c)).ok) return { to: 'pending', note: '403 风控拒绝' }
      await stripe.call('charge', chargeKey(c), c)
      return { to: 'processing' } // 受理成功 → 等 webhook
    },
    outcomes: ['pending', 'processing'],
  },
  RETRY: {
    from: ['pay_failed'],
    guard: [
      ['尚未过期', RULES.notExpired],
      ['重试次数未用尽', RULES.retriesLeft],
    ],
    claim: (c) => ({ to: 'charging', patch: { attempts: c.attempts + 1 } }),
    async run(c) {
      await stripe.call('charge', chargeKey(c), c) // 风控按单只评一次,重试直进扣款
      return { to: 'processing' }
    },
    outcomes: ['processing'],
  },
  CLOSE: {
    from: ['pending', 'pay_failed'], // pay_failed 也能关:没有"无路可走"的死角
    guard: [['已经过期', RULES.isExpired]],
    async run() {
      return { to: 'closed' }
    },
    outcomes: ['closed'],
  },
  REFUND: {
    from: ['paid'],
    guard: [['退款窗口内(90 天)', RULES.refundWindowOpen]],
    claim: (c) => ({ to: 'refund_calling', patch: { refundAttempts: c.refundAttempts + 1 } }),
    async run(c) {
      await stripe.call('refund', refundKey(c), c)
      return { to: 'refunding' }
    },
    outcomes: ['refunding'],
  },
  RETRY_REFUND: {
    from: ['refund_failed'],
    claim: (c) => ({ to: 'refund_calling', patch: { refundAttempts: c.refundAttempts + 1 } }),
    async run(c) {
      await stripe.call('refund', refundKey(c), c)
      return { to: 'refunding' }
    },
    outcomes: ['refunding'],
  },

  // —— 渠道 webhook(也是动作,只是没有 guard/claim,纯粹"事实到达")——
  // from 里带上在途状态:webhook 比恢复任务先到也能正确落账
  PSP_OK: {
    from: ['charging', 'processing'],
    async run(_c, now) {
      return { to: 'paid', patch: { paidAt: now } }
    },
    outcomes: ['paid'],
  },
  PSP_FAIL: {
    from: ['charging', 'processing'],
    async run() {
      return { to: 'pay_failed' }
    },
    outcomes: ['pay_failed'],
  },
  REFUND_OK: {
    from: ['refund_calling', 'refunding'],
    async run() {
      return { to: 'refunded' }
    },
    outcomes: ['refunded'],
  },
  REFUND_FAIL: {
    from: ['refund_calling', 'refunding'],
    async run() {
      return { to: 'refund_failed' }
    },
    outcomes: ['refund_failed'],
  },

  // —— 恢复动作(宕机后重放同一次尝试;key 不变,stripe 幂等去重)——
  RESUME_CHARGE: {
    from: ['charging'],
    async run(c, now) {
      // charging 占位可能发生在风控完成之前——恢复必须从风控边界起重放,
      // 直接扣款会绕过风控。风控是只读查询可重复;扣款靠同 key 幂等去重
      if (!(await riskService.check(c)).ok) return { to: 'pending', note: '恢复时风控拒绝' }
      await stripe.call('charge', chargeKey(c), c)
      return { to: 'processing' }
    },
    outcomes: ['pending', 'processing'],
  },
  RESUME_REFUND: {
    from: ['refund_calling'],
    async run(c) {
      await stripe.call('refund', refundKey(c), c)
      return { to: 'refunding' }
    },
    outcomes: ['refunding'],
  },
}

const USER_ACTIONS = ['PAY', 'RETRY', 'CLOSE', 'REFUND', 'RETRY_REFUND'] as const
const WEBHOOKS = new Set(['PSP_OK', 'PSP_FAIL', 'REFUND_OK', 'REFUND_FAIL'])

// ------------------------------------------------------------
// 4. 数据库:同 play-xstate.ts,version CAS(乐观锁,防 ABA)
// ------------------------------------------------------------
type Row = Ctx & { status: Status; version: number }
const table = new Map<string, Row>()

const db = {
  insert(row: Row) {
    table.set(row.id, { ...row })
  },
  find(id: string): Row {
    return { ...table.get(id)! } // 副本:模拟"每个请求各自读库"
  },
  // UPDATE ... SET status=:to, version=version+1, ... WHERE id=:id AND version=:expected
  cas(id: string, expectedVersion: number, to: Status, patch: Partial<Ctx> = {}): number {
    const r = table.get(id)
    if (!r || r.version !== expectedVersion) return 0
    Object.assign(r, patch, { status: to, version: r.version + 1 })
    return 1
  },
  select(statuses: Status[], pred: (r: Row) => boolean): Row[] {
    return [...table.values()].filter((r) => statuses.includes(r.status) && pred(r))
  },
}

// ------------------------------------------------------------
// 5. executor:唯一的执行管道,40 行,对所有动作一视同仁
// ------------------------------------------------------------
async function execute(id: string, name: string, now: number) {
  const a = ACTIONS[name]
  const row = db.find(id)

  // ① 结构前提:这条边存在吗(from 声明)
  if (!a.from.includes(row.status)) {
    if (WEBHOOKS.has(name)) console.log(`   • ${id} 回调 ${name} 被忽略(当前 ${row.status}),ACK 200`)
    else console.log(`   ✗ 400 ${id} ${name}:状态 ${row.status} 下没有这条边`)
    return
  }
  // ② 准入 guard(可报原因)
  const failing = (a.guard ?? []).find(([, rule]) => !rule(row, now))
  if (failing) {
    console.log(`   ✗ 400 ${id} ${name}:不满足条件「${failing[0]}」`)
    return
  }
  // ③ 占位(可选):副作用前 CAS 到 in-flight 状态,抢到行才有资格调第三方
  let version = row.version
  let ctx: Ctx = row
  if (a.claim) {
    const c = a.claim(ctx)
    if (db.cas(id, version, c.to, c.patch) === 0) {
      console.log(`   ⚠ 409 ${id} ${name}:CAS affected=0,行已被别人推进`)
      return
    }
    console.log(`   ✓ ${id} ${name}:${row.status} → ${c.to}(已占位)`)
    version += 1
    ctx = { ...ctx, ...c.patch }
  }
  // ④ 核心业务,返回值就是"switch 结果 → 落点"
  const outcome = await a.run(ctx, now)
  // ⑤ fail-fast:落点必须在声明的 outcomes 里(声明与实现不许漂移)
  if (!a.outcomes.includes(outcome.to)) {
    throw new Error(`UndeclaredTransition: ${name} 想落到 ${outcome.to},声明里没有`)
  }
  // ⑥ 结果落库(从占位后的 version 继续 CAS)
  if (db.cas(id, version, outcome.to, outcome.patch) === 0) {
    console.log(`   ⚠ ${id} ${name} 落库 CAS affected=0(行已被别人推进)`)
    return
  }
  console.log(`   ✓ ${id} ${name} 稳定于:${outcome.to}${outcome.note ? `(${outcome.note})` : ''}`)
}

// ------------------------------------------------------------
// 6. 查询侧:按钮亮灭、展示状态 —— 都是对 (事实, now) 的派生
// ------------------------------------------------------------
function availableActions(row: Row, now: number): string[] {
  return USER_ACTIONS.filter((name) => {
    const a = ACTIONS[name]
    return a.from.includes(row.status) && (a.guard ?? []).every(([, rule]) => rule(row, now))
  })
}

function displayStatus(row: Row, now: number): string {
  switch (row.status) {
    case 'pending':
      return RULES.isExpired(row, now) ? 'EXPIRED(已过期)' : 'AWAITING_PAYMENT(待支付)'
    case 'charging':
    case 'processing':
      return 'PROCESSING(支付处理中)'
    case 'pay_failed':
      if (RULES.isExpired(row, now)) return 'EXPIRED(已过期)'
      return RULES.retriesLeft(row) ? 'PAY_FAILED(支付失败,可重试)' : 'PAY_FAILED(支付失败)'
    case 'paid':
      return 'PAID(已支付)'
    case 'refund_calling':
    case 'refunding':
      return 'REFUNDING(退款中)'
    case 'refund_failed':
      return 'REFUND_FAILED(退款遇到问题)'
    case 'refunded':
      return 'REFUNDED(已退款)'
    case 'closed':
      return 'CLOSED(已关闭)'
  }
}

// ------------------------------------------------------------
// 7. 两个机器人:走同一个 execute,规则单源
// ------------------------------------------------------------
async function timeoutCloseJob(now: number, name = 'robot') {
  const candidates = db.select(['pending', 'pay_failed'], (r) => r.expiresAt <= now) // 粗筛
  console.log(
    `\n🤖 ${name} 粗筛:SELECT ... WHERE status IN ('pending','pay_failed') AND expires_at <= now → [${
      candidates.map((r) => r.id).join(', ') || '空'
    }]`,
  )
  for (const row of candidates) await execute(row.id, 'CLOSE', now)
}

async function recoverInFlightJob(now: number, name = 'recovery') {
  const stuck = db.select(['charging', 'refund_calling'], () => true)
  console.log(`\n🛠 ${name} 扫描 in-flight 行 → [${stuck.map((r) => r.id).join(', ') || '空'}]`)
  for (const row of stuck)
    await execute(row.id, row.status === 'charging' ? 'RESUME_CHARGE' : 'RESUME_REFUND', now)
}

// ------------------------------------------------------------
// 8. 图从元数据生成:from × action → outcomes(文章 10.3)
// ------------------------------------------------------------
function renderGraph() {
  console.log('\n📈 状态图(由 ACTIONS 的 from/outcomes 生成,永不过期):')
  for (const [name, a] of Object.entries(ACTIONS)) {
    for (const from of a.from) {
      const guard = a.guard?.map(([label]) => label).join(' && ')
      console.log(`   ${from} --${name}${guard ? `[${guard}]` : ''}--> ${a.outcomes.join(' | ')}`)
    }
  }
}

// ------------------------------------------------------------
// 建单 + 观察
// ------------------------------------------------------------
function createInvoice(id: string, amountYen: number, ttlMs: number) {
  db.insert({
    id,
    status: 'pending',
    version: 0,
    amountYen,
    expiresAt: NOW + ttlMs,
    attempts: 0,
    refundAttempts: 0,
    paidAt: null,
  })
  console.log(`\n🧾 创建 ${id}:¥${amountYen},${new Date(NOW + ttlMs).toISOString()} 过期`)
}

function show(id: string, now: number) {
  const row = db.find(id)
  console.log(
    `   ${id} │ DB 行 = ${row.status}(v${row.version}) │ GET 下发 = ${displayStatus(row, now)} │ 按钮 = [${availableActions(row, now).join(', ') || '无'}]`,
  )
}

// ============================================================
// 演出:与 play-xstate.ts 相同的剧目
// ============================================================
const h = (t: string) => console.log(`\n${'─'.repeat(64)}\n■ ${t}`)

h('① 支付:guard → 占位 → 风控 → 扣款 → 落点,一个 PAY 对象从上读到下')
createInvoice('inv_1', 12800, 30 * MIN)
await execute('inv_1', 'PAY', NOW)
show('inv_1', NOW)
await execute('inv_1', 'PSP_FAIL', NOW)
show('inv_1', NOW)
await execute('inv_1', 'RETRY', NOW) // 新尝试 = 新幂等键(…:charge:2)
await execute('inv_1', 'PSP_OK', NOW)
show('inv_1', NOW)

h('② 风控拒绝 ≠ 非法转移:run 的返回就是那个 switch —— 退回 pending')
createInvoice('inv_3', 5_000_000, 30 * MIN)
await execute('inv_3', 'PAY', NOW)
show('inv_3', NOW) // status 回到 pending,version 已前进(ABA 防线同前)

h('③ 宕机恢复:占位 + 扣款请求已发出,进程挂了;恢复重放同一次尝试,幂等命中')
createInvoice('inv_4', 9800, 30 * MIN)
{
  // 手工重演 execute 的 ①②③④ 中途:占位、调 stripe,然后"宕机"(不落库)
  const row = db.find('inv_4')
  const claimed = ACTIONS.PAY.claim!(row)
  db.cas('inv_4', row.version, claimed.to, claimed.patch)
  console.log(`   ✓ inv_4 PAY:${row.status} → ${claimed.to}(已占位)`)
  await stripe.call('charge', chargeKey({ ...row, ...claimed.patch }), row)
  console.log('   💥 宕机:结果没落库,行停在 charging')
}
show('inv_4', NOW)
await recoverInFlightJob(NOW) // 同一次尝试、同一个 key → stripe 幂等命中
await execute('inv_4', 'PSP_OK', NOW)
show('inv_4', NOW)

h('④ 退款:每次重试是新尝试、新幂等键')
advance(10 * DAY, '10 天')
await execute('inv_1', 'REFUND', NOW)
await execute('inv_1', 'REFUND_FAIL', NOW)
show('inv_1', NOW)
await execute('inv_1', 'RETRY_REFUND', NOW)
await execute('inv_1', 'REFUND_OK', NOW)
show('inv_1', NOW)

h('⑤ expired 是派生视图;重复 webhook 被 ACK;过期后重试被 guard 拒绝')
createInvoice('inv_2', 5600, 30 * MIN)
await execute('inv_2', 'PAY', NOW)
await execute('inv_2', 'PSP_FAIL', NOW)
await execute('inv_2', 'PSP_FAIL', NOW) // 重复 webhook → ACK
advance(31 * MIN, '31 分钟(越过 inv_2 的过期线)')
show('inv_2', NOW)
await execute('inv_2', 'RETRY', NOW)

h('⑥ 超时关单(pay_failed 也能关)+ 幂等重跑')
await timeoutCloseJob(NOW, 'robot-A')
show('inv_2', NOW)
await timeoutCloseJob(NOW, 'robot-A')

renderGraph()

// ============================================================
// 与 play-xstate.ts 的对照(同一业务,两种主索引):
//
//   play-xstate.ts   按【状态】组织:状态是家,动作散布在各状态的 on/invoke 里
//   play-actions.ts  按【动作】组织:动作是家,状态退化为 from/outcomes 两列数据
//
//   问"pending 时会发生什么" → xstate 一眼看清;这里要扫全表的 from
//   问"PAY 的完整流程"       → 这里一眼看清;xstate 要跨 guard/invoke/onDone 拼
//
//   web 拉模式的请求天然以"动作"进门(文章第 7 节:入边 + 准入),
//   所以这种组织读起来顺;推模式(游戏/前端交互)以"当前状态"为轴,
//   状态中心的 statechart 才顺。索引方式跟着查询方向走。
// ============================================================
