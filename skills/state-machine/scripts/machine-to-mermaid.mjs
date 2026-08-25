#!/usr/bin/env node
// ============================================================
// machine-to-mermaid —— skill 自带的设计期出图工具
//
// 用法:node machine-to-mermaid.mjs <path/to/machine.json>
// 输出:mermaid stateDiagram-v2 文本(stdout),粘进 README 的
//       ```mermaid 块 / PR 描述 / mermaid.live 即渲染。
//
// 它不属于任何项目的逻辑代码:machine.json 是纯数据、跨语言同一份,
// 所以出图工具只需要这一份——TS / Java / Go / Python 项目都用它,
// 翻译 runtime 时不需要带上它。零依赖单文件,需要进 CI 就直接拷走。
//
// 渲染的是书写界面:群画成复合状态、[*] 标 initial、群边从群出发,
// 与 machine.json 一一对应。图是生成物,不是手维护的。
// ============================================================

import { readFileSync } from 'node:fs'

export function toMermaid(definition) {
  const id = (path) => path.replaceAll('.', '_') // mermaid 的节点 id 不能带点
  const decls = []
  const edges = []

  // 同引擎的解析规则:目标名先在同级找,再逐层向外(指向书写目标:群指向群)
  function resolvePath(targetName, scopes) {
    for (let i = scopes.length - 1; i >= 0; i--) {
      if (scopes[i].states[targetName]) {
        const base = scopes[i].prefix
        return base ? `${base}.${targetName}` : targetName
      }
    }
    throw new Error(`machine: 找不到目标状态 "${targetName}"`)
  }

  function walkStates(prefix, statesMap, initialName, scopes, indent) {
    const pad = '  '.repeat(indent)
    if (initialName) {
      decls.push(`${pad}[*] --> ${id(prefix ? `${prefix}.${initialName}` : initialName)}`)
    }
    for (const [name, node] of Object.entries(statesMap)) {
      const path = prefix ? `${prefix}.${name}` : name
      for (const [event, t] of Object.entries(node.on ?? {})) {
        edges.push(`  ${id(path)} --> ${id(resolvePath(t, scopes))} : ${event}`)
      }
      if (node.states) {
        decls.push(`${pad}state "${name}" as ${id(path)} {`)
        walkStates(path, node.states, node.initial, [...scopes, { prefix: path, states: node.states }], indent + 1)
        decls.push(`${pad}}`)
      } else if (prefix) {
        decls.push(`${pad}state "${name}" as ${id(path)}`) // 群内叶子:短名显示,全路径做 id
      }
    }
  }

  walkStates('', definition.states, definition.initial, [{ prefix: '', states: definition.states }], 1)
  return ['stateDiagram-v2', ...decls, ...edges].join('\n')
}

// —— CLI ——
if (import.meta.main ?? process.argv[1]?.endsWith('machine-to-mermaid.mjs')) {
  const path = process.argv[2]
  if (!path) {
    console.error('用法:node machine-to-mermaid.mjs <path/to/machine.json>')
    process.exit(1)
  }
  console.log(toMermaid(JSON.parse(readFileSync(path, 'utf8'))))
}
