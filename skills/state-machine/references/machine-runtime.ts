// ============================================================
// 状态机引擎 —— machine(state + mutation)+ 观察,合在一个文件
//
// ⚠️ 跨语言参考:此文件是形态参考,不是要求用 TypeScript。
//    请按用户项目/需求选最合适的语言翻译,契约见 SKILL.md。
//
// 受 statechart 与 vuex 启发:
//   · machine.json 用 xstate 形态书写(嵌套的群、群 initial、on):
//       "working": { "initial": "creating", "on": { "CANCEL": "idle" }, "states": {...} }
//   · 嵌套是【书写界面】,平铺是【运行语义】:createMachine 启动时 compile
//     一次,把嵌套定义编译成「叶子状态 → { EVENT: 叶子落点 }」的平铺表。
//     target 解析、群 initial 下钻、群边下发全部发生在编译期,
//     transition 运行时永远只是一次查表。
//   · target 解析规则:目标名先在同级找,再逐层向外;落到群则沿 initial
//     进入叶子。查边:子状态的边优先,群边兜底(hierarchy)。
//   · concurrency(并行区域):每个区域一台 machine、一个独立 json。
//   · action 是概念,不是 API:就是一个普通 async 函数,顺序写业务,
//     每步进展 commit 一个事件;guard 是可选的补充(函数开头早退)。
//     不写 guard 也安全:非法事件只会得到 accepted:false + Invalid 日志。
// 约定:机器无 onEnter,不自动触发任何动作;副作用全在 action 函数里。
// ============================================================


// ------------------------------------------------------------
// machine 层 —— transition(EVENT) 是唯一改状态的口(mutation)
// ------------------------------------------------------------
export function createMachine(definition, name = 'machine') {
  const model = compile(definition) // 嵌套 → 平铺,启动时一次
  return instantiate(model, name, model.initial)
}

// 所有对普通对象的键查找都必须走 own-property 检查:
// {} 继承 Object.prototype,否则 transition('constructor') 会把原型上的
// 函数当成合法落点(accepted=true、current 变成函数、渲染层崩溃)
const own = (obj, key) => (obj && Object.hasOwn(obj, key) ? obj[key] : undefined)

// 实例:current + history 各自私有;model(编译产物)在实例间共享——编译一次,实例多次
function instantiate(model, name, startAt) {
  if (!own(model.edges, startAt)) throw new Error(`machine: 找不到起点状态 "${startAt}"`)
  let current = startAt
  const log = createLog(model, name, startAt) // history 在 log 内部,实例私有

  function transition(event, payload?) {
    const prev = current
    const target = own(own(model.edges, prev), event)

    // 非法事件也返回完整 result,调用方统一判断 accepted
    const result = {
      accepted: Boolean(target),
      prev,
      current: target ?? prev,
      event,
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
    transition,
    can: (event) => Boolean(own(own(model.edges, current), event)), // 供 action 的 guard 引用
    get state() {
      return current
    },
    // 同一 model 再开一个实例(名字可省略——观察层不向业务索取参数)
    spawn: (n = name) => instantiate(model, n, model.initial),
    // xstate 命名:把持久化状态(DB 等)解析回机器,trail 从解析点开始
    resolveState: (state, n = name) => instantiate(model, n, state),
  }
}


// ------------------------------------------------------------
// 编译 —— 嵌套定义(书写界面)→ 平铺转移表 + 渲染行(运行语义)
// ------------------------------------------------------------
function compile(definition) {
  const edges = {} // 叶子状态 → { EVENT: 叶子落点 }
  const rows = [] // 渲染用:按书写顺序的状态行(带缩进层级)

  // 落到群则沿 initial 进入叶子
  function enterInitial(path, node) {
    while (node.states) {
      path = path ? `${path}.${node.initial}` : node.initial
      node = node.states[node.initial]
    }
    return path
  }

  // 目标名先在同级找,再逐层向外;找不到 = 定义写错,启动即报错
  function resolveTarget(targetName, scopes) {
    for (let i = scopes.length - 1; i >= 0; i--) {
      const node = own(scopes[i].states, targetName) // own-property:防原型键
      if (node) {
        const base = scopes[i].prefix
        return enterInitial(base ? `${base}.${targetName}` : targetName, node)
      }
    }
    throw new Error(`machine: 找不到目标状态 "${targetName}"`)
  }

  function walk(path, stateName, node, scopes, inherited, depth, isInitial) {
    const own = {}
    for (const [event, t] of Object.entries(node.on ?? {})) own[event] = resolveTarget(t, scopes)
    const merged = { ...inherited, ...own } // 子状态的边优先,群边兜底

    const isGroup = Boolean(node.states)
    rows.push({ depth, path, name: stateName, isGroup, isInitial, edges: Object.entries(own) })

    if (isGroup) {
      const childScopes = [...scopes, { prefix: path, states: node.states }]
      for (const [childName, child] of Object.entries(node.states)) {
        walk(`${path}.${childName}`, childName, child, childScopes, merged, depth + 1, childName === node.initial)
      }
    } else {
      edges[path] = merged
    }
  }

  const rootScopes = [{ prefix: '', states: definition.states }]
  for (const [stateName, node] of Object.entries(definition.states)) {
    walk(stateName, stateName, node, rootScopes, {}, 0, stateName === definition.initial)
  }

  const initial = enterInitial('', { initial: definition.initial, states: definition.states })
  return { initial, edges, rows }
}


// ------------------------------------------------------------
// 观察层(内部)—— console 单行日志 + render 状态图
// (设计期出图不在这里:skill 自带 scripts/machine-to-mermaid.mjs,
//  直接吃 machine.json,与项目语言无关——逻辑代码不背文档职责)
// ------------------------------------------------------------
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
}

function createLog(model, name, start = model.initial) {
  const history = []

  function transition(result) {
    history.push(result)
    console.log(`${C.dim}[${name}]${C.reset} ${result.event}: ${result.prev} → ${result.current}`)
    render(result.current)
  }

  function invalid(result) {
    console.warn(
      `${C.dim}[${name}]${C.reset} ${C.bold}Invalid${C.reset}: ${result.prev} ⇥ ${result.event}`,
    )
  }

  // 渲染状态图 + 高亮:
  //   ● 当前状态           加粗;○ 走过的状态 绿色;其余 变暗
  //   ├─ EVENT ─▶ target   走过的边=绿、当前可走的边=正常、其余=暗
  //                        (target 显示编译后的完整落点,含群 initial 下钻)
  //   群按缩进渲染,标 [群];当前/走过 按「群内任一子状态」判定
  //   trail: a → b → c
  function render(currentState) {
    // 从 history 推导:走过哪些状态、走过哪些边(不另存一份状态)
    const visitedStates = new Set([start])
    const takenEdges = new Set()
    for (const r of history) {
      visitedStates.add(r.prev)
      visitedStates.add(r.current)
      takenEdges.add(`${r.prev}|${r.event}`)
    }

    const lines = ['']

    for (const row of rowsOf()) {
      const isCurrent = row.isGroup
        ? currentState.startsWith(row.path + '.')
        : currentState === row.path
      const isVisited = row.isGroup
        ? [...visitedStates].some((s) => s.startsWith(row.path + '.'))
        : visitedStates.has(row.path)
      const indent = '  '.repeat(row.depth)
      const marker = isCurrent ? '●' : '○'
      const tags = `${row.isInitial ? '  [initial]' : ''}${row.isGroup ? '  [群]' : ''}`

      // 状态头:当前=加粗、走过=绿、其余=暗
      const headStyle = isCurrent ? C.bold : isVisited ? C.green : C.dim
      lines.push(`${indent}${headStyle}${marker} ${row.name}${tags}${C.reset}`)

      // 本层声明的出边(群行的边即群边,子状态共享)
      row.edges.forEach(([event, target], i) => {
        const connector = i === row.edges.length - 1 ? '└' : '├'
        const raw = `${connector}─ ${event} ─▶ ${target}`

        const taken = row.isGroup
          ? [...takenEdges].some((k) => k.startsWith(row.path + '.') && k.endsWith(`|${event}`))
          : takenEdges.has(`${row.path}|${event}`)
        const available = isCurrent // 当前状态(或所在群)的出边=下一步可走
        const edgeStyle = taken ? C.green : available ? C.reset : C.dim
        lines.push(`${indent}  ${edgeStyle}${raw}${C.reset}`)
      })
      if (row.depth === 0) lines.push('')
    }

    // trail:走过的状态轨迹(从实例起点开始——resolveState 时即解析点)
    const trail = [start, ...history.map((r) => r.current)]
    lines.push(`${C.dim}trail:${C.reset} ${trail.join(' → ')}`)

    console.log(lines.join('\n'))
  }

  function rowsOf() {
    return model.rows
  }

  return { transition, invalid }
}
