"use strict";

// 验证每栏只读开关（PRAGMA query_only）的前端行为：
// 独立开关、请求期间禁用本栏、布尔请求体、状态同步、删除冻结 / 404 /
// 迟到响应隔离与新建重置。响应顺序完全可控，不依赖真实时间与网络。
// 运行：node tests/readonly.test.js

const {
  loadApp,
  flush,
  OLD_STATUS,
  bootOldLive,
  settleNewCreated,
} = require("./harness");

let passed = 0;
let failed = 0;

function assertEq(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}（期望 ${expected}，实际 ${actual}）`);
  }
}
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log("  ✓ " + name);
  } catch (e) {
    failed++;
    console.error("  ✗ " + name);
    console.error("      " + e.message);
  }
}

// 本栏全部可操作元素（5 个按钮 + 加法输入框 + 只读复选框）
function sideEnabled(ctx, side) {
  const enabled = ["begin", "read", "add", "commit", "rollback"].every(
    (op) => ctx.opButton(side, op).disabled === false
  );
  return (
    enabled &&
    ctx.el(`add-input-${side}`).disabled === false &&
    ctx.el(`ro-toggle-${side}`).disabled === false
  );
}
function sideDisabled(ctx, side) {
  const disabled = ["begin", "read", "add", "commit", "rollback"].every(
    (op) => ctx.opButton(side, op).disabled === true
  );
  return (
    disabled &&
    ctx.el(`add-input-${side}`).disabled === true &&
    ctx.el(`ro-toggle-${side}`).disabled === true
  );
}

async function main() {
  // 初始：两栏开关关闭、文案为关闭；状态中的 readonly 同步到文案与复选框
  await test("状态中的 readonly 同步到文案与复选框", async () => {
    const ctx = loadApp("?exp=OLD");
    await bootOldLive(ctx);
    assertEq(ctx.el("ro-a").textContent, "关闭", "甲默认显示关闭");
    assertEq(ctx.el("ro-toggle-a").checked, false, "甲复选框默认不勾");
    assertEq(ctx.el("ro-b").textContent, "关闭", "乙默认显示关闭");

    const before = ctx.calls.length;
    ctx.el("ro-toggle-a").change(true);
    await flush();
    const call = ctx.calls
      .slice(before)
      .find((c) => c.path.includes("/conn/a/readonly") && c.method === "POST");
    if (!call) throw new Error("应发出甲栏只读开关请求");
    assertEq(call.body, JSON.stringify({ enabled: true }), "请求体必须是布尔 true");

    call.settled = true;
    call.resolve({
      status: 200,
      ok: true,
      json: async () => ({
        ok: true,
        error: null,
        state: {
          in_transaction: false,
          readonly: true,
          last_read: null,
          log: ["只读模式：开启 → 成功"],
        },
      }),
    });
    await flush();
    assertEq(ctx.el("ro-a").textContent, "开启", "甲显示开启");
    assertEq(ctx.el("ro-toggle-a").checked, true, "甲复选框已勾选");
    assertEq(ctx.el("ro-a").classList.contains("on"), true, "开启时加 on 样式");
  });

  // 请求期间禁用本栏全部控件，另一栏不受影响；结束后恢复
  await test("开关请求进行中禁用本栏、另一栏照常；完成后恢复", async () => {
    const ctx = loadApp("?exp=OLD");
    await bootOldLive(ctx);

    ctx.el("ro-toggle-b").change(true);
    await flush();
    if (!sideDisabled(ctx, "b")) throw new Error("请求中乙栏应全部禁用");
    if (!sideEnabled(ctx, "a")) throw new Error("乙请求不得禁用甲栏");

    ctx.settle("/OLD/conn/b/readonly", 200, {
      ok: true,
      error: null,
      state: { in_transaction: false, readonly: true, last_read: null, log: [] },
    });
    await flush();
    if (!sideEnabled(ctx, "b")) throw new Error("完成后乙栏应恢复可用");
  });

  // 两栏独立：甲开启不影响乙的请求与状态
  await test("两栏开关互相独立", async () => {
    const ctx = loadApp("?exp=OLD");
    await bootOldLive(ctx);
    const before = ctx.calls.length;

    ctx.el("ro-toggle-a").change(true);
    await flush();
    const aCall = ctx.calls
      .slice(before)
      .find((c) => c.path.includes("/conn/a/readonly"));
    aCall.settled = true;
    aCall.resolve({
      status: 200,
      ok: true,
      json: async () => ({
        ok: true,
        error: null,
        state: { in_transaction: false, readonly: true, last_read: null, log: [] },
      }),
    });
    await flush();

    assertEq(ctx.el("ro-a").textContent, "开启", "甲开启");
    assertEq(ctx.el("ro-b").textContent, "关闭", "乙仍关闭");
    assertEq(ctx.el("ro-toggle-b").checked, false, "乙复选框不勾");

    // 甲在只读时，乙栏仍可发起自己的开关请求（路径落在 b）
    const before2 = ctx.calls.length;
    ctx.el("ro-toggle-b").change(true);
    await flush();
    const bCall = ctx.calls
      .slice(before2)
      .find((c) => c.path.includes("/OLD/conn/b/readonly"));
    if (!bCall) throw new Error("乙应能独立发起开关请求");
    assertEq(bCall.body, JSON.stringify({ enabled: true }), "乙请求体为布尔");
  });

  // 瞬时请求失败：复选框回退、显示错误、控件恢复
  await test("开关请求网络失败：复选框回退、错误显示在本栏", async () => {
    const ctx = loadApp("?exp=OLD");
    await bootOldLive(ctx);
    ctx.el("ro-toggle-a").change(true);
    await flush();
    const call = ctx.findCall("/OLD/conn/a/readonly", "POST");
    call.settled = true;
    call.reject(new TypeError("network down"));
    await flush();
    assertEq(ctx.el("ro-toggle-a").checked, false, "失败后复选框回退");
    assertEq(ctx.el("error-a").hidden, false, "本栏显示错误");
    if (!sideEnabled(ctx, "a")) throw new Error("失败后本栏恢复可用");
    assertEq(ctx.el("ro-a").textContent, "关闭", "文案保持关闭");
  });

  // 410：冻结，旧控件禁用、轮询停止，与其它旧操作规则一致
  await test("开关请求 410：冻结旧实验", async () => {
    const ctx = loadApp("?exp=OLD");
    await bootOldLive(ctx);
    ctx.el("ro-toggle-a").change(true);
    await flush();
    ctx.settle("/OLD/conn/a/readonly", 410, {});
    await flush();
    assertEq(ctx.app().expFrozen, true, "410 后冻结");
    assertEq(ctx.app().timerCount, 0, "轮询停止");
    assertEq(ctx.el("deleted-note").hidden, false, "显示冻结提示");
    if (!sideDisabled(ctx, "a") || !sideDisabled(ctx, "b")) {
      throw new Error("两栏都应禁用");
    }
  });

  // 404：沿用旧语义自动新建；新建成功后开关重置为关闭
  await test("开关请求 404：自动新建，新实验开关重置", async () => {
    const ctx = loadApp("?exp=OLD");
    await bootOldLive(ctx);
    ctx.el("ro-toggle-a").change(true);
    await flush();
    // 请求在途时复选框为勾选
    assertEq(ctx.el("ro-toggle-a").checked, true, "请求中复选框为新状态");
    ctx.settle("/OLD/conn/a/readonly", 404, {});
    await flush();
    await settleNewCreated(ctx);
    assertEq(ctx.app().expId, "NEW", "404 后切到 NEW");
    assertEq(ctx.el("ro-toggle-a").checked, false, "新实验复选框重置为不勾");
    assertEq(ctx.el("ro-a").textContent, "关闭", "新实验文案为关闭");
  });

  // 迟到响应：开关在途期间新建，旧 200 不得改变新页面
  await test("旧开关 200 在新建成功后收尾：不改新页面只读状态", async () => {
    const ctx = loadApp("?exp=OLD");
    await bootOldLive(ctx);
    ctx.el("ro-toggle-a").change(true);
    await flush();
    const oldCall = ctx.findCall("/OLD/conn/a/readonly", "POST");

    ctx.el("new-exp").click();
    await flush();
    await settleNewCreated(ctx);
    assertEq(ctx.app().expId, "NEW", "已切到 NEW");

    oldCall.settled = true;
    oldCall.resolve({
      status: 200,
      ok: true,
      json: async () => ({
        ok: true,
        error: null,
        state: { in_transaction: true, readonly: true, last_read: 105, log: ["OLD-ro"] },
      }),
    });
    await flush();
    assertEq(ctx.app().expId, "NEW", "迟到响应后仍为 NEW");
    assertEq(ctx.el("ro-a").textContent, "关闭", "迟到只读=true 不得覆盖新页面");
    assertEq(ctx.el("ro-toggle-a").checked, false, "新复选框不被迟到响应勾选");
  });

  // 新建 / 冻结期间点击开关不发请求
  await test("冻结页操作复选框不发请求", async () => {
    const ctx = loadApp("?exp=OLD");
    await flush();
    ctx.settle("/OLD/status", 410, {});
    await flush();
    assertEq(ctx.app().expFrozen, true, "前置：已冻结");
    const before = ctx.calls.length;
    ctx.el("ro-toggle-b").change(true);
    await flush();
    assertEq(ctx.calls.length, before, "冻结时不得发开关请求");
    assertEq(ctx.el("ro-toggle-b").checked, false, "冻结复选框保持不勾");
  });

  // 交错（issue 原场景）：关闭态勾选开启，开关请求仍在途时状态轮询先确认
  // readonly=true；随后开关请求失败。复选框与文案必须一致，且按「最近一次
  // 服务端确认的模式」恢复（此时即轮询已确认的开启），错误显示在本栏。
  await test("在途轮询先确认开启、开关请求后失败：按新确认模式恢复且勾选与文案一致", async () => {
    const ctx = loadApp("?exp=OLD");
    await bootOldLive(ctx);
    assertEq(ctx.el("ro-a").textContent, "关闭", "前置：文案关闭");
    assertEq(ctx.el("ro-toggle-a").checked, false, "前置：复选框未勾");

    ctx.el("ro-toggle-a").change(true);
    await flush();
    const roCall = ctx.findCall("/OLD/conn/a/readonly", "POST");
    assertEq(ctx.el("ro-toggle-a").checked, true, "点击后复选框先勾选");
    if (!sideDisabled(ctx, "a")) throw new Error("请求中甲栏禁用");

    // 开关请求仍在途：状态轮询先确认服务端已是 readonly=true。
    // 复用 OLD_STATUS 的其余字段，只把 a.readonly 置 true，因此该状态与
    // 上次渲染不同（日志 / read 字段保持，仅 readonly 变化），会正常渲染。
    ctx.tickTimers(1);
    await flush();
    const pollStatus = ctx.findCall("/OLD/status", "GET");
    pollStatus.settled = true;
    pollStatus.resolve({
      status: 200,
      ok: true,
      json: async () => {
        const body = OLD_STATUS();
        body.a.readonly = true;
        body.a.log = ["OLD-a-log"]; // 与首次渲染同日志
        return body;
      },
    });
    await flush();
    assertEq(ctx.el("ro-a").textContent, "开启", "轮询先确认：文案变开启");
    assertEq(ctx.el("ro-toggle-a").checked, true, "轮询先确认：复选框勾选");

    // 随后开关请求本身失败（响应丢失 / 网络错误）
    roCall.settled = true;
    roCall.reject(new TypeError("network down"));
    await flush();

    // 关键断言：不得出现复选框退回关闭、文案仍为开启的矛盾
    assertEq(ctx.el("ro-a").textContent, "开启", "失败后文案仍为轮询已确认的开启");
    assertEq(ctx.el("ro-toggle-a").checked, true, "失败后复选框保持与文案一致的勾选");
    assertEq(ctx.el("ro-a").classList.contains("on"), true, "开启样式保留");
    assertEq(ctx.el("error-a").hidden, false, "失败错误显示在本栏");
    if (!sideEnabled(ctx, "a")) throw new Error("失败后本栏控件恢复可用");
    if (!sideEnabled(ctx, "b")) throw new Error("请求期间另一栏始终可操作，结束后亦然");
  });

  // 相同状态返回也能纠正本地偏差：在确认 readonly=true 后制造本地矛盾
  // （只把复选框拨回关闭，文案仍开启），随后返回与上次完全相同的状态
  // （lastRender 命中去重）；去重短路也必须把复选框重新拉回，无须等待
  // 日志或读值变化。
  await test("相同状态的轮询（无日志 / 读值变化）也能纠正复选框与文案偏差", async () => {
    const ctx = loadApp("?exp=OLD");
    await bootOldLive(ctx);

    // 先经轮询确认甲栏 readonly=true
    ctx.tickTimers(1);
    await flush();
    const p1 = ctx.findCall("/OLD/status", "GET");
    p1.settled = true;
    p1.resolve({
      status: 200,
      ok: true,
      json: async () => {
        const body = OLD_STATUS();
        body.a.readonly = true;
        return body;
      },
    });
    await flush();
    assertEq(ctx.el("ro-a").textContent, "开启", "前置：文案开启");
    assertEq(ctx.el("ro-toggle-a").checked, true, "前置：复选框勾选");

    // 模拟本地偏差：复选框被拨回关闭（等价于一次失败回退只改了勾选），
    // 文案却仍是开启——正是修复前失败路径制造的矛盾。
    ctx.el("ro-toggle-a").checked = false;
    assertEq(ctx.el("ro-a").textContent, "开启", "制造矛盾：文案开启");
    assertEq(ctx.el("ro-toggle-a").checked, false, "制造矛盾：复选框关闭");

    // 再来一轮轮询：返回与上次渲染逐字段完全相同的状态
    ctx.tickTimers(1);
    await flush();
    const p2 = ctx.findCall("/OLD/status", "GET");
    p2.settled = true;
    p2.resolve({
      status: 200,
      ok: true,
      json: async () => {
        const body = OLD_STATUS();
        body.a.readonly = true;
        return body;
      },
    });
    await flush();

    assertEq(ctx.el("ro-a").textContent, "开启", "同状态返回：文案仍开启");
    assertEq(
      ctx.el("ro-toggle-a").checked,
      true,
      "同状态返回也必须把复选框纠正回勾选，而非被去重短路放过"
    );

    // 反向偏差：文案被本地改成关闭（仅为构造偏差），相同状态轮询同样纠正文案
    ctx.el("ro-a").textContent = "关闭";
    ctx.el("ro-toggle-a").checked = false;
    ctx.tickTimers(1);
    await flush();
    const p3 = ctx.findCall("/OLD/status", "GET");
    p3.settled = true;
    p3.resolve({
      status: 200,
      ok: true,
      json: async () => {
        const body = OLD_STATUS();
        body.a.readonly = true;
        return body;
      },
    });
    await flush();
    assertEq(ctx.el("ro-a").textContent, "开启", "同状态返回纠正文案");
    assertEq(ctx.el("ro-toggle-a").checked, true, "同状态返回纠正复选框");
  });

  // 失败且在途没有新确认：恢复原已确认模式（关闭态勾选开启后失败 → 关闭）
  await test("在途无新确认时开关失败：文案与复选框一致恢复原已确认的关闭", async () => {
    const ctx = loadApp("?exp=OLD");
    await bootOldLive(ctx);

    // 先放行一轮与初始完全相同的轮询（readonly 全 false），
    // 使「相同状态也同步」的路径先跑一遍：不应产生任何变化。
    ctx.tickTimers(1);
    await flush();
    const poll = ctx.findCall("/OLD/status", "GET");
    poll.settled = true;
    poll.resolve({ status: 200, ok: true, json: async () => OLD_STATUS() });
    await flush();
    assertEq(ctx.el("ro-a").textContent, "关闭", "同状态轮询后文案仍关闭");
    assertEq(ctx.el("ro-toggle-a").checked, false, "同状态轮询后复选框仍不勾");

    ctx.el("ro-toggle-a").change(true);
    await flush();
    assertEq(ctx.el("ro-a").textContent, "关闭", "请求在途：文案尚未变化");
    assertEq(ctx.el("ro-toggle-a").checked, true, "请求在途：复选框先勾选");
    if (!sideEnabled(ctx, "b")) throw new Error("甲请求期间乙栏应可操作");

    // 不做任何轮询确认，开关请求直接失败
    ctx.rejectRequest("/OLD/conn/a/readonly", new TypeError("network down"), "POST");
    await flush();

    assertEq(ctx.el("ro-toggle-a").checked, false, "失败后复选框恢复关闭");
    assertEq(ctx.el("ro-a").textContent, "关闭", "失败后文案也必须是关闭（修复前残留开启）");
    assertEq(ctx.el("ro-a").classList.contains("on"), false, "关闭样式");
    assertEq(ctx.el("error-a").hidden, false, "错误显示在本栏");
    if (!sideEnabled(ctx, "a")) throw new Error("失败后本栏恢复可用");
  });

  // 反向：已确认开启，取消勾选（请求关闭）失败且在途无新确认 → 恢复开启，
  // 两个方向都不得出现勾选与文案矛盾。
  await test("开启态取消勾选后失败且在途无新确认：文案与复选框一致恢复开启", async () => {
    const ctx = loadApp("?exp=OLD");
    await bootOldLive(ctx);

    // 经一次成功的开关请求确认甲栏已开启
    ctx.el("ro-toggle-a").change(true);
    await flush();
    ctx.settle("/OLD/conn/a/readonly", 200, {
      ok: true,
      error: null,
      state: {
        in_transaction: false,
        readonly: true,
        last_read: null,
        log: ["只读模式：开启 → 成功"],
      },
    });
    await flush();
    assertEq(ctx.el("ro-a").textContent, "开启", "前置：已确认开启");
    assertEq(ctx.el("ro-toggle-a").checked, true, "前置：复选框勾选");

    // 取消勾选，关闭请求在途且无轮询确认，随后失败
    ctx.el("ro-toggle-a").change(false);
    await flush();
    assertEq(ctx.el("ro-toggle-a").checked, false, "请求在途：复选框先取消");
    assertEq(ctx.el("ro-a").textContent, "开启", "请求在途：文案仍为已确认的开启");
    ctx.settle("/OLD/conn/a/readonly", 500, {});
    await flush();

    assertEq(ctx.el("ro-toggle-a").checked, true, "失败后复选框恢复已确认的勾选");
    assertEq(ctx.el("ro-a").textContent, "开启", "失败后文案与复选框一致为开启");
    assertEq(ctx.el("error-a").hidden, false, "500 错误显示在本栏");
    if (!sideEnabled(ctx, "a")) throw new Error("失败后本栏恢复可用");

    // 再来一轮相同状态（readonly=true）轮询：保持一致、不回退
    ctx.tickTimers(1);
    await flush();
    const poll = ctx.findCall("/OLD/status", "GET");
    poll.settled = true;
    poll.resolve({
      status: 200,
      ok: true,
      json: async () => {
        const body = OLD_STATUS();
        body.a.readonly = true;
        return body;
      },
    });
    await flush();
    assertEq(ctx.el("ro-toggle-a").checked, true, "同状态轮询后仍勾选");
    assertEq(ctx.el("ro-a").textContent, "开启", "同状态轮询后文案仍开启");
  });

  // 两栏分别适用：乙栏在途轮询先确认开启、开关请求失败，与甲栏同样恢复一致；
  // 且甲栏在整个交错期间始终可操作。
  await test("乙栏同样适用：在途确认开启后失败，乙栏一致恢复，甲栏全程可操作", async () => {
    const ctx = loadApp("?exp=OLD");
    await bootOldLive(ctx);

    ctx.el("ro-toggle-b").change(true);
    await flush();
    if (!sideDisabled(ctx, "b")) throw new Error("请求中乙栏禁用");
    if (!sideEnabled(ctx, "a")) throw new Error("请求中甲栏可操作");

    // 乙栏在途：轮询确认 b.readonly=true
    ctx.tickTimers(1);
    await flush();
    const pollStatus = ctx.findCall("/OLD/status", "GET");
    pollStatus.settled = true;
    pollStatus.resolve({
      status: 200,
      ok: true,
      json: async () => {
        const body = OLD_STATUS();
        body.b.readonly = true;
        return body;
      },
    });
    await flush();
    assertEq(ctx.el("ro-b").textContent, "开启", "轮询确认乙文案开启");
    assertEq(ctx.el("ro-toggle-b").checked, true, "轮询确认乙复选框勾选");

    // 乙的开关请求失败
    ctx.rejectRequest("/OLD/conn/b/readonly", new TypeError("network down"), "POST");
    await flush();
    assertEq(ctx.el("ro-b").textContent, "开启", "失败后乙文案仍为已确认开启");
    assertEq(ctx.el("ro-toggle-b").checked, true, "失败后乙复选框与文案一致");
    assertEq(ctx.el("error-b").hidden, false, "错误显示在乙栏");
    assertEq(ctx.el("error-a").hidden, true, "错误不得串到甲栏");
    assertEq(ctx.el("ro-a").textContent, "关闭", "甲栏不受影响");
    assertEq(ctx.el("ro-toggle-a").checked, false, "甲栏复选框不受影响");
    if (!sideEnabled(ctx, "b") || !sideEnabled(ctx, "a")) {
      throw new Error("结束后两栏都应恢复可用");
    }
  });

  console.log(`\n${passed} 通过，${failed} 失败`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
