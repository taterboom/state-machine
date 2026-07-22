// ============================================================
// 状态机引擎 —— 转移 + 观察,合在一个文件
//
// ⚠️ 跨语言参考:此文件是形态参考,不是要求用 TypeScript。
//    请按用户项目/需求选最合适的语言翻译,契约见 SKILL.md。
//
// 只需要「一个 machine.json + 这一个 machine-runtime」,main 里直接用:
//   · createMachine —— 调用方直接说去哪个状态,引擎只校验这步合不合法
//   · createLog(内部)—— 全部观察逻辑:单行日志 + render 状态图
// 约定:调用方直接指定目标状态 to(target),决策在调用处;
//       进入状态不触发任何动作(无 onEnter),副作用由调用方自行执行。
// ============================================================


// ------------------------------------------------------------
// 转移引擎 —— 纯校验:查白名单 → 合法就换状态 → 交给 log
// ------------------------------------------------------------
export function createMachine(definition, name = 'machine') {
  let current = definition.initial
  const log = createLog(definition, name) // history 在 log 内部,实例私有

  function to(target, payload) {
    const prev = current
    const allowed = definition.states[prev]?.includes(target)

    // 非法跳转也返回完整 result,调用方统一判断 accepted
    const result = {
      accepted: Boolean(allowed),
      prev,
      current: allowed ? target : prev,
      target,
      payload,
    }

    if (!result.accepted) {
      log.invalid(result)
      return result
    }

    current = target
    log.transition(result)
    return result
  }

  return {
    to,
    get state() {
      return current
    },
  }
}


// ------------------------------------------------------------
// 观察层(内部)—— console 单行日志 + render 状态图
// ------------------------------------------------------------
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
}

function createLog(machine, name) {
  const history = []

  function transition(result) {
    history.push(result)
    console.log(`${C.dim}[${name}]${C.reset} ${result.prev} → ${result.current}`)
    render(result.current)
  }

  function invalid(result) {
    console.warn(
      `${C.dim}[${name}]${C.reset} ${C.bold}Invalid${C.reset}: ${result.prev} ⇥ ${result.target}`,
    )
  }

  // 渲染状态图 + 高亮:
  //   ● 当前状态        加粗
  //   ○ 走过的状态      绿色
  //   ○ 其余状态        变暗
  //   ├─▶ target        走过的边=绿、当前可走的边=正常、其余=暗
  //   trail: a → b → c
  function render(currentState) {
    // 从 history 推导:走过哪些状态、走过哪些边(不另存一份状态)
    const visitedStates = new Set([machine.initial])
    const takenEdges = new Set()
    for (const r of history) {
      visitedStates.add(r.prev)
      visitedStates.add(r.current)
      takenEdges.add(`${r.prev}|${r.current}`)
    }

    const lines = ['']

    for (const [state, targets] of Object.entries(machine.states)) {
      const isCurrent = state === currentState
      const isVisited = visitedStates.has(state)
      const marker = isCurrent ? '●' : '○'
      const tag = state === machine.initial ? '  [initial]' : ''

      // 状态头:当前=加粗、走过=绿、其余=暗
      const headStyle = isCurrent ? C.bold : isVisited ? C.green : C.dim
      lines.push(`${headStyle}${marker} ${state}${tag}${C.reset}`)

      // 出边(邻接白名单里的可达状态)
      targets.forEach((target, i) => {
        const connector = i === targets.length - 1 ? '└─▶' : '├─▶'
        const raw = `${connector} ${target}`

        const taken = takenEdges.has(`${state}|${target}`)
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
