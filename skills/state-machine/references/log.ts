// ============================================================
// 全部观察逻辑 —— console 单行日志 + render 状态图
//
// ⚠️ 跨语言参考:此文件是形态参考,不是要求用 TypeScript。
//    render() 是本模式「长期可读」的核心,必须真正实现,不能留空。
// ============================================================

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
}

export function createLog(machine, name) {
  const history = []

  function transition(result) {
    history.push(result)
    console.log(
      `${C.dim}[${name}]${C.reset} ${result.prev} --${result.event}--> ${result.current}`,
    )
    render(result.current)
  }

  function invalid(result) {
    console.warn(
      `${C.dim}[${name}]${C.reset} ${C.bold}Invalid${C.reset}: ${result.prev} --${result.event}--> ?`,
    )
  }

  // 渲染状态图 + 高亮:
  //   ● 当前状态        加粗
  //   ○ 走过的状态      绿色
  //   ○ 其余状态        变暗
  //   ├─ EVENT ▶ target 走过的边=绿、当前可走的边=正常、其余=暗
  //   trail: a → b → c
  function render(currentState) {
    // 从 history 推导:走过哪些状态、走过哪些边(不另存一份状态)
    const visitedStates = new Set([machine.initial])
    const takenEdges = new Set()
    for (const r of history) {
      visitedStates.add(r.prev)
      visitedStates.add(r.current)
      takenEdges.add(`${r.prev}|${r.event}`)
    }

    const ARROW_COL = 14 // 事件名 + 连字符 对齐到此列
    const lines = ['']

    for (const [state, edges] of Object.entries(machine.states)) {
      const isCurrent = state === currentState
      const isVisited = visitedStates.has(state)
      const marker = isCurrent ? '●' : '○'
      const tag = state === machine.initial ? '  [initial]' : ''

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
    const trail = [machine.initial, ...history.map((r) => r.current)]
    lines.push(`${C.dim}trail:${C.reset} ${trail.join(' → ')}`)

    console.log(lines.join('\n'))
  }

  return { transition, invalid }
}
