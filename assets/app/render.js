// The backup window's display layer: the four items BACKUP-C-1 reads and the
// two entries it offers. Every shown state is the kernel value the projection
// carries; this module adds only the markers it names and never derives a
// success. Only the policy's recorded lastBackup is labelled a backup: a
// snapshot or a same-failure-domain copy is never presented as one (KOSD-F-12).

import { restoreDeclaration } from "./actions.js";
import {
  ENTRY_DRILL,
  ENTRY_RESTORE,
  ITEM_DRILL,
  ITEM_POLICY,
  ITEM_RUNS,
  ITEM_TARGET,
  RESTORE_FAILED,
  RESTORE_SUCCEEDED,
} from "./model.js";

/** Every string a reader sees, kept in one place. */
const TEXT = {
  title: "备份",
  stale: "数据陈旧：超过 2 分钟未更新",
  empty: "没有可读取的备份策略",
  unreadable: "无法读取备份对象",
  reload: "读取最新",
  observedAt: "观测时间",
  namespace: "命名空间",
  policy: "策略",
  runs: "运行",
  target: "目标与失败域",
  drill: "演练与差异项",
  entries: "动作",
  phase: "阶段",
  health: "健康",
  selector: "选择器",
  schedule: "计划",
  consistency: "一致性等级",
  retention: "保留",
  nextRunTime: "下次运行",
  conditions: "条件",
  state: "状态",
  running: "正在执行",
  scheduledAt: "计划时间",
  startedAt: "开始时间",
  completedAt: "完成时间",
  runPath: "备份路径",
  result: "结果",
  succeeded: "成功",
  failed: "失败",
  baseline: "基线",
  files: "文件数",
  bytes: "字节数",
  totalBytes: "总字节数",
  checksum: "校验和",
  engines: "引擎",
  path: "目标",
  failureDomain: "失败域",
  drillRun: "演练对象",
  reason: "原因",
  diffs: "差异项",
  diffItem: "项目",
  diffBaseline: "基线",
  diffObserved: "观测",
  restore: "恢复",
  restoreHint: "默认恢复到新实例，不覆盖现有对象。",
  restoreName: "作业名称",
  restorePolicy: "来源策略",
  restoreRun: "恢复运行",
  restoreTargetApplication: "目标应用",
  restoreInPlace: "原地恢复（需要应用停机）",
  restoreStopRequirement: "原地恢复要求应用停机：应用运行中提交会被拒绝，请先停止该应用。",
  restoreSubmit: "恢复到新实例",
  restoreSubmitInPlace: "原地恢复",
  accepted: "已接受",
  notAccepted: "未被接受",
  restores: "恢复结果",
  restoreEmpty: "暂无恢复作业",
  restoreForm: "形态",
  formNewInstance: "恢复到新实例",
  formInPlace: "原地恢复",
  verdict: "判定",
  verdictSucceeded: "成功",
  verdictFailed: "失败",
  verdictPending: "进行中",
  observed: "观测值",
  tableRows: "表行数",
  metricsMissing: "未记录",
  created: "新建对象",
  createdApplication: "新应用",
  createdVolumes: "新卷",
  source: "源对象",
  sourceApplication: "源应用",
  sourceVolumes: "源卷",
  sourcePVC: "源 PVC",
  retained: "保留",
  yes: "是",
  no: "否",
  drillHint: "演练校验该策略最近一次成功完成的运行。",
  drillSubmit: "执行演练",
};

/**
 * renderWindow renders one read view as the window document. Every value is
 * escaped; the structure carries data attributes the acceptance cases read.
 *
 * @param {ReturnType<import("./model.js").buildPage>} page
 */
export function renderWindow(page) {
  if (!page || typeof page !== "object") {
    throw new TypeError("备份页需要读视图");
  }
  const policies = Array.isArray(page.policies) ? page.policies : [];
  return `<section class="backup-page" data-page="backup" data-state="${escapeHTML(present(page.state))}" data-stale="${page.stale === true}">
  <header class="page-header">
    <h1>${TEXT.title}</h1>
    <dl class="facts">${fact(TEXT.observedAt, page.observedAt)}</dl>
    ${page.stale === true ? staleMark() : ""}
    <button type="button" data-action="reload">${TEXT.reload}</button>
    ${page.reason ? pageReason(page.reason) : ""}
    ${policies.length === 0 && !page.reason ? `<p class="empty" data-empty>${TEXT.empty}</p>` : ""}
  </header>
  ${policies.map(renderPolicy).join("\n")}
  ${renderRestores(page)}
</section>`;
}

function renderPolicy(view) {
  const items = view.items ?? {};
  return `<article class="policy" data-policy="${escapeHTML(present(view.id))}" data-stale="${view.stale === true}">
  <header class="policy-header">
    <h2>${escapeHTML(present(view.name))}</h2>
    <dl class="facts">
      ${fact(TEXT.namespace, view.namespace)}
      ${fact(TEXT.observedAt, view.observedAt)}
    </dl>
    ${view.stale === true ? staleMark() : ""}
  </header>
  ${renderPolicyItem(items[ITEM_POLICY])}
  ${renderRunsItem(items[ITEM_RUNS])}
  ${renderTargetItem(items[ITEM_TARGET])}
  ${renderDrillItem(items[ITEM_DRILL])}
  ${renderEntries(view)}
</article>`;
}

function renderPolicyItem(item) {
  if (!item) {
    return "";
  }
  const state = item.state ?? {};
  return itemFrame(
    ITEM_POLICY,
    item,
    state.phase,
    `<dl class="facts">
      ${fact(TEXT.phase, state.phase)}
      ${fact(TEXT.health, state.health)}
      ${fact(TEXT.selector, item.policy?.selector)}
      ${fact(TEXT.schedule, item.policy?.schedule)}
      ${fact(TEXT.consistency, item.policy?.consistency)}
      ${fact(TEXT.retention, describeMap(item.policy?.retention))}
      ${fact(TEXT.nextRunTime, item.policy?.nextRunTime)}
    </dl>
    ${renderConditions(item.conditions)}
    ${item.reason ? reasonBlock(item.reason) : ""}`,
    `data-phase="${escapeHTML(present(state.phase))}" data-health="${escapeHTML(present(state.health))}"`,
  );
}

function renderRunsItem(item) {
  if (!item) {
    return "";
  }
  const run = item.run;
  const running = item.running;
  return itemFrame(
    ITEM_RUNS,
    item,
    item.state,
    `<dl class="facts">
      ${fact(TEXT.state, item.state)}
      ${running ? fact(TEXT.running, `${running.kind} ${running.run}`.trim()) : ""}
      ${running ? fact(TEXT.startedAt, running.startedAt) : ""}
      ${run ? fact(TEXT.scheduledAt, run.scheduledAt) : ""}
      ${run ? fact(TEXT.startedAt, run.startedAt) : ""}
      ${run ? fact(TEXT.completedAt, run.completedAt) : ""}
      ${run ? fact(TEXT.consistency, run.consistency) : ""}
      ${run ? fact(TEXT.runPath, run.path) : ""}
      ${run ? fact(TEXT.result, run.succeeded ? TEXT.succeeded : TEXT.failed) : ""}
    </dl>
    ${run?.baseline ? baselineBlock(run.baseline) : ""}
    ${item.reason ? reasonBlock(item.reason) : ""}`,
  );
}

function renderTargetItem(item) {
  if (!item) {
    return "";
  }
  return itemFrame(
    ITEM_TARGET,
    item,
    item.state,
    `<dl class="facts">
      ${fact(TEXT.state, item.state)}
      ${fact(TEXT.path, item.target?.path)}
      ${fact(TEXT.failureDomain, item.target?.failureDomain)}
    </dl>
    ${item.reason ? reasonBlock(item.reason) : ""}`,
  );
}

function renderDrillItem(item) {
  if (!item) {
    return "";
  }
  const drill = item.drill;
  return itemFrame(
    ITEM_DRILL,
    item,
    item.state,
    `<dl class="facts">
      ${fact(TEXT.state, item.state)}
      ${drill ? fact(TEXT.drillRun, drill.run) : ""}
      ${drill ? fact(TEXT.completedAt, drill.completedAt) : ""}
      ${drill ? fact(TEXT.result, drill.succeeded ? TEXT.succeeded : TEXT.failed) : ""}
    </dl>
    ${item.reason ? reasonBlock(item.reason) : ""}`,
  );
}

function itemFrame(id, item, state, body, extraAttributes = "") {
  return `<section class="item" data-item="${id}" data-state="${escapeHTML(present(state))}" data-stale="${item.stale === true}"${extraAttributes === "" ? "" : " " + extraAttributes}>
    <h3>${itemTitle(id)}</h3>
    ${item.stale === true ? staleMark() : ""}
    ${body}
  </section>`;
}

function itemTitle(id) {
  switch (id) {
    case ITEM_POLICY:
      return TEXT.policy;
    case ITEM_RUNS:
      return TEXT.runs;
    case ITEM_TARGET:
      return TEXT.target;
    case ITEM_DRILL:
      return TEXT.drill;
    default:
      return id;
  }
}

function renderEntries(view) {
  const entries = new Map((view.entries ?? []).map((entry) => [entry.id, entry]));
  return `<section class="entries" data-entries>
    <h3>${TEXT.entries}</h3>
    ${renderRestoreEntry(entries.get(ENTRY_RESTORE), view)}
    ${renderDrillForm(entries.get(ENTRY_DRILL), view)}
  </section>`;
}

/**
 * renderRestoreEntry renders the restore entry. Without a declaration it
 * submits a restore to a new instance; once the user declares an in-place
 * restore the entry shows the stop requirement and the submission points at
 * the existing application (BACKUP-C-3, KOSD-C-41).
 *
 * @param {{available?: boolean, reason?: object}|undefined} entry
 * @param {ReturnType<import("./model.js").policyView>} view
 * @param {{declared?: boolean}} [options]
 */
export function renderRestoreEntry(entry, view, { declared = false } = {}) {
  const declaration = restoreDeclaration(declared);
  const runs = Array.isArray(view?.restoreRuns) ? view.restoreRuns : [];
  const defaultRun = runs.length > 0 ? runs[runs.length - 1].path : "";
  return `<form class="entry" data-entry="${ENTRY_RESTORE}" data-available="${entry?.available === true}">
      <h4>${TEXT.restore}</h4>
      <p class="hint">${TEXT.restoreHint}</p>
      <label>${TEXT.restoreName} <input name="name" autocomplete="off" required></label>
      <label>${TEXT.namespace} <input name="namespace" value="${escapeHTML(view?.namespace ?? "")}" required></label>
      <label>${TEXT.restorePolicy} <input name="policy" value="${escapeHTML(view?.name ?? "")}" required></label>
      <label>${TEXT.restoreRun} <select name="run" data-default-run="${escapeHTML(defaultRun)}" required${runs.length === 0 ? " disabled" : ""}>
        ${runs.map((run) => `<option value="${escapeHTML(run.path)}"${run.path === defaultRun ? " selected" : ""}>${escapeHTML(runLabel(run))}</option>`).join("")}
      </select></label>
      <label>${TEXT.restoreTargetApplication} <input name="targetApplication" autocomplete="off" required></label>
      <label class="check"><input type="checkbox" name="inPlace"${declaration.inPlace ? " checked" : ""}> ${TEXT.restoreInPlace}</label>
      <div data-declaration>${renderDeclaration(declared)}</div>
      <button type="submit" data-action="${ENTRY_RESTORE}"${entry?.available === true ? "" : " disabled"}>${escapeHTML(restoreSubmitLabel(declared))}</button>
      ${entry?.reason ? entryReason(entry.reason) : ""}
      <div data-entry-outcome-slot></div>
    </form>`;
}

/** renderDeclaration is the stop requirement the in-place declaration adds. */
export function renderDeclaration(declared) {
  return declared === true ? `<p class="stop-requirement" data-stop-requirement>${TEXT.restoreStopRequirement}</p>` : "";
}

/** restoreSubmitLabel follows the declared form. */
export function restoreSubmitLabel(declared) {
  return declared === true ? TEXT.restoreSubmitInPlace : TEXT.restoreSubmit;
}

/**
 * renderEntryOutcome renders the control plane's answer to one submission:
 * acceptance with the object reference, or the rejection reason with its code.
 *
 * @param {{accepted: boolean, ref: object|null, reason: {code: string, message: string}|null}} outcome
 */
export function renderEntryOutcome(outcome) {
  if (outcome?.accepted === true) {
    const ref = outcome.ref ?? {};
    const where = [ref.namespace, ref.name].filter((part) => Boolean(part)).join("/");
    const kind = ref.kind ? `${ref.kind} ` : "";
    return `<p class="outcome" data-entry-outcome data-accepted="true">${TEXT.accepted}：${escapeHTML(present(`${kind}${where}`))}</p>`;
  }
  const reason = outcome?.reason ?? {};
  const code = present(reason.code);
  const message = present(reason.message);
  return `<p class="outcome" data-entry-outcome data-accepted="false" data-code="${escapeHTML(code)}">${TEXT.notAccepted}：${escapeHTML(message)}（${escapeHTML(code)}）</p>`;
}

function runLabel(run) {
  return [run.completedAt, run.path].filter((part) => Boolean(part)).join(" · ");
}

function renderRestores(page) {
  const restores = Array.isArray(page.restores) ? page.restores : [];
  return `<section class="restores" data-restores>
  <h2>${TEXT.restores}</h2>
  ${restores.length === 0 ? `<p class="empty" data-restore-empty>${TEXT.restoreEmpty}</p>` : restores.map(renderRestore).join("\n")}
</section>`;
}

function renderRestore(view) {
  return `<article class="restore" data-restore="${escapeHTML(present(view.id))}" data-phase="${escapeHTML(present(view.phase))}" data-verdict="${escapeHTML(present(view.verdict))}" data-in-place="${view.inPlace === true}" data-stale="${view.stale === true}">
  <header class="restore-header">
    <h3>${escapeHTML(present(view.name))}</h3>
    <dl class="facts">
      ${fact(TEXT.phase, view.phase)}
      ${fact(TEXT.restoreForm, view.inPlace ? TEXT.formInPlace : TEXT.formNewInstance)}
      ${fact(TEXT.verdict, verdictLabel(view.verdict))}
      ${fact(TEXT.restorePolicy, view.policy)}
      ${fact(TEXT.restoreRun, view.run)}
      ${fact(TEXT.restoreTargetApplication, view.targetApplication)}
      ${fact(TEXT.observedAt, view.observedAt)}
    </dl>
    ${view.stale === true ? staleMark() : ""}
  </header>
  ${metricsBlock("baseline", TEXT.baseline, view.baseline)}
  ${metricsBlock("observed", TEXT.observed, view.observed)}
  ${view.reason ? reasonBlock(view.reason) : ""}
  ${createdBlock(view.created)}
  ${sourceBlock(view.source)}
</article>`;
}

/** metricsBlock is one side of the four-item comparison KOSD-C-42 fixes. */
function metricsBlock(side, label, metrics) {
  const attributes = metrics
    ? ` data-tables="${escapeHTML(describeTables(metrics.tables))}" data-files="${escapeHTML(present(metrics.files))}" data-bytes="${escapeHTML(present(metrics.bytes))}" data-checksum="${escapeHTML(present(metrics.checksum))}"`
    : ` data-unreadable="true"`;
  const body = metrics
    ? `<dl class="facts">
      ${fact(TEXT.tableRows, describeTables(metrics.tables))}
      ${fact(TEXT.files, metrics.files)}
      ${fact(TEXT.totalBytes, metrics.bytes)}
      ${fact(TEXT.checksum, metrics.checksum)}
    </dl>`
    : `<p>${TEXT.metricsMissing}</p>`;
  return `<section class="metrics" data-metrics="${side}"${attributes}>
    <h4>${label}</h4>
    ${body}
  </section>`;
}

/** createdBlock lists the objects a new-instance restore produced. */
function createdBlock(created) {
  if (created.application === "" && created.volumes.length === 0) {
    return "";
  }
  return `<div class="objects" data-created><h4>${TEXT.created}</h4><dl class="facts">
      ${fact(TEXT.createdApplication, created.application)}
      ${fact(TEXT.createdVolumes, created.volumes.join("，"))}
    </dl></div>`;
}

/** sourceBlock lists the source objects the restore left in place. */
function sourceBlock(source) {
  if (source.application === "" && source.volumes.length === 0 && source.pvc === "") {
    return "";
  }
  return `<div class="objects" data-source><h4>${TEXT.source}</h4><dl class="facts">
      ${fact(TEXT.sourceApplication, source.application)}
      ${fact(TEXT.sourceVolumes, source.volumes.join("，"))}
      ${fact(TEXT.sourcePVC, source.pvc)}
      ${fact(TEXT.retained, source.retained ? TEXT.yes : TEXT.no)}
    </dl></div>`;
}

function describeTables(tables) {
  return (tables ?? []).map((table) => `${table.name}=${present(table.rows)}`).join("，");
}

function verdictLabel(verdict) {
  switch (verdict) {
    case RESTORE_SUCCEEDED:
      return TEXT.verdictSucceeded;
    case RESTORE_FAILED:
      return TEXT.verdictFailed;
    default:
      return TEXT.verdictPending;
  }
}

function renderDrillForm(entry, view) {
  return `<form class="entry" data-entry="${ENTRY_DRILL}" data-available="${entry?.available === true}">
      <h4>${TEXT.drill}</h4>
      <p class="hint">${TEXT.drillHint}</p>
      <input type="hidden" name="namespace" value="${escapeHTML(view.namespace ?? "")}">
      <input type="hidden" name="name" value="${escapeHTML(view.name ?? "")}">
      <button type="submit" data-action="${ENTRY_DRILL}"${entry?.available === true ? "" : " disabled"}>${TEXT.drillSubmit}</button>
      ${entry?.reason ? entryReason(entry.reason) : ""}
    </form>`;
}

function entryReason(reason) {
  return `<p class="reason" data-entry-reason data-code="${escapeHTML(present(reason.code))}">${escapeHTML(present(reason.message))}</p>`;
}

function pageReason(reason) {
  const status = reason.status ? `，HTTP ${escapeHTML(String(reason.status))}` : "";
  return `<p class="reason" data-page-reason data-code="${escapeHTML(present(reason.code))}">${TEXT.unreadable}：${escapeHTML(present(reason.message))}（${escapeHTML(present(reason.code))}${status}）</p>`;
}

function reasonBlock(reason) {
  return `<p class="reason" data-reason data-code="${escapeHTML(present(reason.code))}">${TEXT.reason}：${escapeHTML(present(reason.message))}</p>${renderDiffs(reason.diffs)}`;
}

function renderDiffs(diffs) {
  if (!Array.isArray(diffs) || diffs.length === 0) {
    return "";
  }
  const rows = diffs
    .map(
      (diff) => `<tr data-diff-item="${escapeHTML(present(diff?.item))}"><td>${escapeHTML(present(diff?.item))}</td><td>${escapeHTML(present(diff?.baseline))}</td><td>${escapeHTML(present(diff?.observed))}</td></tr>`,
    )
    .join("");
  return `<table class="diffs" data-diffs>
      <caption>${TEXT.diffs}</caption>
      <thead><tr><th>${TEXT.diffItem}</th><th>${TEXT.diffBaseline}</th><th>${TEXT.diffObserved}</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderConditions(conditions) {
  if (!Array.isArray(conditions) || conditions.length === 0) {
    return "";
  }
  const rows = conditions
    .map(
      (condition) => `<li data-condition="${escapeHTML(present(condition?.type))}" data-status="${escapeHTML(present(condition?.status))}">${escapeHTML(present(condition?.type))}：${escapeHTML(present(condition?.status))}（${escapeHTML(present(condition?.reason))}）${escapeHTML(present(condition?.message))}</li>`,
    )
    .join("");
  return `<div class="conditions"><h4>${TEXT.conditions}</h4><ul>${rows}</ul></div>`;
}

function baselineBlock(baseline) {
  return `<div class="baseline"><h4>${TEXT.baseline}</h4><dl class="facts">
      ${fact(TEXT.files, baseline.files)}
      ${fact(TEXT.bytes, baseline.bytes)}
      ${fact(TEXT.checksum, baseline.checksum)}
      ${fact(TEXT.engines, baseline.engines)}
    </dl></div>`;
}

function fact(label, value) {
  return `<div class="fact"><dt>${escapeHTML(label)}</dt><dd>${escapeHTML(present(value))}</dd></div>`;
}

function staleMark() {
  return `<span class="stale" data-stale-marker>${TEXT.stale}</span>`;
}

function describeMap(value) {
  if (!value || typeof value !== "object") {
    return "";
  }
  return Object.entries(value)
    .map(([key, item]) => `${key}=${item}`)
    .join("，");
}

function present(value) {
  if (value === undefined || value === null || value === "") {
    return "—";
  }
  return String(value);
}

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, (character) => HTML_ESCAPES[character]);
}
