// BACKUP-AC-1 / BACKUP-TC-1, source labelling: every one of the four items
// names the source type and the source its shown value came from (BACKUP-C-1,
// KOSD-C-53). The policy, run, target and drill items read object fields; a
// difference is a computed source that names the KOSD-C-42 rule and the run its
// comparison used, and it is claimed only when a difference is shown. A source
// that cannot be observed, or one older than the KOSD-C-13 bound, keeps its
// item and says why. The cases read the rendered window the way a user does,
// not only the model or HTML attributes.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ITEM_DRILL,
  ITEM_POLICY,
  ITEM_RUNS,
  ITEM_TARGET,
  STALE_THRESHOLD_MS,
  buildPage,
} from "../../../assets/app/model.js";
import { renderWindow } from "../../../assets/app/render.js";
import {
  OBSERVED_AT,
  completedRunPolicy,
  failedDrillPolicy,
  noTargetPolicy,
  projectionOf,
  runningPolicy,
} from "../fixtures/controlplane.js";
import {
  attributeIn,
  diffSourceMarkup,
  itemMarkup,
  previousSourceMarkup,
  visibleText,
} from "../fixtures/display.js";

const AT_OBSERVATION = new Date(OBSERVED_AT);
// The two source types KOSD-C-53 names, and the rule a computed difference
// follows. The page model's own constants may move; these values are what the
// contract calls the types, so a case asserts them directly.
const SOURCE_OBJECT = "object";
const SOURCE_COMPUTED = "computed";
const DIFF_RULE = "KOSD-C-42";
const ITEM_IDS = [ITEM_POLICY, ITEM_RUNS, ITEM_TARGET, ITEM_DRILL];
const ITEM_FIELDS = {
  [ITEM_RUNS]: "status.lastBackup",
  [ITEM_TARGET]: "spec.target",
  [ITEM_DRILL]: "status.lastDrill",
};

function pageOf(policy, now = AT_OBSERVATION) {
  return buildPage({ policies: [projectionOf(policy)], now });
}

test("四项逐项带来源类型与来源，值等于对象字段的判定", () => {
  const policy = completedRunPolicy();
  const items = pageOf(policy).policies[0].items;

  for (const id of ITEM_IDS) {
    const source = items[id].source;
    assert.equal(source.type, SOURCE_OBJECT, `「${id}」项应声明对象源`);
    assert.equal(source.kind, "BackupPolicy");
    assert.equal(source.namespace, policy.metadata.namespace);
    assert.equal(source.name, policy.metadata.name);
    if (id === ITEM_POLICY) {
      // 策略项展示阶段、健康、条件与策略设置，来源要能追到这些字段。
      for (const field of ["status.phase", "status.health", "status.conditions", "spec.schedule"]) {
        assert.ok(source.field.includes(field), `策略来源应包含 ${field}`);
      }
      continue;
    }
    assert.equal(source.field, ITEM_FIELDS[id], `「${id}」项应指向它所读的字段`);
  }

  // 每一项的值就是它声明的对象字段的判定。
  assert.equal(items[ITEM_POLICY].state.phase, policy.status.phase);
  assert.equal(items[ITEM_POLICY].state.health, policy.status.health.state);
  assert.equal(items[ITEM_RUNS].state, policy.status.lastBackup.succeeded ? "Succeeded" : "Failed");
  assert.equal(items[ITEM_TARGET].state, "Configured");
  assert.ok(policy.spec.target.path !== "" && policy.spec.target.failureDomain !== "");
  assert.equal(items[ITEM_DRILL].state, policy.status.lastDrill.phase);
});

test("活动运行的来源指向 status.running，上次完成结果单独归到 status.lastBackup", () => {
  const policy = runningPolicy();
  const page = pageOf(policy);
  const runs = page.policies[0].items[ITEM_RUNS];

  assert.equal(runs.state, "Running");
  assert.equal(runs.source.field, "status.running", "当前状态应追溯到本次运行");
  assert.equal(runs.previousSource.field, "status.lastBackup", "上次完成结果单独标来源");

  const markup = itemMarkup(renderWindow(page), ITEM_RUNS);
  const text = visibleText(markup);
  assert.equal(attributeIn(markup, "data-state"), "Running");
  assert.ok(text.includes("status.running"), "卡片可读到活动运行的来源字段");
  assert.ok(text.includes(policy.status.running.startedAt), "开始时间可读");
  assert.ok(text.includes("上次完成结果来源"), "上次完成结果有独立来源标题");
  assert.ok(text.includes("status.lastBackup"), "上次完成结果来源可读");
  assert.ok(
    visibleText(previousSourceMarkup(markup)).includes("BackupPolicy home/nightly-running"),
    "上次完成结果来源指向同一策略对象",
  );
});

test("存在差异时，差异来源指向实际输入运行并标注规则", () => {
  const policy = failedDrillPolicy();
  const page = pageOf(policy);
  const runs = page.policies[0].items[ITEM_RUNS];
  const drill = page.policies[0].items[ITEM_DRILL];

  assert.equal(runs.reason.diffSource.type, SOURCE_COMPUTED);
  assert.equal(runs.reason.diffSource.rule, DIFF_RULE);
  assert.equal(runs.reason.diffSource.input, policy.status.lastBackup.path);
  assert.equal(drill.reason.diffSource.type, SOURCE_COMPUTED);
  assert.equal(drill.reason.diffSource.rule, DIFF_RULE);
  assert.equal(drill.reason.diffSource.input, policy.status.lastDrill.run);

  const drillMarkup = itemMarkup(renderWindow(page), ITEM_DRILL);
  const sourceLine = visibleText(diffSourceMarkup(drillMarkup));
  assert.ok(sourceLine.includes("计算源"), "差异来源类型可读");
  assert.ok(sourceLine.includes(DIFF_RULE), "差异规则可读");
  assert.ok(sourceLine.includes(policy.status.lastDrill.run), "差异来源列出实际输入运行");
  assert.ok(visibleText(drillMarkup).includes("files"), "差异行可读");
});

test("没有差异时不声称存在计算来源", () => {
  const html = renderWindow(pageOf(completedRunPolicy()));

  assert.equal(attributeIn(html, "data-diff-source-type"), null);
  assert.equal(diffSourceMarkup(html), "");
  assert.ok(!visibleText(html).includes("差异项来源类型"));
});

test("完成运行场景：四项卡片可见来源类型与对象名", () => {
  const html = renderWindow(pageOf(completedRunPolicy()));

  for (const id of ITEM_IDS) {
    const text = visibleText(itemMarkup(html, id));
    assert.ok(text.includes("对象源"), `「${id}」卡片应可见来源类型`);
    assert.ok(text.includes("BackupPolicy home/nightly"), `「${id}」卡片应可见来源对象名`);
  }

  const policyText = visibleText(itemMarkup(html, ITEM_POLICY));
  assert.ok(policyText.includes("status.phase"), "策略卡片应可读到所读字段");
  assert.ok(policyText.includes("spec.schedule"), "策略卡片应可读到所读字段");
});

test("演练产生差异场景：演练卡片可见来源、差异行、规则与实际输入运行", () => {
  const policy = failedDrillPolicy();
  const markup = itemMarkup(renderWindow(pageOf(policy)), ITEM_DRILL);
  const text = visibleText(markup);

  assert.ok(text.includes("对象源"), "演练结果来源类型可读");
  assert.ok(text.includes("BackupPolicy home/nightly-drill"), "演练来源对象名可读");
  assert.ok(text.includes("status.lastDrill"), "演练来源字段可读");
  assert.ok(text.includes("files"), "差异项可读");

  const sourceLine = visibleText(diffSourceMarkup(markup));
  assert.ok(sourceLine.includes("计算源"));
  assert.ok(sourceLine.includes(DIFF_RULE));
  assert.ok(sourceLine.includes(policy.status.lastDrill.run), "规则输入是产生该差异的运行");
});

test("未配置目标场景：目标卡片保留可见来源并给出原因", () => {
  const markup = itemMarkup(renderWindow(pageOf(noTargetPolicy())), ITEM_TARGET);
  const text = visibleText(markup);

  assert.ok(text.includes("对象源"), "目标来源类型可读");
  assert.ok(text.includes("BackupPolicy home/nightly-unset"), "目标来源对象名可读");
  assert.ok(text.includes("spec.target"), "目标来源字段可读");
  assert.ok(text.includes("未指定备份目标"), "未配置目标的原因可读");
});

test("无演练记录时演练卡片保留、原因可见且不标计算来源", () => {
  const policy = completedRunPolicy();
  delete policy.status.lastDrill;
  const markup = itemMarkup(renderWindow(pageOf(policy)), ITEM_DRILL);
  const text = visibleText(markup);

  assert.ok(text.includes("BackupPolicy home/nightly"), "演练卡片仍标来源对象");
  assert.ok(text.includes("策略还没有演练记录"), "无演练记录的原因可读");
  assert.equal(diffSourceMarkup(markup), "", "没有比较结果就不标计算来源");
});

test("有引用但无对象时四项卡片保留、来源可读且原因可见", () => {
  const projection = projectionOf(completedRunPolicy());
  delete projection.object;
  const html = renderWindow(buildPage({ policies: [projection], now: AT_OBSERVATION }));

  for (const id of ITEM_IDS) {
    const text = visibleText(itemMarkup(html, id));
    assert.ok(text.includes("BackupPolicy home/nightly"), `「${id}」卡片应保留来源对象名`);
    assert.ok(text.includes("投影没有携带对象"), `「${id}」卡片应可见不可观察原因`);
  }
});

test("超过陈旧阈值时四项卡片保留、带陈旧标记并仍可读来源", () => {
  const policy = completedRunPolicy();
  const now = new Date(AT_OBSERVATION.getTime() + STALE_THRESHOLD_MS + 1);
  const page = pageOf(policy, now);
  const html = renderWindow(page);

  for (const id of ITEM_IDS) {
    const item = page.policies[0].items[id];
    assert.equal(item.stale, true, `「${id}」项应标为陈旧`);
    assert.equal(item.source.type, SOURCE_OBJECT, `「${id}」项陈旧时仍声明来源`);

    const text = visibleText(itemMarkup(html, id));
    assert.ok(text.includes("数据陈旧"), `「${id}」卡片缺少陈旧标记`);
    assert.ok(text.includes("对象源"), `「${id}」卡片仍应可读来源类型`);
    assert.ok(text.includes("BackupPolicy home/nightly"), `「${id}」卡片仍应可读来源对象`);
  }

  // 陈旧只影响新旧判定，项里的值仍是来源对象的值。
  assert.equal(page.policies[0].items[ITEM_RUNS].state, "Succeeded");
});

test("没有观测时间时说明陈旧原因，不把来源当成新鲜", () => {
  const projection = projectionOf(completedRunPolicy());
  projection.observedAt = null;
  const html = renderWindow(buildPage({ policies: [projection], now: AT_OBSERVATION }));
  const text = visibleText(itemMarkup(html, ITEM_POLICY));

  assert.ok(text.includes("数据陈旧"));
  assert.ok(text.includes("投影没有可用的观测时间"));
  assert.ok(text.includes("BackupPolicy home/nightly"));
});
