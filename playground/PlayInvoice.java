// ============================================================
// invoice × 最终形态(Java 版):machine + guards + actions
// 对应 playground/play-xstate-sugar.ts。Java 没有 xstate,
// 但机器定义刻意做成 xstate 的读法 —— 状态为主索引,从上往下读:
//
//   PAYMENT.state(PENDING)
//       .on(PAY,   to(CHARGING).guard(...).assign(...))
//       .on(CLOSE, to(CLOSED).guard(...));
//   PAYMENT.state(CHARGING, WAITING)          // hierarchy:群共享的边只声明一次
//       .on(PSP_OK,   to(PAID).assign(...))
//       .on(PSP_FAIL, to(PENDING));
//
// 分层(like vuex):
//   machine  纯同步图 = state + mutation:guard 挂边上,assign 随转移
//            更新 context。commit() 是唯一改状态的口。
//   actions  业务编排:guard 是能力求值(isPayable,直接给前端亮按钮),
//            run 里每步进展发 mutation(RISK_DENIED 等是显式事件)。
//   入口     用户 API → action;渠道 webhook → 直达 mutation。
//
// 建模决定(同 TS 版):
//   · 没有 pay_failed:成功/失败是【一次尝试】的属性;失败只是送发票
//     回 PENDING,重试 = 再 PAY。
//   · refund 是【并行区域】:两台 Machine(payment ∥ refund)= 两个
//     枚举列,各自演化;"能不能退"用跨区域 guard 读另一列(stateIn)。
//
// 生产细节(version CAS / 幂等键 / 恢复任务)刻意省略,见 TS 版。
// 运行:java playground/PlayInvoice.java   (Java 17+)
// ============================================================

import java.time.Duration;
import java.time.Instant;
import java.util.EnumMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.BiConsumer;
import java.util.function.BiPredicate;

public class PlayInvoice {

    // —— 假时钟:now 永远显式传入,所有求值都是纯函数 ——
    static Instant NOW = Instant.parse("2026-08-24T14:00:00Z");

    static void advance(Duration d, String label) {
        NOW = NOW.plus(d);
        System.out.println("\n⏰ 时间推进 " + label + " → " + NOW);
    }

    // ------------------------------------------------------------
    // 0. 事实:发票 = 两个并行区域(payment ∥ refund)+ context
    // ------------------------------------------------------------
    enum PaymentState { PENDING, CHARGING, WAITING, PAID, CLOSED }
    enum RefundState { NONE, REFUND_CALLING, REFUND_WAITING, DONE }
    enum Event { PAY, RISK_DENIED, CHARGE_ACCEPTED, PSP_OK, PSP_FAIL, CLOSE, REFUND, REFUND_ACCEPTED, REFUND_OK, REFUND_FAIL }

    // 无 package 的单文件不能 import static,用别名让机器定义读起来干净
    static final PaymentState PENDING = PaymentState.PENDING, CHARGING = PaymentState.CHARGING,
            WAITING = PaymentState.WAITING, PAID = PaymentState.PAID, CLOSED = PaymentState.CLOSED;
    static final RefundState NONE = RefundState.NONE, REFUND_CALLING = RefundState.REFUND_CALLING,
            REFUND_WAITING = RefundState.REFUND_WAITING, DONE = RefundState.DONE;
    static final Event PAY = Event.PAY, RISK_DENIED = Event.RISK_DENIED, CHARGE_ACCEPTED = Event.CHARGE_ACCEPTED,
            PSP_OK = Event.PSP_OK, PSP_FAIL = Event.PSP_FAIL, CLOSE = Event.CLOSE, REFUND = Event.REFUND,
            REFUND_ACCEPTED = Event.REFUND_ACCEPTED, REFUND_OK = Event.REFUND_OK, REFUND_FAIL = Event.REFUND_FAIL;

    static class Invoice {
        final String id;
        final long amountYen;
        final Instant expiresAt;
        PaymentState payment = PENDING;
        RefundState refund = NONE;
        int attempts = 0; // 第几次支付尝试(失败细节属于尝试,不属于发票)
        Instant paidAt = null;

        Invoice(String id, long amountYen, Instant expiresAt) {
            this.id = id;
            this.amountYen = amountYen;
            this.expiresAt = expiresAt;
        }

        String state() {
            return "payment." + payment + " ∥ refund." + refund;
        }
    }

    static final Map<String, Invoice> db = new LinkedHashMap<>();

    // ------------------------------------------------------------
    // 1. 规则单源:guard、能力求值、展示层共用同一份谓词
    // ------------------------------------------------------------
    static final Duration REFUND_WINDOW = Duration.ofDays(90);

    static boolean notExpired(Invoice c, Instant now) { return now.isBefore(c.expiresAt); }
    static boolean isExpired(Invoice c, Instant now) { return !now.isBefore(c.expiresAt); }
    // 跨区域 guard:退款的前提是 payment 列正处于 PAID(stateIn 的 Java 形态)
    static boolean refundable(Invoice c, Instant now) {
        return c.payment == PAID
                && c.paidAt != null
                && Duration.between(c.paidAt, now).compareTo(REFUND_WINDOW) <= 0;
    }

    // ------------------------------------------------------------
    // 2. 机器引擎(~30 行):状态为主索引的转移表 + builder
    // ------------------------------------------------------------
    static class Tr<S> { // 一条边:落点 + guard + assign
        final S target;
        BiPredicate<Invoice, Instant> guard;
        BiConsumer<Invoice, Instant> assign;
        Tr(S target) { this.target = target; }
        Tr<S> guard(BiPredicate<Invoice, Instant> g) { this.guard = g; return this; }
        Tr<S> assign(BiConsumer<Invoice, Instant> a) { this.assign = a; return this; }
    }

    static <S> Tr<S> to(S target) { return new Tr<>(target); }

    static class Machine<S extends Enum<S>> {
        final Map<S, Map<Event, Tr<S>>> table = new LinkedHashMap<>();

        // state(A) 单状态;state(A, B) 群(hierarchy):同一组边挂到群内每个状态
        @SafeVarargs
        final On<S> state(S... states) { return new On<>(this, states); }

        Tr<S> edge(S current, Event e) {
            Map<Event, Tr<S>> m = table.get(current);
            return m == null ? null : m.get(e);
        }

        static class On<S extends Enum<S>> {
            final Machine<S> machine;
            final S[] states;
            On(Machine<S> machine, S[] states) { this.machine = machine; this.states = states; }
            On<S> on(Event e, Tr<S> tr) {
                for (S s : states)
                    machine.table.computeIfAbsent(s, k -> new EnumMap<>(Event.class)).put(e, tr);
                return this;
            }
        }
    }

    // ------------------------------------------------------------
    // 3. 机器定义:两台 Machine = 两个并行区域,读法同 xstate
    // ------------------------------------------------------------
    static final Machine<PaymentState> PAYMENT = new Machine<>();
    static final Machine<RefundState> REFUND_M = new Machine<>();

    static {
        // —— payment 区域 ——
        PAYMENT.state(PENDING)
                .on(PAY, to(CHARGING).guard(PlayInvoice::notExpired)
                        .assign((c, now) -> c.attempts++)) // 开启新一次尝试
                .on(CLOSE, to(CLOSED).guard(PlayInvoice::isExpired));

        // hierarchy:processing 群(资金结局未知),webhook 边只声明一次
        PAYMENT.state(CHARGING, WAITING)
                .on(PSP_OK, to(PAID).assign((c, now) -> c.paidAt = now))
                .on(PSP_FAIL, to(PENDING)); // 失败属于这次尝试,发票回 PENDING

        PAYMENT.state(CHARGING) // 子状态自己的边(run 的结果 = 显式事件)
                .on(RISK_DENIED, to(PENDING))
                .on(CHARGE_ACCEPTED, to(WAITING));

        // —— refund 区域(与 payment 并行演化)——
        REFUND_M.state(NONE)
                .on(REFUND, to(REFUND_CALLING).guard(PlayInvoice::refundable));

        REFUND_M.state(REFUND_CALLING)
                .on(REFUND_ACCEPTED, to(REFUND_WAITING));

        REFUND_M.state(REFUND_CALLING, REFUND_WAITING)
                .on(REFUND_FAIL, to(NONE)); // 退款失败也属于尝试:回 NONE,可再退

        REFUND_M.state(REFUND_WAITING)
                .on(REFUND_OK, to(DONE));
    }

    // —— canFire(结构 + guard 一步求值)+ commit(唯一的 mutation)——
    static boolean canFire(Invoice inv, Event e, Instant now) {
        Tr<?> tr = PAYMENT.edge(inv.payment, e);
        if (tr == null) tr = REFUND_M.edge(inv.refund, e);
        return tr != null && (tr.guard == null || tr.guard.test(inv, now));
    }

    static boolean commit(String id, Event e, Instant now) {
        Invoice inv = db.get(id);
        if (!canFire(inv, e, now)) {
            System.out.println("   ✗ " + id + " " + e + " 被拒(当前 " + inv.state() + ")");
            return false;
        }
        String before = inv.state();
        Tr<PaymentState> p = PAYMENT.edge(inv.payment, e);
        if (p != null) {
            if (p.assign != null) p.assign.accept(inv, now);
            inv.payment = p.target;
        } else {
            Tr<RefundState> r = REFUND_M.edge(inv.refund, e);
            if (r.assign != null) r.assign.accept(inv, now);
            inv.refund = r.target;
        }
        System.out.println("   ✓ " + id + " " + e + ":" + before + " → " + inv.state()); // transition log
        return true;
    }

    // ------------------------------------------------------------
    // 4. 假的第三方(同步模拟 RPC)
    // ------------------------------------------------------------
    static boolean riskCheck(Invoice c) {
        boolean ok = c.amountYen < 1_000_000;
        System.out.println("   ☎ riskService.check(" + c.id + ") → " + (ok ? "通过" : "拒绝(大额)"));
        return ok;
    }

    static void stripeCall(String kind, Invoice c) {
        System.out.println("   ☎ stripe." + kind + "(" + c.id + ", ¥" + c.amountYen + ") → 已受理,结果将由 webhook 通知");
    }

    // ------------------------------------------------------------
    // 5. actions:guard = 能力求值(引用机器的 canFire,单源);
    //    run = 编排,每步进展发 mutation
    // ------------------------------------------------------------
    record Action(BiPredicate<Invoice, Instant> guard, BiConsumer<String, Instant> run) {}

    static final Map<String, Action> ACTIONS = Map.of(
            "pay", new Action(
                    (inv, now) -> canFire(inv, PAY, now), // isPayable
                    (id, now) -> {
                        if (!commit(id, PAY, now)) return;
                        if (!riskCheck(db.get(id))) {
                            commit(id, RISK_DENIED, now);
                            return;
                        }
                        stripeCall("charge", db.get(id));
                        commit(id, CHARGE_ACCEPTED, now);
                    }),
            "close", new Action(
                    (inv, now) -> canFire(inv, CLOSE, now),
                    (id, now) -> commit(id, CLOSE, now)),
            "refund", new Action(
                    (inv, now) -> canFire(inv, REFUND, now), // isRefundable(跨区域)
                    (id, now) -> {
                        if (!commit(id, REFUND, now)) return;
                        stripeCall("refund", db.get(id));
                        commit(id, REFUND_ACCEPTED, now);
                    }));

    static final List<String> USER_ACTIONS = List.of("pay", "close", "refund");

    // ------------------------------------------------------------
    // 6. 入口:用户 API → action;渠道 webhook → 直达 mutation;GET → 派生
    // ------------------------------------------------------------
    static void api(String id, String name, Instant now) {
        Action a = ACTIONS.get(name);
        if (!a.guard().test(db.get(id), now)) {
            System.out.println("   ✗ 400 " + id + " " + name + ":当前不可执行");
            return;
        }
        a.run().accept(id, now);
    }

    static void webhook(String id, Event e, Instant now) {
        if (!canFire(db.get(id), e, now)) {
            System.out.println("   • " + id + " 回调 " + e + " 被忽略,ACK 200");
            return;
        }
        commit(id, e, now);
    }

    // 展示状态 = 两个区域 + now 的联合派生(expired 不是状态,是派生结论)
    static String displayStatus(Invoice inv, Instant now) {
        if (inv.refund == DONE) return "REFUNDED(已退款)";
        if (inv.refund != NONE) return "REFUNDING(退款中)";
        return switch (inv.payment) {
            case PENDING -> isExpired(inv, now) ? "EXPIRED(已过期)" : "AWAITING_PAYMENT(待支付)";
            case CHARGING, WAITING -> "PROCESSING(支付处理中)";
            case PAID -> "PAID(已支付)";
            case CLOSED -> "CLOSED(已关闭)";
        };
    }

    static void show(String id, Instant now) {
        Invoice inv = db.get(id);
        List<String> buttons = USER_ACTIONS.stream()
                .filter(n -> ACTIONS.get(n).guard().test(inv, now))
                .toList();
        System.out.println("   " + id + " │ state = " + inv.state()
                + " │ GET 下发 = " + displayStatus(inv, now)
                + " │ 按钮 = " + (buttons.isEmpty() ? "[无]" : buttons));
    }

    static void createInvoice(String id, long amountYen, Duration ttl) {
        db.put(id, new Invoice(id, amountYen, NOW.plus(ttl)));
        System.out.println("\n🧾 创建 " + id + ":¥" + amountYen + "," + NOW.plus(ttl) + " 过期");
    }

    // ============================================================
    // 演出(与 play-xstate-sugar.ts 同一套剧目)
    // ============================================================
    static void h(String t) {
        System.out.println("\n" + "─".repeat(64) + "\n■ " + t);
    }

    public static void main(String[] args) {
        h("① 支付失败回到 PENDING:失败是这次尝试的事,发票重新可支付,重试 = 再 PAY");
        createInvoice("inv_1", 12_800, Duration.ofMinutes(30));
        show("inv_1", NOW);
        api("inv_1", "pay", NOW);
        show("inv_1", NOW);
        webhook("inv_1", PSP_FAIL, NOW); // → 回 PENDING,按钮 pay 重新亮起
        show("inv_1", NOW);
        api("inv_1", "pay", NOW); // 第二次尝试(attempts = 2)
        webhook("inv_1", PSP_OK, NOW);
        show("inv_1", NOW);

        h("② 风控拒绝:RISK_DENIED 是显式事件,同样只是送回 PENDING");
        createInvoice("inv_2", 5_000_000, Duration.ofMinutes(30));
        api("inv_2", "pay", NOW);
        show("inv_2", NOW);

        h("③ refund 是并行区域:payment 停在 PAID 不动,refund 列独立演化");
        advance(Duration.ofDays(10), "10 天");
        api("inv_1", "refund", NOW); // guard = payment==PAID && 窗口内
        show("inv_1", NOW);
        webhook("inv_1", REFUND_FAIL, NOW); // 退款失败也属于尝试:回 NONE,可再退
        show("inv_1", NOW);
        api("inv_1", "refund", NOW);
        webhook("inv_1", REFUND_OK, NOW);
        show("inv_1", NOW);

        h("④ 跨区域 guard:未支付的发票点退款,直接拒绝");
        api("inv_2", "refund", NOW);

        h("⑤ expired 是派生视图,CLOSE 之后一切归位");
        advance(Duration.ofDays(21), "21 天(inv_2 早已越过过期线)");
        show("inv_2", NOW); // state 还是 PENDING,显示已是 EXPIRED,按钮只剩 close
        api("inv_2", "close", NOW);
        show("inv_2", NOW);
    }
}
