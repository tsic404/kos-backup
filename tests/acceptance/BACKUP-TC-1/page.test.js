// BACKUP-AC-1 / BACKUP-TC-1: the backup page read in three states — a policy
// with one completed run, a drill that found a difference, and a policy with no
// target. Each state's items must equal the kernel object it shows, and the
// page must name the reason instead of presenting a missing target as normal.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ENTRY_DRILL,
  ENTRY_RESTORE,
  ITEM_DRILL,
  ITEM_POLICY,
  ITEM_RUNS,
  ITEM_TARGET,
  STALE_THRESHOLD_MS,
  STATE_CONFIGURED,
  STATE_UNCONFIGURED,
  STATE_UNREADABLE,
  buildPage,
  buildUnreadablePage,
} from "../../../assets/app/model.js";
import { createControlPlane } from "../../../assets/app/control.js";
import { submitRestore } from "../../../assets/app/actions.js";
import {
  OBSERVED_AT,
  completedRunPolicy,
  fakeControlPlane,
  failedDrillPolicy,
  noTargetPolicy,
  projectionOf,
} from "../fixtures/controlplane.js";

const BASE = "https://console.apps.kos.tsic.top";
const AT_OBSERVATION = new Date(OBSERVED_AT);

async function readPage(controlPlane, now) {
  const page = await controlPlane.list("BackupPolicy", { namespace: "home" });
  return buildPage({ policies: page.items, now });
}

test("策略、运行、目标与演练逐项等于内核对象", async () => {
  const policy = completedRunPolicy();
  const control = fakeControlPlane({ policies: [policy] });
  const client = createControlPlane({ baseURL: BASE, fetchImpl: control.fetchImpl });

  const page = await readPage(client, AT_OBSERVATION);
  assert.equal(control.requests.length, 1, "一次读取只发一个请求");
  assert.equal(control.requests[0].method, "GET");
  assert.equal(control.requests[0].path, "/api/v1/resources/BackupPolicy");
  assert.equal(control.requests[0].query.namespace, "home");
  assert.equal(control.requests[0].query.limit, undefined, "客户端不隐式翻页");

  assert.equal(page.policies.length, 1);
  const view = page.policies[0];
  assert.equal(view.name, policy.metadata.name);
  assert.equal(view.observedAt, OBSERVED_AT, "页面带投影的观测时间");
  assert.equal(view.stale, false);

  const items = view.items;
  assert.deepEqual(Object.keys(items).sort(), [ITEM_DRILL, ITEM_POLICY, ITEM_RUNS, ITEM_TARGET]);

  // 策略项：阶段与健康取自对象状态。
  assert.equal(items[ITEM_POLICY].state.phase, policy.status.phase);
  assert.equal(items[ITEM_POLICY].state.health, policy.status.health.state);
  assert.equal(items[ITEM_POLICY].policy.schedule, policy.spec.schedule);
  assert.equal(items[ITEM_POLICY].policy.consistency, policy.spec.consistency);
  assert.deepEqual(items[ITEM_POLICY].policy.retention, policy.spec.retention);

  // 运行项：结果取自 lastBackup。
  assert.equal(items[ITEM_RUNS].state, "Succeeded");
  assert.equal(items[ITEM_RUNS].run.succeeded, true);
  assert.equal(items[ITEM_RUNS].run.completedAt, policy.status.lastBackup.completedAt);
  assert.equal(items[ITEM_RUNS].run.baseline.files, policy.status.lastBackup.baseline.files);

  // 目标与失败域：两项都取自 spec.target。
  assert.equal(items[ITEM_TARGET].state, STATE_CONFIGURED);
  assert.equal(items[ITEM_TARGET].target.path, policy.spec.target.path);
  assert.equal(items[ITEM_TARGET].target.failureDomain, policy.spec.target.failureDomain);
  assert.equal(items[ITEM_TARGET].reason, null);

  // 演练项：阶段取自 lastDrill。
  assert.equal(items[ITEM_DRILL].state, policy.status.lastDrill.phase);
  assert.equal(items[ITEM_DRILL].drill.succeeded, true);

  // 入口存在：恢复可用，演练在有一条运行时可提交。
  const entries = Object.fromEntries(view.entries.map((entry) => [entry.id, entry]));
  assert.equal(entries[ENTRY_RESTORE].available, true);
  assert.equal(entries[ENTRY_DRILL].available, true);
});

test("演练产生差异后，同一页读出失败状态、原因与差异项", async () => {
  const policy = failedDrillPolicy();
  const control = fakeControlPlane({ policies: [policy] });
  const client = createControlPlane({ baseURL: BASE, fetchImpl: control.fetchImpl });

  const page = await readPage(client, AT_OBSERVATION);
  const items = page.policies[0].items;

  assert.equal(items[ITEM_DRILL].state, policy.status.lastDrill.phase);
  assert.equal(items[ITEM_DRILL].state, "Failed");
  assert.equal(items[ITEM_DRILL].drill.succeeded, false);
  assert.equal(items[ITEM_DRILL].reason.code, "drill-mismatch");
  assert.match(items[ITEM_DRILL].reason.message, /files/, "原因指向文件数不一致");
  assert.deepEqual(items[ITEM_DRILL].reason.diffs, policy.status.lastDrill.diffs);

  // 演练失败时该次运行不是成功。
  assert.equal(items[ITEM_RUNS].state, "Failed");
  assert.notEqual(items[ITEM_RUNS].state, "Succeeded");
  assert.equal(items[ITEM_RUNS].run.succeeded, false);
  assert.match(items[ITEM_RUNS].reason.message, /files/);
});

test("未配置目标时给出原因，不显示为正常", async () => {
  const policy = noTargetPolicy();
  const control = fakeControlPlane({ policies: [policy] });
  const client = createControlPlane({ baseURL: BASE, fetchImpl: control.fetchImpl });

  const page = await readPage(client, AT_OBSERVATION);
  const target = page.policies[0].items[ITEM_TARGET];

  assert.equal(target.state, STATE_UNCONFIGURED);
  assert.notEqual(target.state, STATE_CONFIGURED);
  assert.equal(target.reason.code, "target-unconfigured");
  assert.match(target.reason.message, /目标/);
  assert.equal(target.target.path, "");
  assert.equal(target.target.failureDomain, "");
});

test("观测时间超过 2 分钟阈值时标记陈旧", async () => {
  const policy = completedRunPolicy();
  const control = fakeControlPlane({ policies: [policy] });
  const client = createControlPlane({ baseURL: BASE, fetchImpl: control.fetchImpl });

  const freshPage = await readPage(client, new Date(AT_OBSERVATION.getTime() + STALE_THRESHOLD_MS));
  assert.equal(freshPage.stale, false, "阈值内不陈旧");
  for (const item of Object.values(freshPage.policies[0].items)) {
    assert.equal(item.stale, false);
  }

  const stalePage = await readPage(client, new Date(AT_OBSERVATION.getTime() + STALE_THRESHOLD_MS + 1));
  assert.equal(stalePage.stale, true, "超过阈值标记陈旧");
  for (const item of Object.values(stalePage.policies[0].items)) {
    assert.equal(item.stale, true);
  }
});

test("对象不可读时页面给原因，不显示为正常", async () => {
  const failure = {
    code: "projection-unavailable",
    message: "控制面暂时无法读取备份策略",
    stage: "read",
    retryable: true,
  };
  const control = fakeControlPlane({
    observedAt: OBSERVED_AT,
    readFailure: failure,
    policies: [completedRunPolicy()],
  });
  const client = createControlPlane({ baseURL: BASE, fetchImpl: control.fetchImpl });

  let error;
  try {
    await client.list("BackupPolicy", { namespace: "home" });
  } catch (thrown) {
    error = thrown;
  }
  assert.ok(error, "读取失败必须抛出而不是空列表");
  assert.equal(error.code, failure.code);
  assert.equal(error.envelope.stage, failure.stage);
  assert.equal(error.envelope.retryable, true, "错误包络字段原样交给调用者");

  const page = buildUnreadablePage({ error, now: AT_OBSERVATION });
  assert.equal(page.state, STATE_UNREADABLE);
  assert.equal(page.policies.length, 0);
  assert.equal(page.reason.code, failure.code);
  assert.match(page.reason.message, /无法读取/);
  assert.equal(page.stale, true, "没有观测就不能声称数据新鲜");
});

test("恢复入口提交的是恢复到新实例，走控制面 API", async () => {
  const policy = completedRunPolicy();
  const control = fakeControlPlane({ policies: [policy] });
  const client = createControlPlane({ baseURL: BASE, fetchImpl: control.fetchImpl });

  const answer = await submitRestore(client, {
    name: "nightly-restore",
    namespace: "home",
    policy: "nightly",
    run: policy.status.lastBackup.path,
    targetApplication: "media-restored",
  });

  assert.equal(control.requests.length, 1, "提交只发一个请求，不等待终态");
  const request = control.requests[0];
  assert.equal(request.method, "POST");
  assert.equal(request.path, "/api/v1/resources/RestoreJob");
  assert.equal(request.query.namespace, "home");
  assert.equal(request.body.kind, "RestoreJob");
  assert.equal(request.body.spec.policy, "nightly");
  assert.equal(request.body.spec.run, policy.status.lastBackup.path, "提交被选中的运行");
  assert.equal(request.body.spec.targetApplication, "media-restored");
  assert.equal(request.body.spec.inPlace, false, "未声明时提交的是恢复到新实例");

  assert.equal(answer.accepted, true, "写请求返回已接受");
  assert.equal(answer.ref.kind, "RestoreJob");
  assert.equal(answer.ref.name, "nightly-restore");
  assert.equal(answer.ref.namespace, "home");
});

test("目标路径已给出但失败域无法判定时给提示，不等于已配置", async () => {
  const { undeterminedDomainPolicy } = await import("../fixtures/controlplane.js");
  const policy = undeterminedDomainPolicy();
  const page = buildPage({ policies: [projectionOf(policy)], now: AT_OBSERVATION });
  const target = page.policies[0].items[ITEM_TARGET];

  assert.equal(target.state, "Undetermined");
  assert.equal(target.reason.code, "failure-domain-undetermined");
  assert.match(target.reason.message, /失败域/);
});
