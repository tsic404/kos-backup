// BACKUP-AC-35 / BACKUP-TC-71, display layer: a failed drill is read on the
// page as a failure with its reason and its differences, and the run is not
// presented as a successful backup. Assertions come from the frozen contract
// and the fixture objects, not from the renderer's own output.
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildPage } from "../../../assets/app/model.js";
import { renderWindow } from "../../../assets/app/render.js";
import {
  OBSERVED_AT,
  failedDrillPolicy,
  projectionOf,
} from "../fixtures/controlplane.js";
import { attributeIn, itemMarkup, visibleText } from "../fixtures/display.js";

const AT_OBSERVATION = new Date(OBSERVED_AT);

function render(policy) {
  return renderWindow(buildPage({ policies: [projectionOf(policy)], now: AT_OBSERVATION }));
}

test("演练失败时页面呈现失败状态、原因与差异项", () => {
  const policy = failedDrillPolicy();
  const drill = itemMarkup(render(policy), "drill");

  assert.equal(attributeIn(drill, "data-state"), "Failed");
  assert.ok(visibleText(drill).includes(policy.status.lastDrill.reason), "原因可读");
  assert.match(visibleText(drill), /files/, "原因指向文件数不一致");

  const row = drill.match(/<tr data-diff-item="files">[\s\S]*?<\/tr>/);
  assert.ok(row, "差异项逐条渲染");
  const cells = [...row[0].matchAll(/<td>([^<]*)<\/td>/g)].map((match) => match[1]);
  assert.deepEqual(cells, ["files", "41", "42"], "差异项列出项目、基线值与观测值");
});

test("字节数差异同样列出基线与观测值", () => {
  const policy = failedDrillPolicy();
  policy.status.lastDrill.diffs = [{ item: "bytes", baseline: "1048576", observed: "1048577" }];
  policy.status.lastDrill.reason = "";

  const drill = itemMarkup(render(policy), "drill");
  assert.equal(attributeIn(drill, "data-state"), "Failed");
  assert.match(visibleText(drill), /bytes 1048576→1048577/, "原因指向字节数不一致");

  const row = drill.match(/<tr data-diff-item="bytes">[\s\S]*?<\/tr>/);
  assert.ok(row, "字节数差异项渲染");
  const cells = [...row[0].matchAll(/<td>([^<]*)<\/td>/g)].map((match) => match[1]);
  assert.deepEqual(cells, ["bytes", "1048576", "1048577"]);
});

test("演练失败后运行项呈现失败，不被呈现为成功备份", () => {
  const runs = itemMarkup(render(failedDrillPolicy()), "runs");

  assert.equal(attributeIn(runs, "data-state"), "Failed");
  assert.ok(!visibleText(runs).includes("Succeeded"), "备份不被标记为成功");
  assert.match(visibleText(runs), /files/, "运行原因同样指向文件数");
});
