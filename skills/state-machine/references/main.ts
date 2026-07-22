// ============================================================
// 每个小脚本的用法
//
// ⚠️ 跨语言参考:此文件是形态参考,不是要求用 TypeScript。
// 约定:调用方直接说去哪个状态 to(target),状态机只校验合不合法;
//       进入状态不触发任何动作(无 onEnter),
//       副作用由调用方在 to() 返回后自行执行,控制流一眼可见。
// ============================================================

import machine from './machine.json'
import { createMachine } from './machine-runtime'

const order = createMachine(machine, 'order')

const r = order.to('creating', { bar: 'x' })
if (!r.accepted) {
  // 唯一的错误处理通道(非法跳转)
}

// 副作用写在调用处,控制流可见
if (order.state === 'creating') {
  // doCreate()...
}

order.to('waiting')
order.to('success')

// 多实例互不干扰;回边就是直接跳回去(retry = 回 creating,reset = 回 idle)
const payment = createMachine(machine, 'payment')
payment.to('creating')
payment.to('waiting')
payment.to('failed')
payment.to('creating') // 重试
