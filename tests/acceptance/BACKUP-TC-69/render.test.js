// BACKUP-AC-34 / BACKUP-TC-69, display layer: the four items the restore is
// judged by — table row counts, file count, total bytes and content checksum —
// are readable for both the baseline and the observed values, and a mismatch is
// rendered as a failure with one difference row per item.
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildPage } from "../../../assets/app/model.js";
import { renderWindow } from "../../../assets/app/render.js";
import { OBSERVED_AT, projectionOf, restoreJob } from "../fixtures/controlplane.js";
import { attributeIn, metricsMarkup, restoreMarkup, visibleText } from "../fixtures/display.js";

const AT_OBSERVATION = new Date(OBSERVED_AT);

function render(job) {
  return renderWindow(
    buildPage({ policies: [], restores: [projectionOf(job)], now: AT_OBSERVATION }),
  );
}

test("基线四项与观测值四项逐项可读", () => {
  const job = restoreJob();
  const card = restoreMarkup(render(job), "home/media-restore");

  for (const [side, metrics] of [
    ["baseline", job.status.baseline],
    ["observed", job.status.observed],
  ]) {
    const block = metricsMarkup(card, side);
    assert.ok(block, `${side} 可读`);
    assert.equal(attributeIn(block, "data-files"), String(metrics.files), "文件数");
    assert.equal(attributeIn(block, "data-bytes"), String(metrics.bytes), "总字节数");
    assert.equal(attributeIn(block, "data-checksum"), metrics.checksum, "内容校验和");
    assert.match(attributeIn(block, "data-tables"), /orders=120，lines=400/, "每张表的行数");
    const text = visibleText(block);
    for (const label of ["文件数", "总字节数", "校验和", "表行数"]) {
      assert.ok(text.includes(label), `${side} 缺少「${label}」`);
    }
  }
});

test("四项不一致时渲染失败判定与逐项差异", () => {
  const job = restoreJob();
  job.status.observed.files = 42;
  job.status.observed.bytes = 1048577;
  const card = restoreMarkup(render(job), "home/media-restore");

  assert.equal(attributeIn(card, "data-verdict"), "Failed");
  assert.match(visibleText(card), /失败/, "判定为失败");

  const diffItems = [...card.matchAll(/data-diff-item="([^"]*)"/g)].map((match) => match[1]);
  assert.deepEqual(diffItems, ["bytes", "files"], "差异项逐条列出");
  assert.ok(visibleText(card).includes("1048576"), "差异行带基线值");
  assert.ok(visibleText(card).includes("1048577"), "差异行带观测值");
});

test("阶段进行中时不呈现成功", () => {
  const job = restoreJob({ phase: "Verifying" });
  const card = restoreMarkup(render(job), "home/media-restore");

  assert.equal(attributeIn(card, "data-phase"), "Verifying", "阶段等于恢复作业的状态");
  assert.equal(attributeIn(card, "data-verdict"), "Pending");
  assert.ok(!visibleText(card).includes("成功"), "校验未完成时不呈现成功");
});
