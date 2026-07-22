// ============================================================
// 通用小脚本状态机 —— 跨语言参考范例
//
// ⚠️ 这份文件是「形态参考」,不是「必须用 TypeScript」。
//    请按用户的项目和需求,选最合适的语言照此结构翻译:
//    Python 爬虫/数据脚本、TS/JS Node、Go CLI/后端、Bash 胶水……
//    翻译时保持下面的「设计契约」不变(见 SKILL.md),尤其是:
//      · machine 定义 = 纯数据
//      · 转移引擎 = 纯查表,不含业务副作用
//      · log 层 = 全部观察逻辑(单行日志 + render 状态图)
//      · 无 onEnter,副作用留在调用处
//      · 无效转移也返回完整 result,统一用 accepted 判断
//
// 三层职责:
//   machine    —— 纯数据:状态有哪些、什么事件到哪
//   runtime    —— 纯转移引擎:查表 → 换状态 → 交给 log
//   log        —— 全部观察逻辑:console 单行日志 + render 状态图
// ============================================================


// ------------------------------------------------------------
// 类型
// ------------------------------------------------------------
type Transitions = Record<string, Record<string, string>>

interface MachineDef {
  initial: string
  states: Transitions
}

interface Result {
  accepted: boolean
  prev: string
  current: string
  event: string
  payload?: unknown
}


// ------------------------------------------------------------
// machine —— 纯数据(实际项目里可拆成独立的 machine.json)
// ------------------------------------------------------------
const machine: MachineDef = {
  initial: 'idle',
  states: {
    idle:     { CREATE: 'creating' },
    creating: { CREATED: 'waiting', FAILURE: 'failed' },
    waiting:  { SUCCESS: 'success', FAILURE: 'failed' },
    failed:   { RETRY: 'creating', RESET: 'idle' },
    success:  { RESET: 'idle' },
  },
}


// ------------------------------------------------------------
// runtime —— 纯转移引擎(machine-runtime.ts)
// ------------------------------------------------------------
export function createMachine(definition: MachineDef, name = 'machine') {
  let current = definition.initial
  const log = createLog(definition, name) // history 在 log 内部,实例私有

  function transition(event: string, payload?: unknown): Result {
    const prev = current
    const next = definition.states[prev]?.[event]

    // 无效转移也返回完整 result,调用方统一判断 accepted
    const result: Result = {
      accepted: Boolean(next),
      prev,
      current: next ?? prev,
      event,
      payload,
    }

    if (!result.accepted) {
      log.invalid(result)
      return result
    }

    current = next!
    log.transition(result)
    return result
  }

  return {
    transition,
    get state() {
      return current
    },
  }
}


// ------------------------------------------------------------
// log —— 全部观察逻辑(log.ts)
// ------------------------------------------------------------
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
}

export function createLog(definition: MachineDef, name: string) {
  const history: Result[] = []

  function transition(result: Result) {
    history.push(result)
    console.log(
      `${C.dim}[${name}]${C.reset} ${result.prev} --${result.event}--> ${result.current}`,
    )
    render(result.current)
  }

  function invalid(result: Result) {
    console.warn(
      `${C.dim}[${name}]${C.reset} ${C.bold}Invalid${C.reset}: ${result.prev} --${result.event}--> ?`,
    )
  }

  // 渲染状态图 + 高亮:
  //   ● 当前状态       加粗
  //   ○ 走过的状态     绿色
  //   ○ 其余状态       变暗
  //   ├─ EVENT ▶ target   走过的边=绿、当前可走的边=正常、其余=暗
  //   trail: a → b → c
  function render(currentState: string) {
    // 从 history 推导:走过哪些状态、走过哪些边
    const visitedStates = new Set<string>([definition.initial])
    const takenEdges = new Set<string>()
    for (const r of history) {
      visitedStates.add(r.prev)
      visitedStates.add(r.current)
      takenEdges.add(`${r.prev}|${r.event}`)
    }

    const ARROW_COL = 14 // 事件名 + 连字符 对齐到此列
    const lines: string[] = ['']

    for (const [state, edges] of Object.entries(definition.states)) {
      const isCurrent = state === currentState
      const isVisited = visitedStates.has(state)
      const marker = isCurrent ? '●' : '○'
      const tag = state === definition.initial ? '  [initial]' : ''

      // 状态头:当前=加粗、走过=绿、其余=暗
      const headStyle = isCurrent ? C.bold : isVisited ? C.green : C.dim
      lines.push(`${headStyle}${marker} ${state}${tag}${C.reset}`)

      // 出边
      const entries = Object.entries(edges)
      entries.forEach(([event, target], i) => {
        const connector = i === entries.length - 1 ? '└─' : '├─'
        const dashes = '─'.repeat(Math.max(3, ARROW_COL - event.length))
        const raw = `${connector} ${event} ${dashes}▶ ${target}`

        const taken = takenEdges.has(`${state}|${event}`)
        const available = isCurrent // 当前状态的出边=下一步可走
        const edgeStyle = taken ? C.green : available ? C.reset : C.dim
        lines.push(`  ${edgeStyle}${raw}${C.reset}`)
      })
      lines.push('')
    }

    // trail:走过的状态轨迹
    const trail = [definition.initial, ...history.map((r) => r.current)]
    lines.push(`${C.dim}trail:${C.reset} ${trail.join(' → ')}`)

    console.log(lines.join('\n'))
  }

  return { transition, invalid }
}


// ------------------------------------------------------------
// main —— 每个小脚本的用法(main.ts)
// ------------------------------------------------------------
// 约定:进入状态不触发任何动作(无 onEnter),
//       副作用由调用方在 transition 返回后自行执行,控制流一眼可见。

const order = createMachine(machine, 'order')

const r = order.transition('CREATE', { bar: 'x' })
if (!r.accepted) {
  // 唯一的错误处理通道
}

// 副作用写在调用处,控制流可见
if (order.state === 'creating') {
  // doCreate()...
}

order.transition('CREATED')
order.transition('SUCCESS')

// 多实例互不干扰
const payment = createMachine(machine, 'payment')
payment.transition('CREATE')
payment.transition('CREATED')
payment.transition('FAILURE')
payment.transition('RETRY')
