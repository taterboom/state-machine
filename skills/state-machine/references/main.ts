// ============================================================
// 每个小脚本的用法:machine(state + mutation)+ actions(普通 async 函数)
//
// ⚠️ 跨语言参考:此文件是形态参考,不是要求用 TypeScript。
// 分工:machine 答"这步合不合法"(transition(EVENT) 查白名单,事件有名字);
//       action 就是一个 async 函数——顺序写业务,每步进展 commit 一个事件;
//       guard 是可选的补充(函数开头早退),不写也安全:机器本身兜底。
// statechart 三件套在小脚本里的形态:
//   hierarchy   = machine.json 里的 "working.*" 群边(子状态共享)
//   concurrency = 每个并行区域一台 machine(job ∥ report),互不干扰
//   guard       = action 函数开头的早退判断(可读另一台机器 = 跨区域)
// ============================================================

import machine from './machine.json' with { type: 'json' }
import reportMachine from './report-machine.json' with { type: 'json' }
import { createMachine } from './machine-runtime.ts'

const job = createMachine(machine, 'job')
// concurrency:并行区域 = 再开一台 machine(独立 json、独立 current + history)
const report = createMachine(reportMachine, 'report')

// 假的业务副作用(演示用,确定性)
let polls = 0
const fakeCreate = async () => true
const fakePoll = async () => ++polls > 1 // 第一次没好,第二次好了
const fakeUpload = async () => true

// —— actions:就是普通的 async 函数 ——

async function submit(payload) {
  job.transition('SUBMIT', payload)
  const ok = await fakeCreate() // 副作用在函数里,控制流一眼可见
  job.transition(ok ? 'CREATED' : 'CREATE_FAILED') // 结果是显式事件,日志会讲故事
}

async function poll() {
  job.transition((await fakePoll()) ? 'POLL_OK' : 'POLL_FAIL')
}

let retries = 0
async function retry() {
  // guard(可选):机器信息 + 业务条件,不满足就早退
  if (!job.can('RETRY') || retries >= 2) {
    console.warn(`[job] retry 被拒(状态 ${job.state} 或次数 ${retries} 不允许)`)
    return
  }
  retries++
  job.transition('RETRY')
  job.transition((await fakeCreate()) ? 'CREATED' : 'CREATE_FAILED')
}

function cancel() {
  job.transition('CANCEL') // 群边(hierarchy):working 群内任何子状态都能取消
}

async function publish() {
  // 跨区域 guard:读另一台机器的状态(statechart 的 stateIn)
  if (job.state !== 'done') {
    console.warn(`[report] publish 被拒(job 还在 ${job.state},未完成)`)
    return
  }
  report.transition('UPLOAD')
  report.transition((await fakeUpload()) ? 'UPLOAD_OK' : 'UPLOAD_FAIL')
}

// —— 演示 ——
await submit({ url: '…' }) // SUBMIT: idle → working.creating,CREATED: → working.waiting
cancel() // CANCEL(群边): working.waiting → idle
await publish() // 跨区域 guard 拒绝(job 未完成)

await submit({ url: '…' }) // 再来
await poll() // POLL_FAIL: working.waiting → working.failed
await retry() // RETRY: → working.creating → working.waiting(retries = 1)
await poll() // POLL_OK: working.waiting → done
await publish() // job 已 done → report: none → uploading → published

// 不写 guard 也安全 —— 机器兜底:非法事件只会得到 accepted:false + Invalid 日志
const r = job.transition('SUBMIT') // done 下没有 SUBMIT 这条边
if (!r.accepted) {
  // 机器层唯一的错误通道
}

// 设计期出图不在业务代码里:用 skill 自带的脚本(与项目语言无关)
//   node <skill>/scripts/machine-to-mermaid.mjs ./machine.json
