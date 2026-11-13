// BACKUP-AC-34 / BACKUP-TC-70, display layer: a target on the source volume's
// own device is rejected with the reason naming that device, and no policy is
// shown; an undeterminable failure domain is accepted and the page keeps saying
// so on every read; a snapshot is never shown as a completed backup.
import assert from "node:assert/strict";
import { test } from "node:test";

import { createControlPlane } from "../../../assets/app/control.js";
import { ITEM_TARGET, buildPage } from "../../../assets/app/model.js";
import { loadPage, rejectionOf } from "../../../assets/app/main.js";
import { submitPolicy } from "../../../assets/app/policy.js";
import { ENTRY_CREATE, FORM_CREATE, renderWindow } from "../../../assets/app/render.js";
import { OBSERVED_AT, projectionOf } from "../fixtures/controlplane.js";
import { attributeIn, entryMarkup, formValues, itemMarkup, policyMarkup, visibleText } from "../fixtures/display.js";
import { SESSION_ALICE, policyPlane, referenceProvider, snapshotOnlyPolicy, sourceVolume } from "../fixtures/policyplane.js";

const BASE = "https://backup.apps.kos.tsic.top";
const AT_OBSERVATION = new Date(OBSERVED_AT);

const SUBMITTED = {
  name: "nightly",
  namespace: "home",
  selector: "app=media",
  schedule: "0 3 * * *",
  consistency: "crash-consistent",
  retention: { keep: 7 },
  drill: { enabled: true },
};

function clientFor(plane) {
  return createControlPlane({ baseURL: BASE, fetchImpl: plane.fetchImpl });
}

function readPage(client, rejection = null) {
  return loadPage(client, { now: () => AT_OBSERVATION, namespace: "home", rejection });
}

test("同失败域被拒绝时表单层给出原因、指向源卷，页面不出现策略", async () => {
  const volume = sourceVolume({ provider: referenceProvider() });
  const plane = policyPlane({ session: SESSION_ALICE, volumes: [volume] });
  const client = clientFor(plane);

  const submitted = { ...SUBMITTED, target: { path: "/mnt/backup", failureDomain: volume.status.failureDomain } };
  let rejection = null;
  try {
    await submitPolicy(client, submitted);
  } catch (error) {
    rejection = error;
  }
  assert.ok(rejection, "同失败域的目标被拒绝");

  const page = await readPage(client, rejectionOf(rejection, FORM_CREATE, submitted));
  const html = renderWindow(page);
  const block = entryMarkup(html, ENTRY_CREATE).match(/<p[^>]*data-form-reason[^>]*>[\s\S]*?<\/p>/)?.[0] ?? "";

  assert.equal(attributeIn(block, "data-code"), "same-failure-domain");
  assert.equal(attributeIn(block, "data-object"), "Volume home/media-data", "原因指向源卷");
  assert.match(visibleText(block), /同一物理设备/, "原因指出同失败域");
  assert.ok(visibleText(block).includes(volume.status.device), "原因给出源卷的物理设备");
  assert.ok(visibleText(block).includes(volume.metadata.name), "原因给出源卷");
  assert.ok(!visibleText(html).includes("已接受"), "被拒的提交不呈现为成功");
  assert.equal(page.policies.length, 0, "被拒绝的提交不产生策略");
  assert.equal(policyMarkup(html, "home/nightly"), "", "页面没有该策略");
  assert.equal(
    formValues(entryMarkup(html, ENTRY_CREATE)).get("failureDomain"),
    volume.status.failureDomain,
    "被拒后在表单里保留提交值",
  );
});

test("无法判定失败域时允许提交，页面每次读取都给出提示", async () => {
  const plane = policyPlane({ session: SESSION_ALICE });
  const client = clientFor(plane);

  const answer = await submitPolicy(client, { ...SUBMITTED, target: { path: "/mnt/backup" } });
  assert.equal(answer.accepted, true, "无法判定失败域时允许提交");

  for (const reading of [1, 2]) {
    const html = renderWindow(await readPage(client));
    const target = itemMarkup(html, "target");
    assert.equal(attributeIn(target, "data-state"), "Undetermined", `第 ${reading} 次读取仍为无法判定`);
    assert.equal(attributeIn(target, "data-code"), "failure-domain-undetermined");
    assert.match(visibleText(target), /失败域/, "提示可读");
    assert.ok(!html.includes("data-form-reason"), "提交被接受，表单层没有拒绝原因");
  }
});

test("只有快照记录时页面不把快照呈现为备份", () => {
  const policy = snapshotOnlyPolicy();
  assert.ok(policy.status.lastSnapshot, "夹具里只有一次快照");

  const html = renderWindow(buildPage({ policies: [projectionOf(policy)], now: AT_OBSERVATION }));
  const runs = itemMarkup(html, "runs");

  assert.equal(attributeIn(runs, "data-state"), "None", "快照不构成一次备份运行");
  assert.ok(!visibleText(runs).includes("Succeeded"), "快照不被呈现为成功的备份");
  assert.ok(!visibleText(runs).includes("备份路径"), "页面不给出备份记录");
  assert.equal(attributeIn(itemMarkup(html, ITEM_TARGET), "data-state"), "Configured");
});
