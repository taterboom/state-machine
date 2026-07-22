// ============================================================
// 纯转移引擎 —— 查表 → 换状态 → 交给 log
//
// ⚠️ 跨语言参考:此文件是形态参考,不是要求用 TypeScript。
//    请按用户项目/需求选最合适的语言翻译,契约见 SKILL.md。
// 约定:进入状态不触发任何动作(无 onEnter),
//       副作用由调用方在 transition 返回后自行执行。
// ============================================================

import { createLog } from './log'

export function createMachine(definition, name = 'machine') {
  let current = definition.initial
  const log = createLog(definition, name) // history 在 log 内部,实例私有

  function transition(event, payload) {
    const prev = current
    const next = definition.states[prev]?.[event]

    // 无效转移也返回完整 result,调用方统一判断 accepted
    const result = {
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

    current = next
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
