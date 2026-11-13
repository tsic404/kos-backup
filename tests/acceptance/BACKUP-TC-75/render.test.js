// BACKUP-AC-37 / BACKUP-TC-75, display layer: the entry shows the stop
// requirement once the in-place declaration is made, a rejected submission
// renders its reason in the entry, and an in-place restore result shows the
// source application and PVC without inventing a new instance.
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildPage } from "../../../assets/app/model.js";
import { renderEntryOutcome, renderRestoreEntry, renderWindow } from "../../../assets/app/render.js";
import { OBSERVED_AT, completedRunPolicy, projectionOf, restoreJob } from "../fixtures/controlplane.js";
import { attributeIn, restoreMarkup, visibleText } from "../fixtures/display.js";

const AT_OBSERVATION = new Date(OBSERVED_AT);

function restoreEntry() {
  const view = buildPage({
    policies: [projectionOf(completedRunPolicy())],
    now: AT_OBSERVATION,
  }).policies[0];
  return { view, entry: view.entries.find((item) => item.id === "restore") };
}

test("声明原地恢复后，入口显示停机要求", () => {
  const { view, entry } = restoreEntry();

  const plain = renderRestoreEntry(entry, view);
  assert.ok(!plain.includes("data-stop-requirement"), "未声明时不显示停机要求");
  assert.match(visibleText(plain), /恢复到新实例/, "默认提交恢复到新实例");

  const declared = renderRestoreEntry(entry, view, { declared: true });
  const requirement = declared.match(/<p[^>]*data-stop-requirement[^>]*>[\s\S]*?<\/p>/);
  assert.ok(requirement, "声明后入口显示停机要求");
  assert.match(visibleText(requirement[0]), /停机/, "停机要求可读");
  assert.match(visibleText(declared), /原地恢复/, "提交按钮指向原地恢复");
  assert.ok(declared.includes('name="inPlace"'), "原地声明字段仍在");
});

test("被拒绝的提交在入口显示原因与错误代码", () => {
  const rejected = renderEntryOutcome({
    accepted: false,
    ref: null,
    reason: { code: "application-running", message: "应用 media 未停机，原地恢复被拒绝" },
  });

  assert.equal(attributeIn(rejected, "data-accepted"), "false");
  assert.equal(attributeIn(rejected, "data-code"), "application-running");
  assert.match(visibleText(rejected), /未停机/, "原因可读");
  assert.match(visibleText(rejected), /应用 media/, "原因指出未停机的应用");

  const accepted = renderEntryOutcome({
    accepted: true,
    ref: { kind: "RestoreJob", namespace: "home", name: "media-inplace" },
    reason: null,
  });
  assert.equal(attributeIn(accepted, "data-accepted"), "true");
  assert.match(visibleText(accepted), /已接受/);
  assert.match(visibleText(accepted), /media-inplace/, "已接受时给出对象引用");
});

test("原地恢复结果面呈现源应用与源 PVC，不呈现新建对象", () => {
  const job = restoreJob({ inPlace: true });
  const html = renderWindow(
    buildPage({ policies: [], restores: [projectionOf(job)], now: AT_OBSERVATION }),
  );
  const card = restoreMarkup(html, "home/media-inplace");

  assert.equal(attributeIn(card, "data-in-place"), "true");
  assert.match(visibleText(card), /原地恢复/, "形态为原地恢复");
  assert.ok(visibleText(card).includes("media"), "源应用可读");
  assert.ok(visibleText(card).includes("media-data-pvc"), "源 PVC 可读");
  assert.ok(visibleText(card).includes("保留"), "源对象保留可读");
  assert.ok(!card.includes("data-created"), "原地恢复不呈现新建对象");
});
