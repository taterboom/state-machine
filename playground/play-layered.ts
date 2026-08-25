// ============================================================
// invoice × 分层形态(终点):同步状态图 与 异步业务 彻底分开
//
//   第 1 层 machine(like vuex state + mutation):
//     纯数据的图(邻接 + guard 名),一事件一落点,同步、瞬时。
//     commit() 是唯一的 mutation:canFire 校验 → version CAS 落库。
//     ★ 这一层就是本仓库 skill 的形态:machine 可以原样存成 machine.json。
//
//   第 2 层 actions(like vuex action):
//     业务编排,随便 async、随便调 RPC;每一步进展都通过 commit 发
//     mutation。guard 就是能力求值(isPayable),GET 直接拿去亮按钮。
//
//   入口规则:
//     用户 API   → action(有编排)
//     渠道 webhook → 直接 mutation(事实到达,没有编排,不需要 action)
//
//   收益:run 的每种结果都是显式事件(RISK_DENIED / CHARGE_ACCEPTED),
//   一事件一落点,mutation 日志 = 完整审计轨迹(结果事件化)。
//
// 运行:node playground/play-layered.ts   (Node ≥ 23.6 原生跑 TS)
// ============================================================

const MIN = 60_000
const DAY = 24 * 60 * MIN

let NOW = Date.parse('2026-08-24T14:00:00Z')
const advance = (ms: number, label: string) => {
  NOW += ms
  console.log(`\n⏰ 时间推进 ${label} → ${new Date(NOW).toISOString()}`)
}

// ------------------------------------------------------------
// 0. 规则单源(machine 的 guard 按名引用,action/展示层复用)
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
  retryable: (c: Ctx, now: number) => now < c.expiresAt && c.attempts < MAX_ATTEMPTS,
  refundWindowOpen: (c: Ctx, now: number) =>
    c.paidAt !== null && now - c.paidAt <= REFUND_WINDOW,
}
const GUARD_LABEL: Record<keyof typeof RULES, string> = {
  notExpired: '尚未过期',
  isExpired: '已经过期',
  retryable: '尚未过期且重试次数未用尽',
  refundWindowOpen: '退款窗口内(90 天)',
}

// ------------------------------------------------------------
// 1. 第 1 层:状态机 = 纯数据的图(可以直接存成 machine.json)
//    一事件一落点;"多落点"已被换元成多个结果事件(RISK_DENIED 等)
// ------------------------------------------------------------
type Status =
  | 'pending'
  | 'charging' // 扣款请求在途(in-flight,宕机恢复的落脚点)
  | 'waiting' // 已受理,等 webhook
  | 'pay_failed'
  | 'paid'
  | 'refund_calling'
  | 'refund_waiting'
  | 'refund_failed'
  | 'refunded'
  | 'closed'

type EdgeDef = { guard?: keyof typeof RULES; target: Status }

const machine: { initial: Status; states: Record<Status, Record<string, EdgeDef>> } = {
  initial: 'pending',
  states: {
    pending: {
      PAY: { guard: 'notExpired', target: 'charging' },
      CLOSE: { guard: 'isExpired', target: 'closed' },
    },
    charging: {
      RISK_DENIED: { target: 'pending' }, // run 的结果是显式事件,不藏在返回值里
      CHARGE_ACCEPTED: { target: 'waiting' },
      PSP_OK: { target: 'paid' }, // 早到的 webhook 也接得住
      PSP_FAIL: { target: 'pay_failed' },
    },
    waiting: {
      PSP_OK: { target: 'paid' },
      PSP_FAIL: { target: 'pay_failed' },
    },
    pay_failed: {
      RETRY: { guard: 'retryable', target: 'charging' },
      CLOSE: { guard: 'isExpired', target: 'closed' },
    },
    paid: {
      REFUND: { guard: 'refundWindowOpen', target: 'refund_calling' },
    },
    refund_calling: {
      REFUND_ACCEPTED: { target: 'refund_waiting' },
      REFUND_OK: { target: 'refunded' },
      REFUND_FAIL: { target: 'refund_failed' },
    },
    refund_waiting: {
      REFUND_OK: { target: 'refunded' },
      REFUND_FAIL: { target: 'refund_failed' },
    },
    refund_failed: {
      RETRY_REFUND: { target: 'refund_calling' },
    },
    refunded: {},
    closed: {},
  },
}

// —— 转移引擎:纯校验(同 skill 的契约) ——
function canFire(row: Row, event: string, now: number): true | string {
  const edge = machine.states[row.status]?.[event]
  if (!edge) return `状态 ${row.status} 下没有 ${event} 这条边`
  if (edge.guard && !RULES[edge.guard](row, now)) return `不满足条件「${GUARD_LABEL[edge.guard]}」`
  return true
}

// —— commit = 唯一的 mutation:同步校验 + version CAS 落库(+审计日志) ——
function commit(id: string, event: string, now: number, patch: Partial<Ctx> = {}): boolean {
  const row = db.find(id)
  const admit = canFire(row, event, now)
  if (admit !== true) {
    console.log(`   ✗ ${id} ${event} 被拒:${admit}`)
    return false
  }
  const to = machine.states[row.status][event].target
  if (db.cas(id, row.version, to, patch) === 0) {
    console.log(`   ⚠ 409 ${id} ${event}:CAS affected=0,行已被别人推进`)
    return false
  }
  console.log(`   ✓ ${id} ${event}:${row.status} → ${to}`) // ← 这行就是 transition log
  return true
}

// ------------------------------------------------------------
// 2. 假的第三方 + 幂等键(同前几版)
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
// 3. 第 2 层:actions = 业务编排。guard 是能力求值(isPayable),
//    引用机器的 canFire 而不是复述规则;run 的每步进展都发 mutation。
// ------------------------------------------------------------
type ActionDef = {
  guard: (row: Row, now: number) => true | string
  run: (id: string, now: number) => Promise<void>
}

// 共用的"发起/重放一次扣款"半程:调 stripe → CHARGE_ACCEPTED
async function chargeHalf(id: string, now: number) {
  const c = db.find(id)
  await stripe.call('charge', chargeKey(c), c)
  commit(id, 'CHARGE_ACCEPTED', now)
}
async function refundHalf(id: string, now: number) {
  const c = db.find(id)
  await stripe.call('refund', refundKey(c), c)
  commit(id, 'REFUND_ACCEPTED', now)
}

const actions: Record<string, ActionDef> = {
  pay: {
    guard: (row, now) => canFire(row, 'PAY', now), // isPayable:单源,直接给前端
    async run(id, now) {
      const row = db.find(id)
      if (!commit(id, 'PAY', now, { attempts: row.attempts + 1 })) return // mutation:占位 + 计新尝试
      if (!(await riskService.check(db.find(id))).ok) {
        commit(id, 'RISK_DENIED', now) // 结果是显式事件,进审计日志
        console.log(`   ✗ 403 ${id} pay:风控拒绝`)
        return
      }
      await chargeHalf(id, now)
    },
  },
  retry: {
    guard: (row, now) => canFire(row, 'RETRY', now),
    async run(id, now) {
      const row = db.find(id)
      if (!commit(id, 'RETRY', now, { attempts: row.attempts + 1 })) return
      await chargeHalf(id, now) // 风控按单只评一次,重试直进扣款
    },
  },
  close: {
    guard: (row, now) => canFire(row, 'CLOSE', now),
    async run(id, now) {
      commit(id, 'CLOSE', now) // 没有编排的 action 退化成一次 mutation
    },
  },
  refund: {
    guard: (row, now) => canFire(row, 'REFUND', now),
    async run(id, now) {
      const row = db.find(id)
      if (!commit(id, 'REFUND', now, { refundAttempts: row.refundAttempts + 1 })) return
      await refundHalf(id, now)
    },
  },
  retry_refund: {
    guard: (row, now) => canFire(row, 'RETRY_REFUND', now),
    async run(id, now) {
      const row = db.find(id)
      if (!commit(id, 'RETRY_REFUND', now, { refundAttempts: row.refundAttempts + 1 })) return
      await refundHalf(id, now)
    },
  },
  // 恢复也是 action:重放 in-flight 的后半程(同 key,stripe 幂等去重)
  resume_charge: {
    guard: (row) => (row.status === 'charging' ? true : `状态 ${row.status} 无需恢复扣款`),
    async run(id, now) {
      await chargeHalf(id, now)
    },
  },
  resume_refund: {
    guard: (row) => (row.status === 'refund_calling' ? true : `状态 ${row.status} 无需恢复退款`),
    async run(id, now) {
      await refundHalf(id, now)
    },
  },
}

const USER_ACTIONS = ['pay', 'retry', 'close', 'refund', 'retry_refund'] as const

// ------------------------------------------------------------
// 4. 入口层
// ------------------------------------------------------------

// POST /invoice/:id/:action —— 用户操作直达 action
async function api(id: string, name: string, now: number) {
  const admit = actions[name].guard(db.find(id), now)
  if (admit !== true) {
    console.log(`   ✗ 400 ${id} ${name}:${admit}`)
    return
  }
  await actions[name].run(id, now)
}

// POST /webhook —— 渠道事实直达 mutation(没有编排,不经过 action)
function webhook(id: string, event: 'PSP_OK' | 'PSP_FAIL' | 'REFUND_OK' | 'REFUND_FAIL', now: number) {
  const patch = event === 'PSP_OK' ? { paidAt: now } : {}
  const row = db.find(id)
  if (canFire(row, event, now) !== true) {
    console.log(`   • ${id} 回调 ${event} 被忽略(当前 ${row.status}),ACK 200`)
    return
  }
  commit(id, event, now, patch)
}

// GET /invoice/:id —— displayStatus + 每个 action 的 guard 求值(亮按钮)
function getController(id: string, now: number) {
  const row = db.find(id)
  return {
    displayStatus: displayStatus(row, now),
    actions: USER_ACTIONS.filter((n) => actions[n].guard(row, now) === true),
  }
}

function displayStatus(row: Row, now: number): string {
  const s = row.status
  if (s === 'pending') return RULES.isExpired(row, now) ? 'EXPIRED(已过期)' : 'AWAITING_PAYMENT(待支付)'
  if (s === 'charging' || s === 'waiting') return 'PROCESSING(支付处理中)'
  if (s === 'pay_failed') {
    if (RULES.isExpired(row, now)) return 'EXPIRED(已过期)'
    return RULES.retryable(row, now) ? 'PAY_FAILED(支付失败,可重试)' : 'PAY_FAILED(支付失败)'
  }
  if (s === 'paid') return 'PAID(已支付)'
  if (s === 'refund_calling' || s === 'refund_waiting') return 'REFUNDING(退款中)'
  if (s === 'refund_failed') return 'REFUND_FAILED(退款遇到问题)'
  if (s === 'refunded') return 'REFUNDED(已退款)'
  return 'CLOSED(已关闭)'
}

// ------------------------------------------------------------
// 5. 数据库(version CAS,同前)+ 机器人
// ------------------------------------------------------------
type Row = Ctx & { status: Status; version: number }
const table = new Map<string, Row>()

const db = {
  insert(row: Row) {
    table.set(row.id, { ...row })
  },
  find(id: string): Row {
    return { ...table.get(id)! }
  },
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

async function timeoutCloseJob(now: number, name = 'robot') {
  const candidates = db.select(['pending', 'pay_failed'], (r) => r.expiresAt <= now)
  console.log(
    `\n🤖 ${name} 粗筛:SELECT ... WHERE status IN ('pending','pay_failed') AND expires_at <= now → [${
      candidates.map((r) => r.id).join(', ') || '空'
    }]`,
  )
  for (const row of candidates) await api(row.id, 'close', now)
}

async function recoverInFlightJob(now: number, name = 'recovery') {
  const stuck = db.select(['charging', 'refund_calling'], () => true)
  console.log(`\n🛠 ${name} 扫描 in-flight 行 → [${stuck.map((r) => r.id).join(', ') || '空'}]`)
  for (const row of stuck)
    await api(row.id, row.status === 'charging' ? 'resume_charge' : 'resume_refund', now)
}

function renderGraph() {
  console.log('\n📈 状态图(第 1 层是纯数据,直接遍历打印;可存成 machine.json):')
  for (const [from, edges] of Object.entries(machine.states)) {
    for (const [event, e] of Object.entries(edges)) {
      console.log(`   ${from} --${event}${e.guard ? `[${GUARD_LABEL[e.guard]}]` : ''}--> ${e.target}`)
    }
  }
}

function createInvoice(id: string, amountYen: number, ttlMs: number) {
  db.insert({
    id,
    status: machine.initial,
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
  const res = getController(id, now)
  console.log(
    `   ${id} │ DB 行 = ${row.status}(v${row.version}) │ GET 下发 = ${res.displayStatus} │ 按钮 = [${res.actions.join(', ') || '无'}]`,
  )
}

// ============================================================
// 演出:同一套剧目
// ============================================================
const h = (t: string) => console.log(`\n${'─'.repeat(64)}\n■ ${t}`)

h('① 支付:api → action(编排)→ 每步进展都是 mutation,日志即审计轨迹')
createInvoice('inv_1', 12800, 30 * MIN)
show('inv_1', NOW)
await api('inv_1', 'pay', NOW)
show('inv_1', NOW)
webhook('inv_1', 'PSP_FAIL', NOW)
show('inv_1', NOW)
await api('inv_1', 'retry', NOW)
webhook('inv_1', 'PSP_OK', NOW)
show('inv_1', NOW)

h('② 风控拒绝:RISK_DENIED 是显式事件 —— 审计日志里有这一行,不藏在返回值里')
createInvoice('inv_3', 5_000_000, 30 * MIN)
await api('inv_3', 'pay', NOW)
show('inv_3', NOW)

h('③ 宕机恢复:占位 + 扣款已发出,进程挂;恢复 action 重放后半程,幂等命中')
createInvoice('inv_4', 9800, 30 * MIN)
{
  const row = db.find('inv_4')
  commit('inv_4', 'PAY', NOW, { attempts: row.attempts + 1 }) // 占位成功……
  await stripe.call('charge', chargeKey(db.find('inv_4')), db.find('inv_4'))
  console.log('   💥 宕机:CHARGE_ACCEPTED 没提交,行停在 charging')
}
await recoverInFlightJob(NOW)
webhook('inv_4', 'PSP_OK', NOW)
show('inv_4', NOW)

h('④ 退款:重试是新尝试、新幂等键;重复 webhook 被 ACK')
advance(10 * DAY, '10 天')
await api('inv_1', 'refund', NOW)
webhook('inv_1', 'REFUND_FAIL', NOW)
show('inv_1', NOW)
await api('inv_1', 'retry_refund', NOW)
webhook('inv_1', 'REFUND_OK', NOW)
webhook('inv_1', 'REFUND_OK', NOW) // 重复回调 → ACK
show('inv_1', NOW)

h('⑤ expired 是派生视图;过期后 retry 被拒;超时关单(pay_failed 也能关)')
createInvoice('inv_2', 5600, 30 * MIN)
await api('inv_2', 'pay', NOW)
webhook('inv_2', 'PSP_FAIL', NOW)
advance(31 * MIN, '31 分钟(越过 inv_2 的过期线)')
show('inv_2', NOW)
await api('inv_2', 'retry', NOW)
await timeoutCloseJob(NOW, 'robot-A')
show('inv_2', NOW)
await timeoutCloseJob(NOW, 'robot-A') // 幂等重跑

renderGraph()
