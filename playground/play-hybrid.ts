// ============================================================
// invoice × 混合形态:statechart 的组织 + 边上的 run/多落点
// 与 play-xstate.ts / play-actions.ts 同一业务,第三种组织方式
//
// 设计(用户提出):
//   pending: {
//     on: {
//       PAY: { guard, claim, target: ['processing.waiting', 'pending'], run: payCore },
//     },
//   }
//   1. 业务逻辑入口(run)直接放在边的配置里;
//   2. 一个事件不固定落到一个 target —— target 是【可能落点的白名单】,
//      run 的返回值现场决定落到哪个;
//   3. 类比 Vuex:run = action(异步编排,可调 RPC);引擎最后的 CAS
//      提交 = mutation(同步、纯、唯一改状态的地方);target[] = mutation
//      的合法落点声明,run 返回声明之外的落点 → fail-fast。
//      没有 run 的边 = 纯 mutation(直接落到 target[0])。
//
// 保留 statechart 的两样好东西:
//   · 状态为主索引:「pending 时能发生什么」一眼看清;
//   · parent 边(hierarchy):群内子状态共享的事件只声明一次
//     (PSP_OK/PSP_FAIL 挂在 processing 父级,charging/waiting 都能接)。
// 引擎只有 ~80 行(findEdge / can / execute / renderGraph)。
// (parallel 区域这里没实现——本业务用不上,思路相同:多列 status。)
//
// 运行:node playground/play-hybrid.ts   (Node ≥ 23.6 原生跑 TS)
// ============================================================

const MIN = 60_000
const DAY = 24 * 60 * MIN

let NOW = Date.parse('2026-08-24T14:00:00Z')
const advance = (ms: number, label: string) => {
  NOW += ms
  console.log(`\n⏰ 时间推进 ${label} → ${new Date(NOW).toISOString()}`)
}

// ------------------------------------------------------------
// 1. 规则单源
// ------------------------------------------------------------
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
// 2. 假的第三方 + 幂等键(同前两版)
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
// 3. 业务核心(run):普通 async 函数,返回值就是"switch 结果 → 落点"
// ------------------------------------------------------------
type Outcome = { to: string; patch?: Partial<Ctx>; note?: string }

async function payCore(c: Ctx, _now: number): Promise<Outcome> {
  if (!(await riskService.check(c)).ok) return { to: 'pending', note: '403 风控拒绝' }
  await stripe.call('charge', chargeKey(c), c)
  return { to: 'processing.waiting' }
}
async function chargeCore(c: Ctx): Promise<Outcome> {
  // 重试/恢复共用:只发扣款(风控按单只评一次;恢复重放同 key,stripe 去重)
  await stripe.call('charge', chargeKey(c), c)
  return { to: 'processing.waiting' }
}
async function refundCore(c: Ctx): Promise<Outcome> {
  await stripe.call('refund', refundKey(c), c)
  return { to: 'refunding.waiting' }
}

// ------------------------------------------------------------
// 4. 机器定义:状态为主索引;边 = guard + claim + target[] + run
// ------------------------------------------------------------
type Edge = {
  guard?: [string, (c: Ctx, now: number) => boolean][]
  claim?: (c: Ctx) => { to: string; patch?: Partial<Ctx> } // 副作用前的占位
  target: string[] // 可能落点的白名单(声明;图由此生成)
  run?: (c: Ctx, now: number) => Promise<Outcome> // 没有 run = 纯 mutation,落 target[0]
}
type StateDef = { on?: Record<string, Edge>; states?: Record<string, StateDef> }

const machine: { id: string; states: Record<string, StateDef> } = {
  id: 'invoice',
  states: {
    pending: {
      on: {
        PAY: {
          guard: [['尚未过期', RULES.notExpired]],
          claim: (c) => ({ to: 'processing.charging', patch: { attempts: c.attempts + 1 } }),
          target: ['processing.waiting', 'pending'], // 一个事件,多种可能落点
          run: payCore,
        },
        CLOSE: { guard: [['已经过期', RULES.isExpired]], target: ['closed'] }, // 纯 mutation
      },
    },
    // 群不变量:资金结局未知。父级的边被所有子状态共享(hierarchy 的本义):
    // PSP webhook 只声明一次,charging(早到的 webhook)和 waiting 都能接
    processing: {
      on: {
        PSP_OK: {
          target: ['paid'],
          run: async (_c, now) => ({ to: 'paid', patch: { paidAt: now } }),
        },
        PSP_FAIL: { target: ['pay_failed'] },
      },
      states: {
        charging: {
          // 宕机恢复:重放同一次尝试(key 不变),只有 charging 里才有这条边
          on: { RESUME: { target: ['processing.waiting'], run: chargeCore } },
        },
        waiting: {}, // 等 webhook,出口全在父级
      },
    },
    pay_failed: {
      on: {
        RETRY: {
          guard: [
            ['尚未过期', RULES.notExpired],
            ['重试次数未用尽', RULES.retriesLeft],
          ],
          claim: (c) => ({ to: 'processing.charging', patch: { attempts: c.attempts + 1 } }),
          target: ['processing.waiting'],
          run: chargeCore,
        },
        CLOSE: { guard: [['已经过期', RULES.isExpired]], target: ['closed'] },
      },
    },
    paid: {
      on: {
        REFUND: {
          guard: [['退款窗口内(90 天)', RULES.refundWindowOpen]],
          claim: (c) => ({ to: 'refunding.calling', patch: { refundAttempts: c.refundAttempts + 1 } }),
          target: ['refunding.waiting'],
          run: refundCore,
        },
      },
    },
    refunding: {
      on: {
        REFUND_OK: { target: ['refunded'] },
        REFUND_FAIL: { target: ['refund_failed'] },
      },
      states: {
        calling: {
          on: { RESUME: { target: ['refunding.waiting'], run: refundCore } },
        },
        waiting: {},
      },
    },
    refund_failed: {
      on: {
        RETRY_REFUND: {
          claim: (c) => ({ to: 'refunding.calling', patch: { refundAttempts: c.refundAttempts + 1 } }),
          target: ['refunding.waiting'],
          run: refundCore,
        },
      },
    },
    closed: {},
    refunded: {},
  },
}

// ------------------------------------------------------------
// 5. 引擎(~80 行):findEdge / can / execute / renderGraph
// ------------------------------------------------------------
function findEdge(status: string, event: string): Edge | undefined {
  const [head, sub] = status.split('.')
  const parent = machine.states[head]
  const child = sub ? parent?.states?.[sub] : undefined
  return child?.on?.[event] ?? parent?.on?.[event] // 子状态优先,父级兜底
}

function can(row: Row, event: string, now: number): true | string {
  const edge = findEdge(row.status, event)
  if (!edge) return `状态 ${row.status} 下没有 ${event} 这条边`
  const failing = (edge.guard ?? []).find(([, rule]) => !rule(row, now))
  return failing ? `不满足条件「${failing[0]}」` : true
}

const WEBHOOKS = new Set(['PSP_OK', 'PSP_FAIL', 'REFUND_OK', 'REFUND_FAIL'])

async function execute(id: string, event: string, now: number) {
  const row = db.find(id)
  // ① 准入:边存在 + guard 通过
  const admit = can(row, event, now)
  if (admit !== true) {
    if (WEBHOOKS.has(event)) console.log(`   • ${id} 回调 ${event} 被忽略(当前 ${row.status}),ACK 200`)
    else console.log(`   ✗ 400 ${id} ${event}:${admit}`)
    return
  }
  const edge = findEdge(row.status, event)!
  // ② 占位(可选):副作用前 CAS 到 in-flight,抢到行才有资格调第三方
  let version = row.version
  let ctx: Ctx = row
  if (edge.claim) {
    const c = edge.claim(ctx)
    if (db.cas(id, version, c.to, c.patch) === 0) {
      console.log(`   ⚠ 409 ${id} ${event}:CAS affected=0,行已被别人推进`)
      return
    }
    console.log(`   ✓ ${id} ${event}:${row.status} → ${c.to}(已占位)`)
    version += 1
    ctx = { ...ctx, ...c.patch }
  }
  // ③ run(action):异步编排;没有 run 的边是纯 mutation,直接落 target[0]
  const outcome = edge.run ? await edge.run(ctx, now) : { to: edge.target[0] }
  // ④ fail-fast:落点必须在 target 白名单里(声明与实现不许漂移)
  if (!edge.target.includes(outcome.to)) {
    throw new Error(`UndeclaredTransition: ${event} 想落到 ${outcome.to},target 声明里没有`)
  }
  // ⑤ 提交(mutation):同步、纯,唯一改状态的地方
  if (db.cas(id, version, outcome.to, outcome.patch) === 0) {
    console.log(`   ⚠ ${id} ${event} 落库 CAS affected=0(行已被别人推进)`)
    return
  }
  console.log(`   ✓ ${id} ${event} 稳定于:${outcome.to}${outcome.note ? `(${outcome.note})` : ''}`)
}

// 图从定义生成:遍历状态树打印每条边(guard 标注在边上)
function renderGraph() {
  console.log('\n📈 状态图(由机器定义生成):')
  const printEdges = (from: string, on?: Record<string, Edge>) => {
    for (const [event, e] of Object.entries(on ?? {})) {
      const guard = e.guard?.map(([label]) => label).join(' && ')
      console.log(`   ${from} --${event}${guard ? `[${guard}]` : ''}--> ${e.target.join(' | ')}`)
    }
  }
  for (const [name, s] of Object.entries(machine.states)) {
    if (s.states) {
      printEdges(`${name}.*`, s.on) // 父级边:群内共享
      for (const [sub, ss] of Object.entries(s.states)) printEdges(`${name}.${sub}`, ss.on)
    } else {
      printEdges(name, s.on)
    }
  }
}

// ------------------------------------------------------------
// 6. 数据库(version CAS,同前)+ 查询侧
// ------------------------------------------------------------
type Row = Ctx & { status: string; version: number }
const table = new Map<string, Row>()

const db = {
  insert(row: Row) {
    table.set(row.id, { ...row })
  },
  find(id: string): Row {
    return { ...table.get(id)! }
  },
  cas(id: string, expectedVersion: number, to: string, patch: Partial<Ctx> = {}): number {
    const r = table.get(id)
    if (!r || r.version !== expectedVersion) return 0
    Object.assign(r, patch, { status: to, version: r.version + 1 })
    return 1
  },
  select(statuses: string[], pred: (r: Row) => boolean): Row[] {
    return [...table.values()].filter((r) => statuses.includes(r.status) && pred(r))
  },
}

const USER_ACTIONS = ['PAY', 'RETRY', 'CLOSE', 'REFUND', 'RETRY_REFUND'] as const

function displayStatus(row: Row, now: number): string {
  const s = row.status
  if (s === 'pending') return RULES.isExpired(row, now) ? 'EXPIRED(已过期)' : 'AWAITING_PAYMENT(待支付)'
  if (s.startsWith('processing')) return 'PROCESSING(支付处理中)'
  if (s === 'pay_failed') {
    if (RULES.isExpired(row, now)) return 'EXPIRED(已过期)'
    return RULES.retriesLeft(row) ? 'PAY_FAILED(支付失败,可重试)' : 'PAY_FAILED(支付失败)'
  }
  if (s === 'paid') return 'PAID(已支付)'
  if (s.startsWith('refunding')) return 'REFUNDING(退款中)'
  if (s === 'refund_failed') return 'REFUND_FAILED(退款遇到问题)'
  if (s === 'refunded') return 'REFUNDED(已退款)'
  return 'CLOSED(已关闭)'
}

function show(id: string, now: number) {
  const row = db.find(id)
  const actions = USER_ACTIONS.filter((a) => can(row, a, now) === true)
  console.log(
    `   ${id} │ DB 行 = ${row.status}(v${row.version}) │ GET 下发 = ${displayStatus(row, now)} │ 按钮 = [${actions.join(', ') || '无'}]`,
  )
}

async function timeoutCloseJob(now: number, name = 'robot') {
  const candidates = db.select(['pending', 'pay_failed'], (r) => r.expiresAt <= now)
  console.log(
    `\n🤖 ${name} 粗筛:SELECT ... WHERE status IN ('pending','pay_failed') AND expires_at <= now → [${
      candidates.map((r) => r.id).join(', ') || '空'
    }]`,
  )
  for (const row of candidates) await execute(row.id, 'CLOSE', now)
}

async function recoverInFlightJob(now: number, name = 'recovery') {
  const stuck = db.select(['processing.charging', 'refunding.calling'], () => true)
  console.log(`\n🛠 ${name} 扫描 in-flight 行 → [${stuck.map((r) => r.id).join(', ') || '空'}]`)
  for (const row of stuck) await execute(row.id, 'RESUME', now)
}

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

// ============================================================
// 演出:同一套剧目
// ============================================================
const h = (t: string) => console.log(`\n${'─'.repeat(64)}\n■ ${t}`)

h('① 支付:一条 PAY 边写完 guard/占位/run/多落点;失败重试同理')
createInvoice('inv_1', 12800, 30 * MIN)
await execute('inv_1', 'PAY', NOW)
show('inv_1', NOW)
await execute('inv_1', 'PSP_FAIL', NOW) // 父级边接住
show('inv_1', NOW)
await execute('inv_1', 'RETRY', NOW)
await execute('inv_1', 'PSP_OK', NOW)
show('inv_1', NOW)

h('② 多落点的意义:同一条 PAY 边,风控拒绝时 run 现场决定落回 pending')
createInvoice('inv_3', 5_000_000, 30 * MIN)
await execute('inv_3', 'PAY', NOW)
show('inv_3', NOW)

h('③ 宕机后 webhook 先到:PSP_OK 挂在 processing 父级,charging 也能接(hierarchy)')
createInvoice('inv_4', 9800, 30 * MIN)
{
  const row = db.find('inv_4')
  const claimed = machine.states.pending.on!.PAY.claim!(row)
  db.cas('inv_4', row.version, claimed.to, claimed.patch)
  console.log(`   ✓ inv_4 PAY:${row.status} → ${claimed.to}(已占位)`)
  await stripe.call('charge', chargeKey({ ...row, ...claimed.patch }), row)
  console.log('   💥 宕机:结果没落库,行停在 processing.charging')
}
await execute('inv_4', 'PSP_OK', NOW) // webhook 比恢复任务先到 → 父级边接住 → paid
show('inv_4', NOW)
await recoverInFlightJob(NOW) // 扫描为空:webhook 已经把行救走了

h('④ 宕机后恢复任务先到:RESUME 重放同一次尝试,幂等命中')
createInvoice('inv_5', 7200, 30 * MIN)
{
  const row = db.find('inv_5')
  const claimed = machine.states.pending.on!.PAY.claim!(row)
  db.cas('inv_5', row.version, claimed.to, claimed.patch)
  console.log(`   ✓ inv_5 PAY:${row.status} → ${claimed.to}(已占位)`)
  await stripe.call('charge', chargeKey({ ...row, ...claimed.patch }), row)
  console.log('   💥 宕机:结果没落库,行停在 processing.charging')
}
await recoverInFlightJob(NOW) // 同一次尝试、同一个 key → stripe 幂等命中
await execute('inv_5', 'PSP_OK', NOW)
show('inv_5', NOW)

h('⑤ 退款:重试是新尝试、新幂等键;webhook 挂在 refunding 父级')
advance(10 * DAY, '10 天')
await execute('inv_1', 'REFUND', NOW)
await execute('inv_1', 'REFUND_FAIL', NOW)
show('inv_1', NOW)
await execute('inv_1', 'RETRY_REFUND', NOW)
await execute('inv_1', 'REFUND_OK', NOW)
show('inv_1', NOW)

h('⑥ expired 是派生视图;过期后重试被 guard 拒;超时关单(pay_failed 也能关)')
createInvoice('inv_2', 5600, 30 * MIN)
await execute('inv_2', 'PAY', NOW)
await execute('inv_2', 'PSP_FAIL', NOW)
advance(31 * MIN, '31 分钟(越过 inv_2 的过期线)')
show('inv_2', NOW)
await execute('inv_2', 'RETRY', NOW)
await timeoutCloseJob(NOW, 'robot-A')
show('inv_2', NOW)
await timeoutCloseJob(NOW, 'robot-A') // 幂等重跑

renderGraph()

// ============================================================
// 三个文件的对照:
//   play-xstate.ts   状态索引,run 被拆成 invoke 状态(框架决定形态)
//   play-actions.ts  动作索引,状态退化为 from/outcomes 两列数据
//   play-hybrid.ts   状态索引 + 边上带 run/target[](本文件)
//
// hybrid 的取舍:
//   ✓ 「pending 时能发生什么」一眼看清(statechart 的好处保留)
//   ✓ 「PAY 的完整链路」也一眼看清(guard/claim/run/落点在同一条边上)
//   ✓ 父级边:群内共享事件只声明一次,还顺手接住了早到的 webhook
//   ✗ 「某个动作从哪些状态可用」要扫全图(action 索引的反向查询变难,
//     和 play-actions 正好互补;renderGraph 可随时生成全貌)
// ============================================================
