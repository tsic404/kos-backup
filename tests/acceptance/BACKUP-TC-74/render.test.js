// BACKUP-AC-37 / BACKUP-TC-74, display layer: the restore form lists the runs
// the policy recorded and preselects the latest one, and the result surface
// shows the restore job's phase, baseline, observed values, created objects and
// preserved source objects. Assertions come from the frozen contract and the
// fixture objects, not from the renderer's own output.
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildPage } from "../../../assets/app/model.js";
import { renderWindow } from "../../../assets/app/render.js";
import {
  OBSERVED_AT,
  RESTORE_RUN,
  completedRunPolicy,
  projectionOf,
  restoreJob,
} from "../fixtures/controlplane.js";
import { attributeIn, entryMarkup, metricsMarkup, restoreMarkup, visibleText } from "../fixtures/display.js";

const AT_OBSERVATION = new Date(OBSERVED_AT);

function render({ policies = [projectionOf(completedRunPolicy())], restores = [] } = {}) {
  return renderWindow(buildPage({ policies, restores, now: AT_OBSERVATION }));
}

test("恢复表单列出运行并默认选中最近一次", () => {
  const policy = completedRunPolicy();
  policy.status.runs = [
    {
      path: "/mnt/backup/home/nightly/2026-02-28",
      completedAt: "2026-02-28T03:10:00Z",
      consistency: "crash-consistent",
      succeeded: true,
    },
    policy.status.lastBackup,
  ];
  const html = render({ policies: [projectionOf(policy)] });
  const form = entryMarkup(html, "restore");

  const select = form.match(/<select[^>]*name="run"[^>]*>/);
  assert.ok(select, "恢复表单有运行选择");
  assert.equal(attributeIn(select[0], "data-default-run"), RESTORE_RUN, "默认选中最近一次运行");

  const options = [...form.matchAll(/<option[^>]*value="([^"]*)"[^>]*>([^<]*)<\/option>/g)];
  assert.equal(options.length, 2, "策略记录的两次运行都可选");
  assert.deepEqual(
    options.map((option) => option[1]),
    ["/mnt/backup/home/nightly/2026-02-28", RESTORE_RUN],
  );
});

test("结果面逐项渲染阶段、基线、观测值与新建对象", () => {
  const job = restoreJob();
  const html = render({ restores: [projectionOf(job)] });
  const text = visibleText(html);

  assert.ok(text.includes("恢复结果"), "页面有恢复结果视图");
  const card = restoreMarkup(html, `${job.metadata.namespace}/${job.metadata.name}`);
  assert.equal(attributeIn(card, "data-phase"), job.status.phase, "阶段等于恢复作业的状态");
  assert.equal(attributeIn(card, "data-verdict"), "Succeeded");
  assert.equal(attributeIn(card, "data-in-place"), "false");

  const baseline = metricsMarkup(card, "baseline");
  assert.ok(baseline, "基线可读");
  assert.equal(attributeIn(baseline, "data-files"), String(job.status.baseline.files));
  assert.equal(attributeIn(baseline, "data-bytes"), String(job.status.baseline.bytes));
  assert.equal(attributeIn(baseline, "data-checksum"), job.status.baseline.checksum);
  assert.match(attributeIn(baseline, "data-tables"), /orders=120/);

  const observed = metricsMarkup(card, "observed");
  assert.ok(observed, "观测值可读");
  assert.equal(attributeIn(observed, "data-files"), String(job.status.observed.files));
  assert.ok(visibleText(observed).includes("观测值"), "观测值与基线分开呈现");

  const created = visibleText(card.slice(card.indexOf("data-created")));
  assert.ok(created.includes("media-restored"), "新应用名可读");
  assert.ok(created.includes("media-restored-data"), "新卷名可读");

  const source = visibleText(card.slice(card.indexOf("data-source")));
  assert.ok(source.includes("media-data-pvc"), "源 PVC 可读");
  assert.ok(source.includes("media-data"), "源卷可读");
  assert.ok(source.includes("保留"), "源对象保留可读");
  assert.ok(!card.includes("data-diffs"), "四项全等时不列差异项");
});

test("恢复结果为空时给空状态，不呈现为空白", () => {
  const text = visibleText(render());

  assert.ok(text.includes("暂无恢复作业"), "没有恢复作业时给出空状态");
});
