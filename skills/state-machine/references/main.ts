// ============================================================
// 每个小脚本的用法
//
// ⚠️ 跨语言参考:此文件是形态参考,不是要求用 TypeScript。
// 约定:进入状态不触发任何动作(无 onEnter),
//       副作用由调用方在 transition 返回后自行执行,控制流一眼可见。
// ============================================================

import machine from './machine.json'
import { createMachine } from './machine-runtime'

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
