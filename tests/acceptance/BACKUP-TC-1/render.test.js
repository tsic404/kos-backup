// BACKUP-AC-1 / BACKUP-TC-1, display layer: the four items every policy shows,
// the stale marker, the reason a target is not normal, and the two entries are
// read from the rendered window document. Assertions come from the frozen
// contract and the fixture objects, not from the renderer's own output.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  STALE_THRESHOLD_MS,
  buildPage,
  buildUnreadablePage,
} from "../../../assets/app/model.js";
import { renderWindow } from "../../../assets/app/render.js";
import {
  OBSERVED_AT,
  completedRunPolicy,
  noTargetPolicy,
  projectionOf,
} from "../fixtures/controlplane.js";
import { attributeIn, entryMarkup, itemMarkup, visibleText } from "../fixtures/display.js";

const AT_OBSERVATION = new Date(OBSERVED_AT);

function render(policy, now = AT_OBSERVATION) {
  return renderWindow(buildPage({ policies: [projectionOf(policy)], now }));
}

test("四项视图逐项渲染，每项读出的状态等于内核对象", () => {
  const policy = completedRunPolicy();
  const html = render(policy);
  const text = visibleText(html);

  for (const heading of ["策略", "运行", "目标与失败域", "演练与差异项"]) {
    assert.ok(text.includes(heading), `页面缺少「${heading}」视图`);
  }

  const policyItem = itemMarkup(html, "policy");
  assert.equal(attributeIn(policyItem, "data-phase"), policy.status.phase);
  assert.equal(attributeIn(policyItem, "data-health"), policy.status.health.state);
  assert.ok(visibleText(policyItem).includes(policy.spec.schedule), "计划可读");
  assert.ok(visibleText(policyItem).includes(policy.spec.consistency), "一致性等级可读");
  assert.ok(visibleText(policyItem).includes("keep=7"), "保留可读");

  const runsItem = itemMarkup(html, "runs");
  assert.equal(attributeIn(runsItem, "data-state"), "Succeeded");
  assert.ok(visibleText(runsItem).includes(policy.status.lastBackup.completedAt), "完成时间可读");
  assert.ok(visibleText(runsItem).includes(String(policy.status.lastBackup.baseline.files)), "基线文件数可读");

  const targetItem = itemMarkup(html, "target");
  assert.equal(attributeIn(targetItem, "data-state"), "Configured");
  assert.ok(visibleText(targetItem).includes(policy.spec.target.path), "目标路径可读");
  assert.ok(visibleText(targetItem).includes(policy.spec.target.failureDomain), "失败域可读");

  const drillItem = itemMarkup(html, "drill");
  assert.equal(attributeIn(drillItem, "data-state"), policy.status.lastDrill.phase);
  assert.ok(visibleText(drillItem).includes(policy.status.lastDrill.run), "演练对象可读");
});

test("观测时间超过两分钟阈值时页面与每一项都标出陈旧", () => {
  const policy = completedRunPolicy();

  const fresh = render(policy, new Date(AT_OBSERVATION.getTime() + STALE_THRESHOLD_MS));
  assert.ok(!visibleText(fresh).includes("数据陈旧"), "阈值内不标陈旧");

  const stale = render(policy, new Date(AT_OBSERVATION.getTime() + STALE_THRESHOLD_MS + 1));
  for (const item of ["policy", "runs", "target", "drill"]) {
    assert.ok(
      visibleText(itemMarkup(stale, item)).includes("数据陈旧"),
      `「${item}」项缺少陈旧标记`,
    );
  }
});

test("未配置目标时渲染原因，不显示为正常", () => {
  const target = itemMarkup(render(noTargetPolicy()), "target");

  assert.equal(attributeIn(target, "data-state"), "Unconfigured");
  assert.notEqual(attributeIn(target, "data-state"), "Configured");
  assert.equal(attributeIn(target, "data-code"), "target-unconfigured");
  assert.match(visibleText(target), /未指定备份目标/);
});

test("对象不可读时渲染原因与错误代码，不呈现为空白页", () => {
  const error = {
    code: "projection-unavailable",
    message: "控制面暂时无法读取备份策略",
    status: 503,
  };
  const html = renderWindow(buildUnreadablePage({ error, now: AT_OBSERVATION }));
  const text = visibleText(html);

  assert.equal(attributeIn(html, "data-state"), "Unreadable");
  assert.ok(text.includes("projection-unavailable"), "错误代码可读");
  assert.ok(text.includes("控制面暂时无法读取备份策略"), "原因可读");
  assert.ok(text.includes("HTTP 503"), "失败阶段以外的状态可读");
  assert.equal(itemMarkup(html, "policy"), "", "不可读时不渲染成空策略");
  assert.ok(html.includes('data-action="reload"'), "给出重新读取入口");
});

test("恢复入口渲染表单，原地声明默认不勾选", () => {
  const form = entryMarkup(render(completedRunPolicy()), "restore");

  assert.ok(form.includes('name="targetApplication"'), "目标应用字段存在");
  assert.ok(form.includes('name="policy"'), "来源策略字段存在");
  assert.ok(form.includes('name="name"'), "作业名称字段存在");
  assert.ok(visibleText(form).includes("恢复到新实例"), "提交按钮指向新实例");

  const inPlaceInput = form.match(/<input[^>]*name="inPlace"[^>]*>/);
  assert.ok(inPlaceInput, "原地声明字段存在");
  assert.ok(!/\bchecked\b/.test(inPlaceInput[0]), "默认不声明原地恢复");
});

test("演练入口在有运行时可提交，无运行时禁用并给出原因", () => {
  const ready = entryMarkup(render(completedRunPolicy()), "drill");
  const readyButton = ready.match(/<button[^>]*data-action="drill"[^>]*>/);
  assert.ok(readyButton, "演练按钮存在");
  assert.ok(!/\bdisabled\b/.test(readyButton[0]), "有运行时演练入口可用");

  const policy = completedRunPolicy();
  delete policy.status.lastBackup;
  delete policy.status.lastDrill;
  const blocked = entryMarkup(render(policy), "drill");
  const blockedButton = blocked.match(/<button[^>]*data-action="drill"[^>]*>/);
  assert.ok(blockedButton, "演练按钮仍在");
  assert.ok(/\bdisabled\b/.test(blockedButton[0]), "没有运行时演练入口不可提交");
  assert.match(visibleText(blocked), /没有可演练的运行/);
});

test("同失败域被拒绝的运行呈现为失败，不作为备份成功展示", () => {
  const policy = completedRunPolicy();
  policy.status.lastBackup = {
    ...policy.status.lastBackup,
    succeeded: false,
    reason: "目标与源处于同一失败域，备份被拒绝",
  };

  const runs = itemMarkup(render(policy), "runs");
  assert.equal(attributeIn(runs, "data-state"), "Failed");
  assert.ok(visibleText(runs).includes("同一失败域"), "拒绝原因可读");
  assert.ok(!visibleText(runs).includes("Succeeded"), "失败不被呈现为成功备份");
});
