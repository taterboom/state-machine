// ============================================================
// invoice × XState(statechart)playground —— 服务器版,idiomatic xstate
// 对应《动作游戏、web 与状态机:转移是枚举的,还是计算的?》
//
// 分工:
//   · 同步、便宜的判定  → guard(边上的条件)
//   · 异步、有结果的步骤 → invoke + fromPromise(风控、调 stripe)
//   · 跨请求的异步(webhook)→ 普通事件,落在稳定状态上等
//   · 多节点并发控制 → 数据库 version CAS(xstate 之外的事)
//   · 副作用不重复  → idempotency key(CAS 之外的事,见下)
//
// 三个容易混的防线,各管各的:
//   guard / can        管"这一步合不合法"
//   version CAS        管"谁有权推进状态"(并发下先到者赢)
//   idempotency key    管"同一副作用只生效一次"(重发/宕机恢复下不双扣)
// CAS 不能替代幂等:占位成功 ≠ 扣款请求只发过一次——网络重发、
// 宕机后恢复任务重放,都会让同一次业务尝试的 HTTP 请求发出多次。
//
// 运行:node playground/play-xstate.ts   (Node ≥ 23.6 原生跑 TS)
// ============================================================

import { setup, createActor, transition, initialTransition, fromPromise, waitFor, assign, and } from 'xstate'

const MIN = 60_000
const DAY = 24 * 60 * MIN

// 假时钟:now 永远显式传入,所有求值都是纯函数(可测试、可回放)
let NOW = Date.parse('2026-08-24T14:00:00Z')
const advance = (ms: number, label: string) => {
  NOW += ms
  console.log(`\n⏰ 时间推进 ${label} → ${new Date(NOW).toISOString()}`)
}

// ------------------------------------------------------------
// 1. 规则单源:同一个谓词,machine 的 guard 用它,拒绝原因也用它
// ------------------------------------------------------------
type Ctx = {
  id: string
  amountYen: number
  expiresAt: number
  attempts: number // 扣款尝试次数(也是扣款幂等键的一部分)
  refundAttempts: number // 退款尝试次数(退款幂等键的一部分)
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
// 2. 假的第三方(RPC),由机器 invoke。
//    stripe 按 idempotency key 去重:同一个 key 的请求只受理一次——
//    "新的一次业务尝试 = 新 key;同一次尝试的重发 = 同一个 key"。
//    key 从 (发票 id, 第几次尝试) 确定性地导出,不用随机数,
//    这样宕机恢复后重放同一次尝试,天然拿到同一个 key。
// ------------------------------------------------------------
const stripeSeen = new Set<string>()

const riskCheck = fromPromise(async ({ input }: { input: { id: string; amountYen: number } }) => {
  const ok = input.amountYen < 1_000_000
  console.log(`   ☎ riskService.check(${input.id}) → ${ok ? '通过' : '拒绝(大额触发人工审核)'}`)
  return { ok }
})
const chargeCall = fromPromise(async ({ input }: { input: { key: string; id: string; amountYen: number } }) => {
  if (stripeSeen.has(input.key)) {
    console.log(`   ☎ stripe.charge key=${input.key} → 幂等命中:该请求已受理过,不重复扣款`)
    return
  }
  stripeSeen.add(input.key)
  console.log(`   ☎ stripe.charge(${input.id}, ¥${input.amountYen}) key=${input.key} → 已受理,结果将由 webhook 通知`)
})
const refundCall = fromPromise(async ({ input }: { input: { key: string; id: string; amountYen: number } }) => {
  if (stripeSeen.has(input.key)) {
    console.log(`   ☎ stripe.refund key=${input.key} → 幂等命中:该请求已受理过,不重复退款`)
    return
  }
  stripeSeen.add(input.key)
  console.log(`   ☎ stripe.refund(${input.id}, ¥${input.amountYen}) key=${input.key} → 已受理,结果将由 webhook 通知`)
})

// ------------------------------------------------------------
// 3. 机器。hierarchy 的语义(重新想过):
//    状态群的边界不是"业务叙事"(支付流程),而是【共享的不变量】。
//
//    processing 群的不变量:资金结局未知(风控在查 / 扣款已发出 / 等
//    webhook)—— 群里任何子状态都不可关闭、不可重试、不可判死,只能等结局。
//
//    pay_failed 虽然属于"支付"的叙事,但钱确定没扣走,不共享这条不变量,
//    所以它是【顶层】稳定态,与 pending 同类:可重试、会过期、能被超时关单。
//    (之前把它塞进 processing 群,导致 "failed + 已过期" 无路可走:
//    RETRY 被 guard 挡住,CLOSE 只在 pending 上——群划错的症状就是死角。)
//
//    同理 refund_failed 顶层:退款结局已知(失败),钱在平台,可无限重试。
// ------------------------------------------------------------
type Ev =
  | { type: 'PAY'; now: number }
  | { type: 'PSP_OK'; now: number }
  | { type: 'PSP_FAIL'; now: number }
  | { type: 'RETRY'; now: number }
  | { type: 'CLOSE'; now: number }
  | { type: 'REFUND'; now: number }
  | { type: 'REFUND_OK'; now: number }
  | { type: 'REFUND_FAIL'; now: number }
  | { type: 'RETRY_REFUND'; now: number }
  | { type: 'RESUME'; now: number } // 恢复任务专用:重入在途状态,重启 invoke

const invoiceMachine = setup({
  types: {} as {
    context: Ctx
    events: Ev
    // undefined:从数据库快照恢复(resolveState)时不走 context 工厂,无需 input
    input: { id: string; amountYen: number; expiresAt: number } | undefined
    tags: 'transient'
  },
  guards: {
    notExpired: ({ context, event }) => RULES.notExpired(context, event.now),
    isExpired: ({ context, event }) => RULES.isExpired(context, event.now),
    retriesLeft: ({ context }) => RULES.retriesLeft(context),
    refundWindowOpen: ({ context, event }) => RULES.refundWindowOpen(context, event.now),
  },
  actors: { riskCheck, chargeCall, refundCall },
}).createMachine({
  id: 'invoice',
  context: ({ input }) => ({ ...input!, attempts: 0, refundAttempts: 0, paidAt: null }),
  initial: 'pending',
  states: {
    // 稳定态:可关闭、会过期。注意:没有 expired 状态,"过期"是派生结论
    pending: {
      on: {
        PAY: { guard: 'notExpired', target: 'processing' },
        CLOSE: { guard: 'isExpired', target: 'closed' },
      },
    },
    // 群不变量:资金结局未知 —— 只能等结局,没有任何人为出口
    processing: {
      initial: 'checking',
      states: {
        checking: {
          tags: 'transient',
          // RESUME(reenter):恢复任务重入本状态 → invoke 重新启动。
          // 从 resolveState 恢复的快照不会自动重启 invoke(那是完整持久化
          // 快照的能力),所以恢复走"重入"——文档:re-entering stops
          // existing invocations and starts new ones
          on: { RESUME: { target: 'checking', reenter: true } },
          invoke: {
            src: 'riskCheck',
            input: ({ context }) => ({ id: context.id, amountYen: context.amountYen }),
            onDone: [
              {
                guard: ({ event }) => event.output.ok,
                target: 'charging',
                // attempts 自增放在【入边】而不是 charging 的 entry:
                // RESUME 重入不能算新尝试,否则幂等键会变,重放就防不住双扣
                actions: assign({ attempts: ({ context }) => context.attempts + 1 }),
              },
              { target: '#invoice.pending' }, // 风控拒绝:退回 pending,不是非法转移
            ],
          },
        },
        charging: {
          tags: 'transient',
          on: { RESUME: { target: 'charging', reenter: true } },
          invoke: {
            src: 'chargeCall',
            // 幂等键 = id + 第几次尝试:重放同一次尝试 → 同 key → stripe 去重
            input: ({ context }) => ({
              key: `${context.id}:charge:${context.attempts}`,
              id: context.id,
              amountYen: context.amountYen,
            }),
            onDone: 'attempting',
            onError: '#invoice.pay_failed', // 连 stripe 都调不通,记一次失败
          },
        },
        attempting: {
          on: {
            PSP_OK: {
              target: '#invoice.paid',
              actions: assign({ paidAt: ({ event }) => event.now }),
            },
            PSP_FAIL: { target: '#invoice.pay_failed' },
          },
        },
      },
    },
    // 顶层稳定态:钱确定没扣走,与 pending 同类 —— 可重试、会过期、能被关单
    pay_failed: {
      on: {
        RETRY: {
          guard: and(['notExpired', 'retriesLeft']),
          target: '#invoice.processing.charging', // 风控按单只评一次,重试直进扣款
          actions: assign({ attempts: ({ context }) => context.attempts + 1 }), // 新尝试 = 新幂等键
        },
        CLOSE: { guard: 'isExpired', target: 'closed' }, // 修复:failed + 过期不再无路可走
      },
    },
    paid: {
      on: {
        REFUND: {
          guard: 'refundWindowOpen',
          target: 'refunding',
          actions: assign({ refundAttempts: ({ context }) => context.refundAttempts + 1 }),
        },
      },
    },
    // 群不变量:退款结局未知
    refunding: {
      initial: 'calling',
      states: {
        calling: {
          tags: 'transient',
          on: { RESUME: { target: 'calling', reenter: true } },
          invoke: {
            src: 'refundCall',
            input: ({ context }) => ({
              key: `${context.id}:refund:${context.refundAttempts}`,
              id: context.id,
              amountYen: context.amountYen,
            }),
            onDone: 'attempting',
            onError: '#invoice.refund_failed',
          },
        },
        attempting: {
          on: {
            REFUND_OK: { target: '#invoice.refunded' },
            REFUND_FAIL: { target: '#invoice.refund_failed' },
          },
        },
      },
    },
    // 顶层稳定态:退款确定失败,钱在平台 —— 可无限重试,不可关单
    refund_failed: {
      on: {
        RETRY_REFUND: {
          target: 'refunding',
          actions: assign({ refundAttempts: ({ context }) => context.refundAttempts + 1 }),
        },
      },
    },
    closed: { type: 'final' },
    refunded: { type: 'final' },
  },
})

// 状态值 ↔ DB 的 status 列:'processing.charging' ↔ { processing: 'charging' }
const statusOf = (snap: { value: unknown }): string => {
  const v = snap.value as any
  return typeof v === 'string' ? v : Object.entries(v).map(([k, s]) => `${k}.${s}`).join('+')
}
const toValue = (status: string) => {
  const [head, sub] = status.split('.')
  return sub ? { [head]: sub } : head
}

// ------------------------------------------------------------
// 4. 数据库(内存模拟,语义照搬 SQL)
// ------------------------------------------------------------
type Row = {
  id: string
  status: string
  version: number
  amount_yen: number
  expires_at: number
  attempts: number
  refund_attempts: number
  paid_at: number | null
}
const table = new Map<string, Row>()

const db = {
  insert(row: Row) {
    table.set(row.id, { ...row })
  },
  // SELECT * FROM invoice WHERE id = :id
  find(id: string): Row {
    return { ...table.get(id)! } // 返回副本:模拟"每个请求各自读库"
  },

  // CAS(乐观锁),但比较的是 version 而不是 status:
  //   UPDATE invoice SET status=:to, version=version+1, ...
  //    WHERE id=:id AND version=:expected [AND expires_at > :now]
  // 为什么不能拿 status 比较 —— ABA 问题:status 会回到旧值
  // (pending → checking → 风控拒绝 → pending),拿着旧世界快照的写者
  // 会因为"看起来没变"而误成功;version 单调递增,永不回头。
  cas(id: string, opts: { expectedVersion: number; to: string; ctx: Ctx; stillNotExpiredAt?: number }): number {
    const r = table.get(id)
    if (!r || r.version !== opts.expectedVersion) return 0
    if (opts.stillNotExpiredAt !== undefined && r.expires_at <= opts.stillNotExpiredAt) return 0
    r.status = opts.to
    r.version += 1
    r.attempts = opts.ctx.attempts
    r.refund_attempts = opts.ctx.refundAttempts
    r.paid_at = opts.ctx.paidAt
    return 1
  },

  // SELECT * FROM invoice WHERE status IN ('pending','pay_failed') AND expires_at <= :now
  // 粗筛:可被超时关单的稳定态。pay_failed 现在也在名单里(修复死角)
  selectExpiredClosable(now: number): Row[] {
    return [...table.values()].filter(
      (r) => (r.status === 'pending' || r.status === 'pay_failed') && r.expires_at <= now,
    )
  },
}

// 行 → 快照:xstate 官方的重建入口(machine.resolveState)
const snapshotOf = (row: Row) =>
  invoiceMachine.resolveState({
    value: toValue(row.status),
    context: {
      id: row.id,
      amountYen: row.amount_yen,
      expiresAt: row.expires_at,
      attempts: row.attempts,
      refundAttempts: row.refund_attempts,
      paidAt: row.paid_at,
    },
  })

// ------------------------------------------------------------
// 5. 唯一的 controller:对任何事件(用户操作 / webhook / 机器人)都是同一套
// ------------------------------------------------------------
const WEBHOOKS = new Set(['PSP_OK', 'PSP_FAIL', 'REFUND_OK', 'REFUND_FAIL'])

async function handleEvent(id: string, type: Ev['type'], now: number) {
  const row = db.find(id)
  const snap = snapshotOf(row)
  const event = { type, now } as Ev

  // ① 准入:机器的边 + guard,一步求值(第一道闸)
  if (!snap.can(event)) {
    if (WEBHOOKS.has(type)) console.log(`   • ${id} 回调 ${type} 被忽略(当前 ${row.status}),ACK 200`)
    else console.log(`   ✗ 400 ${id} ${type}:${whyRefused(type, snap.context, now, row.status)}`)
    return
  }

  // ② version CAS 占位:抢到行,才有资格启动会产生副作用的 actor
  const [claimed] = transition(invoiceMachine, snap, event) // 纯函数,只算落点,不跑 invoke
  const affected = db.cas(id, {
    expectedVersion: row.version,
    to: statusOf(claimed),
    ctx: claimed.context,
    stillNotExpiredAt: type === 'PAY' ? now : undefined,
  })
  if (affected === 0) {
    console.log(`   ⚠ 409 ${id} ${type}:CAS affected=0,行已被别人推进`)
    return
  }
  console.log(`   ✓ ${id} ${type}:${row.status} → ${statusOf(claimed)}`)

  // ③ 让机器自己编排:invoke(风控/扣款)在对应状态自动开始,
  //    waitFor 等到没有 'transient' 标签的稳定态
  const actor = createActor(invoiceMachine, { snapshot: snap, input: undefined }).start()
  actor.send(event)
  const settled = await waitFor(actor, (s) => !s.hasTag('transient'))
  actor.stop()

  // ④ 稳定态写回(从占位后的 version 继续 CAS)。这一步之前进程挂了,
  //    行会停在 in-flight 状态 —— 由恢复任务兜底(见 recoverInFlightJob)
  if (statusOf(settled) !== statusOf(claimed)) {
    // CAS 可能失败:等 RPC 期间行可能已被恢复任务/其他请求推进——
    // 内存里 actor 的状态不是数据库事实,必须以 affected 为准
    const affected = db.cas(id, { expectedVersion: row.version + 1, to: statusOf(settled), ctx: settled.context })
    if (affected === 0) {
      console.log(`   ⚠ ${id} 稳定态写回失败(CAS affected=0):行已被其他处理器推进`)
      return
    }
    console.log(`   ✓ ${id} 稳定于:${statusOf(settled)}`)
  }
  if (type === 'PAY' && settled.matches('pending')) console.log(`   ✗ 403 ${id} PAY:风控拒绝,退回 pending`)
}

// GET /invoice/:id —— displayStatus 与按钮算好下发,别让各端自己算
const USER_ACTIONS = ['PAY', 'RETRY', 'CLOSE', 'REFUND', 'RETRY_REFUND'] as const

function getController(id: string, now: number) {
  const row = db.find(id)
  const snap = snapshotOf(row)
  return {
    displayStatus: displayStatus(snap, now),
    actions: USER_ACTIONS.filter((a) => snap.can({ type: a, now } as Ev)), // 按钮亮灭
  }
}

// 拒绝原因给人看,机器只回答能不能;引用的仍是同一份 RULES,不是第二份规则
const CONDITIONS: Partial<Record<Ev['type'], [string, (c: Ctx, now: number) => boolean][]>> = {
  PAY: [['尚未过期', RULES.notExpired]],
  RETRY: [
    ['尚未过期', RULES.notExpired],
    ['重试次数未用尽', RULES.retriesLeft],
  ],
  CLOSE: [['已经过期', RULES.isExpired]],
  REFUND: [['退款窗口内(90 天)', RULES.refundWindowOpen]],
}
function whyRefused(type: Ev['type'], ctx: Ctx, now: number, status: string): string {
  const failing = (CONDITIONS[type] ?? []).find(([, rule]) => !rule(ctx, now))
  return failing ? `不满足条件「${failing[0]}」` : `状态 ${status} 下没有 ${type} 这条边`
}

// 展示层:displayStatus = f(state, context, now)。
// 同一个 "now ≥ expiresAt" 在不同 state 下含义不同:
//   pending / pay_failed → 已过期;processing → 处理中(在途不判死);paid → 已支付
function displayStatus(snap: any, now: number): string {
  if (snap.matches('pending'))
    return RULES.isExpired(snap.context, now) ? 'EXPIRED(已过期)' : 'AWAITING_PAYMENT(待支付)'
  if (snap.matches('processing')) return 'PROCESSING(支付处理中)'
  if (snap.matches('pay_failed')) {
    if (RULES.isExpired(snap.context, now)) return 'EXPIRED(已过期)'
    return RULES.retriesLeft(snap.context)
      ? 'PAY_FAILED(支付失败,可重试)'
      : 'PAY_FAILED(支付失败)'
  }
  if (snap.matches('paid')) return 'PAID(已支付)'
  if (snap.matches('refunding')) return 'REFUNDING(退款中)'
  if (snap.matches('refund_failed')) return 'REFUND_FAILED(退款遇到问题)'
  if (snap.matches('refunded')) return 'REFUNDED(已退款)'
  return 'CLOSED(已关闭)'
}

// ------------------------------------------------------------
// 6. 两个机器人:都走同一套规则,不另立山头
// ------------------------------------------------------------

// 超时关单:粗筛(SQL)→ 细筛 + CAS(handleEvent 里,规则单源)
async function timeoutCloseJob(now: number, name = 'robot') {
  const candidates = db.selectExpiredClosable(now)
  console.log(
    `\n🤖 ${name} 粗筛:SELECT ... WHERE status IN ('pending','pay_failed') AND expires_at <= now → [${
      candidates.map((r) => r.id).join(', ') || '空'
    }]`,
  )
  for (const row of candidates) await handleEvent(row.id, 'CLOSE', now)
}

// 恢复任务:宕机会让行停在 in-flight(transient)状态。
// 恢复 = 发 RESUME 重入该状态(reenter 重启 invoke),走的还是同一个
// handleEvent;副作用不重复靠 idempotency key,不靠 CAS。
async function recoverInFlightJob(now: number, name = 'recovery') {
  const stuck = [...table.values()].filter((r) => snapshotOf(db.find(r.id)).hasTag('transient'))
  console.log(`\n🛠 ${name} 扫描 in-flight 行 → [${stuck.map((r) => r.id).join(', ') || '空'}]`)
  for (const { id } of stuck) await handleEvent(id, 'RESUME', now)
}

// ------------------------------------------------------------
// 建单 + 观察
// ------------------------------------------------------------
function createInvoice(id: string, amountYen: number, ttlMs: number) {
  const [init] = initialTransition(invoiceMachine, { id, amountYen, expiresAt: NOW + ttlMs })
  db.insert({
    id,
    status: statusOf(init),
    version: 0,
    amount_yen: amountYen,
    expires_at: NOW + ttlMs,
    attempts: init.context.attempts,
    refund_attempts: init.context.refundAttempts,
    paid_at: init.context.paidAt,
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
// 演出开始:每个请求都是独立的 controller 调用,中间不共享任何内存状态
// ============================================================
const h = (t: string) => console.log(`\n${'─'.repeat(64)}\n■ ${t}`)

h('① 支付:风控(invoke)→ 扣款(invoke,带幂等键)→ 稳定态等 webhook;失败落到顶层 pay_failed')
createInvoice('inv_1', 12800, 30 * MIN)
await handleEvent('inv_1', 'PAY', NOW)
show('inv_1', NOW)
await handleEvent('inv_1', 'PSP_FAIL', NOW) // 💳 webhook:扣款失败 → 顶层 pay_failed
show('inv_1', NOW)
await handleEvent('inv_1', 'RETRY', NOW) // 新的一次尝试 = 新幂等键(…:charge:2)
await handleEvent('inv_1', 'PSP_OK', NOW) // 💳 webhook:扣款成功
show('inv_1', NOW)

h('② webhook 的拒绝语义:stripe 重发了一遍 PSP_OK —— 不是错误,ACK 掉(幂等)')
await handleEvent('inv_1', 'PSP_OK', NOW)

h('③ 风控拒绝 ≠ 非法转移:大额单退回 pending —— 注意 status 回到了原值,version 没有')
createInvoice('inv_3', 5_000_000, 30 * MIN)
const stale3 = db.find('inv_3') // 某个旧读者在这一刻读走了行(pending, v0)
await handleEvent('inv_3', 'PAY', NOW)
show('inv_3', NOW) // status 又是 pending,但 v0 → v2

h('④ ABA:旧读者拿 v0 来 CAS —— 按 status 比较会误成功(它看到的还是 pending),按 version 必败')
const abaAffected = db.cas('inv_3', {
  expectedVersion: stale3.version,
  to: 'closed',
  ctx: snapshotOf(stale3).context,
})
console.log(
  `   旧读者 UPDATE ... WHERE version=${stale3.version} → affected = ${abaAffected}(此刻 version 已是 ${db.find('inv_3').version};status 虽然同为 pending,但世界已经变过两次)`,
)

h('⑤ 宕机恢复:RETRY 占位、扣款请求已发出,然后进程挂了(没写回稳定态)')
createInvoice('inv_4', 9800, 30 * MIN)
await handleEvent('inv_4', 'PAY', NOW)
await handleEvent('inv_4', 'PSP_FAIL', NOW) // → pay_failed
// —— 手工重演 handleEvent 的前半段,然后"宕机" ——
{
  const row = db.find('inv_4')
  const snap = snapshotOf(row)
  const event = { type: 'RETRY', now: NOW } as Ev
  const [claimed] = transition(invoiceMachine, snap, event)
  db.cas('inv_4', { expectedVersion: row.version, to: statusOf(claimed), ctx: claimed.context })
  console.log(`   ✓ inv_4 RETRY:${row.status} → ${statusOf(claimed)}(已占位)`)
  const actor = createActor(invoiceMachine, { snapshot: snap, input: undefined }).start()
  actor.send(event) // 扣款请求已发出(key=inv_4:charge:2)……
  actor.stop() // 💥 宕机:稳定态没写回,行停在 processing.charging
}
show('inv_4', NOW)
await recoverInFlightJob(NOW) // RESUME 重入 → invoke 重启 → 同一次尝试、同一个 key → stripe 幂等命中
await handleEvent('inv_4', 'PSP_OK', NOW) // 💳 webhook:扣款成功
show('inv_4', NOW)

h('⑥ 退款:同一套编排;每次重试是新尝试、新幂等键,不会被 stripe 误去重')
advance(10 * DAY, '10 天')
await handleEvent('inv_1', 'REFUND', NOW)
await handleEvent('inv_1', 'REFUND_FAIL', NOW) // 💳 webhook → 顶层 refund_failed
show('inv_1', NOW)
await handleEvent('inv_1', 'RETRY_REFUND', NOW) // key=…:refund:2,新尝试不去重
await handleEvent('inv_1', 'REFUND_OK', NOW)
show('inv_1', NOW)

h('⑦ expired 不是状态:pending 和 pay_failed 都靠派生显示"已过期"')
createInvoice('inv_2', 5600, 30 * MIN)
await handleEvent('inv_2', 'PAY', NOW)
await handleEvent('inv_2', 'PSP_FAIL', NOW) // inv_2 停在 pay_failed
advance(31 * MIN, '31 分钟(越过 inv_2 的过期线)')
show('inv_2', NOW) // ← DB 行还是 pay_failed,显示 EXPIRED;按钮只剩 CLOSE(死角已修)

h('⑧ 判断权归求值:过期后重试,第一道闸精确拒绝(400 + 原因)')
await handleEvent('inv_2', 'RETRY', NOW)

h('⑨ 超时关单 + 并发竞争:pay_failed 也能被关;旧 version 的竞争者安静退出')
const staleRow = db.find('inv_2')
await timeoutCloseJob(NOW, 'robot-A') // 关掉 inv_2(pay_failed)、inv_3(pending,过期)
const [nextB] = transition(invoiceMachine, snapshotOf(staleRow), { type: 'CLOSE', now: NOW } as Ev)
const bAffected = db.cas(staleRow.id, { expectedVersion: staleRow.version, to: statusOf(nextB), ctx: nextB.context })
console.log(`   robot-B(拿旧行 v${staleRow.version})CAS → affected = ${bAffected}(已被 A 推进,安静退出)`)
show('inv_2', NOW)

h('⑩ 机器人再跑一轮:粗筛为空,无事发生(幂等)')
await timeoutCloseJob(NOW, 'robot-A')
