// ============================================================
// invoice × 最终形态:xstate(machine)+ guards + actions
//
// 分层(like vuex):
//   machine  纯同步图 = state + mutation:states / guard / assign,
//            零 invoke、零 async。commit() 是唯一改状态的口。
//   actions  业务编排 = vuex action:guard 是能力求值(isPayable,
//            直接给前端亮按钮),run 随便 async,每步进展发 mutation。
//   入口     用户 API → action;渠道 webhook → 直达 mutation。
//
// 两个建模决定:
//   · 没有 pay_failed:成功/失败是【一次尝试(attempt)】的属性,
//     不是发票的状态。PSP_FAIL 只是把发票送回 pending(重新可支付),
//     失败细节记在尝试日志里。重试 = 再 PAY 一次。
//   · refund 是【并行区域】:payment ∥ refund 各自演化,
//     "能不能退"用跨区域 guard(stateIn payment.paid)表达。
//
// statechart 三特性在此齐了:hierarchy(processing 群)、
// concurrency(payment ∥ refund)、guard(含跨区域 stateIn);
// communication ≈ webhook 事件。
//
// 生产细节(version CAS 防 ABA、幂等键、宕机恢复、超时机器人)这里
// 刻意省略,见 play-layered.ts / play-xstate.ts。
//
// 运行:node playground/play-xstate-sugar.ts   (Node ≥ 23.6 原生跑 TS)
// ============================================================

import { setup, transition, initialTransition, assign, and, stateIn } from 'xstate'

const MIN = 60_000
const DAY = 24 * 60 * MIN

let NOW = Date.parse('2026-08-24T14:00:00Z')
const advance = (ms: number, label: string) => {
  NOW += ms
  console.log(`\n⏰ 时间推进 ${label} → ${new Date(NOW).toISOString()}`)
}

// ------------------------------------------------------------
// 0. 规则单源
// ------------------------------------------------------------
type Ctx = {
  id: string
  amountYen: number
  expiresAt: number
  attempts: number // 第几次支付尝试(失败细节属于尝试,不属于发票)
  paidAt: number | null
}

const REFUND_WINDOW = 90 * DAY

const RULES = {
  notExpired: (c: Ctx, now: number) => now < c.expiresAt,
  isExpired: (c: Ctx, now: number) => now >= c.expiresAt,
  refundWindowOpen: (c: Ctx, now: number) =>
    c.paidAt !== null && now - c.paidAt <= REFUND_WINDOW,
}

// ------------------------------------------------------------
// 1. machine:纯同步图。payment ∥ refund 两个并行区域
// ------------------------------------------------------------
type Ev =
  | { type: 'PAY'; now: number }
  | { type: 'RISK_DENIED'; now: number }
  | { type: 'CHARGE_ACCEPTED'; now: number }
  | { type: 'PSP_OK'; now: number }
  | { type: 'PSP_FAIL'; now: number }
  | { type: 'CLOSE'; now: number }
  | { type: 'REFUND'; now: number }
  | { type: 'REFUND_ACCEPTED'; now: number }
  | { type: 'REFUND_OK'; now: number }
  | { type: 'REFUND_FAIL'; now: number }

const invoiceMachine = setup({
  types: {} as {
    context: Ctx
    events: Ev
    input: { id: string; amountYen: number; expiresAt: number } | undefined
  },
  guards: {
    notExpired: ({ context, event }) => RULES.notExpired(context, event.now),
    isExpired: ({ context, event }) => RULES.isExpired(context, event.now),
    // 跨区域 guard:退款的前提是 payment 区域正处于 paid
    refundable: and([stateIn('#invoice.payment.paid'), ({ context, event }) => RULES.refundWindowOpen(context, (event as Ev).now)]),
  },
}).createMachine({
  id: 'invoice',
  context: ({ input }) => ({ ...input!, attempts: 0, paidAt: null }),
  type: 'parallel', // ← concurrency:两个区域各自演化
  states: {
    payment: {
      initial: 'pending',
      states: {
        pending: {
          on: {
            PAY: {
              guard: 'notExpired',
              target: 'processing',
              actions: assign({ attempts: ({ context }) => context.attempts + 1 }), // 开启新一次尝试
            },
            CLOSE: { guard: 'isExpired', target: 'closed' },
          },
        },
        // hierarchy:群不变量 = 资金结局未知;webhook 边挂父级,子状态共享
        processing: {
          initial: 'charging',
          on: {
            PSP_OK: { target: 'paid', actions: assign({ paidAt: ({ event }) => event.now }) },
            PSP_FAIL: { target: 'pending' }, // 失败属于这次尝试;发票回到 pending,重试 = 再 PAY
          },
          states: {
            charging: {
              on: {
                RISK_DENIED: { target: '#invoice.payment.pending' }, // run 的结果 = 显式事件
                CHARGE_ACCEPTED: { target: 'waiting' },
              },
            },
            waiting: {}, // 等 webhook,出口全在父级
          },
        },
        paid: {},
        closed: {},
      },
    },
    refund: {
      initial: 'none',
      states: {
        none: {
          on: { REFUND: { guard: 'refundable', target: 'processing' } },
        },
        processing: {
          initial: 'calling',
          on: {
            REFUND_OK: { target: 'done' },
            REFUND_FAIL: { target: 'none' }, // 同理:退款失败属于尝试,回 none 可再退
          },
          states: {
            calling: { on: { REFUND_ACCEPTED: { target: 'waiting' } } },
            waiting: {},
          },
        },
        done: {},
      },
    },
  },
})

// 并行状态值 ↔ 可读字符串(仅用于打印)
const flat = (v: any): string =>
  typeof v === 'string' ? v : Object.entries(v).map(([k, s]) => `${k}.${flat(s)}`).join(' ∥ ')

const snapshotOf = (row: Row) =>
  invoiceMachine.resolveState({ value: row.state, context: rowCtx(row) })

function canFire(row: Row, type: Ev['type'], now: number): boolean {
  return snapshotOf(row).can({ type, now } as Ev)
}

// commit = 唯一的 mutation:can 校验 → 纯 transition 算落点与新 context → 写回
function commit(id: string, type: Ev['type'], now: number): boolean {
  const row = db.find(id)
  if (!canFire(row, type, now)) {
    console.log(`   ✗ ${id} ${type} 被拒(当前 ${flat(row.state)})`)
    return false
  }
  const [next] = transition(invoiceMachine, snapshotOf(row), { type, now } as Ev)
  db.save(id, next.value, next.context)
  console.log(`   ✓ ${id} ${type}:${flat(row.state)} → ${flat(next.value)}`) // transition log
  return true
}

// ------------------------------------------------------------
// 2. 假的第三方
// ------------------------------------------------------------
const riskService = {
  async check(c: Ctx) {
    const ok = c.amountYen < 1_000_000
    console.log(`   ☎ riskService.check(${c.id}) → ${ok ? '通过' : '拒绝(大额)'}`)
    return { ok }
  },
}
const stripe = {
  async call(kind: 'charge' | 'refund', c: Ctx) {
    console.log(`   ☎ stripe.${kind}(${c.id}, ¥${c.amountYen}) → 已受理,结果将由 webhook 通知`)
  },
}

// ------------------------------------------------------------
// 3. actions:guard = 能力求值(机器的 can,单源);run = 编排,每步发 mutation
// ------------------------------------------------------------
const actions: Record<string, {
  guard: (row: Row, now: number) => boolean
  run: (id: string, now: number) => Promise<void>
}> = {
  pay: {
    guard: (row, now) => canFire(row, 'PAY', now), // isPayable
    async run(id, now) {
      if (!commit(id, 'PAY', now)) return
      if (!(await riskService.check(db.find(id))).ok) {
        commit(id, 'RISK_DENIED', now)
        return
      }
      await stripe.call('charge', db.find(id))
      commit(id, 'CHARGE_ACCEPTED', now)
    },
  },
  close: {
    guard: (row, now) => canFire(row, 'CLOSE', now),
    async run(id, now) {
      commit(id, 'CLOSE', now)
    },
  },
  refund: {
    guard: (row, now) => canFire(row, 'REFUND', now), // isRefundable(跨区域 stateIn)
    async run(id, now) {
      if (!commit(id, 'REFUND', now)) return
      await stripe.call('refund', db.find(id))
      commit(id, 'REFUND_ACCEPTED', now)
    },
  },
}

const USER_ACTIONS = ['pay', 'close', 'refund'] as const

// ------------------------------------------------------------
// 4. 入口:用户 API → action;渠道 webhook → 直达 mutation;GET → 派生
// ------------------------------------------------------------
async function api(id: string, name: string, now: number) {
  if (!actions[name].guard(db.find(id), now)) {
    console.log(`   ✗ 400 ${id} ${name}:当前不可执行`)
    return
  }
  await actions[name].run(id, now)
}

function webhook(id: string, type: 'PSP_OK' | 'PSP_FAIL' | 'REFUND_OK' | 'REFUND_FAIL', now: number) {
  if (!canFire(db.find(id), type, now)) {
    console.log(`   • ${id} 回调 ${type} 被忽略,ACK 200`)
    return
  }
  commit(id, type, now)
}

// 展示状态 = 两个区域 + now 的联合派生(expired 不是状态,是派生结论)
function displayStatus(row: Row, now: number): string {
  const snap = snapshotOf(row)
  if (snap.matches({ refund: 'done' })) return 'REFUNDED(已退款)'
  if (snap.matches({ refund: 'processing' })) return 'REFUNDING(退款中)'
  if (snap.matches({ payment: 'pending' }))
    return RULES.isExpired(row, now) ? 'EXPIRED(已过期)' : 'AWAITING_PAYMENT(待支付)'
  if (snap.matches({ payment: 'processing' })) return 'PROCESSING(支付处理中)'
  if (snap.matches({ payment: 'paid' })) return 'PAID(已支付)'
  return 'CLOSED(已关闭)'
}

function getController(id: string, now: number) {
  const row = db.find(id)
  return {
    displayStatus: displayStatus(row, now),
    actions: USER_ACTIONS.filter((n) => actions[n].guard(row, now)), // 亮按钮
  }
}

// ------------------------------------------------------------
// 5. 极简存储(生产版的 version CAS 见 play-layered.ts)
// ------------------------------------------------------------
type Row = Ctx & { state: any } // 机器的 state value(并行:{payment, refund})
const table = new Map<string, Row>()
const rowCtx = (r: Row): Ctx => ({
  id: r.id, amountYen: r.amountYen, expiresAt: r.expiresAt, attempts: r.attempts, paidAt: r.paidAt,
})

const db = {
  find(id: string): Row {
    return { ...table.get(id)! }
  },
  save(id: string, state: unknown, ctx: Ctx) {
    table.set(id, { ...ctx, state })
  },
}

function createInvoice(id: string, amountYen: number, ttlMs: number) {
  const [init] = initialTransition(invoiceMachine, { id, amountYen, expiresAt: NOW + ttlMs })
  db.save(id, init.value, init.context)
  console.log(`\n🧾 创建 ${id}:¥${amountYen},${new Date(NOW + ttlMs).toISOString()} 过期`)
}

function show(id: string, now: number) {
  const row = db.find(id)
  const res = getController(id, now)
  console.log(
    `   ${id} │ state = ${flat(row.state)} │ GET 下发 = ${res.displayStatus} │ 按钮 = [${res.actions.join(', ') || '无'}]`,
  )
}

// ============================================================
// 演出
// ============================================================
const h = (t: string) => console.log(`\n${'─'.repeat(64)}\n■ ${t}`)

h('① 支付失败回到 pending:失败是这次尝试的事,发票重新可支付,重试 = 再 PAY')
createInvoice('inv_1', 12800, 30 * MIN)
show('inv_1', NOW)
await api('inv_1', 'pay', NOW)
show('inv_1', NOW)
webhook('inv_1', 'PSP_FAIL', NOW) // → 回 pending,按钮 pay 重新亮起
show('inv_1', NOW)
await api('inv_1', 'pay', NOW) // 第二次尝试(attempts = 2)
webhook('inv_1', 'PSP_OK', NOW)
show('inv_1', NOW)

h('② 风控拒绝:RISK_DENIED 是显式事件,同样只是送回 pending')
createInvoice('inv_2', 5_000_000, 30 * MIN)
await api('inv_2', 'pay', NOW)
show('inv_2', NOW)

h('③ refund 是并行区域:payment 停在 paid 不动,refund 区域独立演化')
advance(10 * DAY, '10 天')
await api('inv_1', 'refund', NOW) // guard = stateIn(payment.paid) && 窗口内
show('inv_1', NOW) // ← state 打印两个区域:payment.paid ∥ refund.processing…
webhook('inv_1', 'REFUND_FAIL', NOW) // 退款失败也属于尝试:回 none,可再退
show('inv_1', NOW)
await api('inv_1', 'refund', NOW)
webhook('inv_1', 'REFUND_OK', NOW)
show('inv_1', NOW)

h('④ 跨区域 guard:未支付的发票点退款,stateIn(payment.paid) 直接拒绝')
await api('inv_2', 'refund', NOW)

h('⑤ expired 是派生视图,CLOSE 之后一切归位')
advance(21 * DAY, '21 天(inv_2 早已越过过期线)')
show('inv_2', NOW) // state 还是 pending,显示已是 EXPIRED,按钮只剩 close
await api('inv_2', 'close', NOW)
show('inv_2', NOW)
