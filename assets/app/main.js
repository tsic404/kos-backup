// Boots the backup window: the policy list, read page by page from the control
// plane, the page model, the display layer and the two entries. The window calls
// the control-plane API on its own origin, which the desktop BFF proxies
// (KOSD-C-12); it adds no data path of its own, and an accepted write is shown
// as acceptance, never as a terminal outcome.

import { submitDrill, submitRestore } from "./actions.js";
import { createControlPlane } from "./control.js";
import { buildPage, buildUnreadablePage } from "./model.js";
import { renderWindow } from "./render.js";

const POLICY_KIND = "BackupPolicy";

/**
 * mount wires one window document to one control-plane client.
 *
 * @param {HTMLElement} root the window document's root element
 * @param {{client: ReturnType<import("./control.js").createControlPlane>,
 *          notice?: HTMLElement|null, now?: () => Date}} options
 */
export function mount(root, { client, notice = null, now = () => new Date() } = {}) {
  if (!root) {
    throw new TypeError("备份窗口需要一个根元素");
  }
  if (!client) {
    throw new TypeError("备份窗口需要控制面客户端");
  }

  let isBusy = false;

  function showNotice(message, tone = "info") {
    if (!notice) {
      return;
    }
    notice.dataset.tone = tone;
    notice.textContent = message;
  }

  async function refresh() {
    if (isBusy) {
      return;
    }
    isBusy = true;
    root.setAttribute("aria-busy", "true");
    try {
      const policies = await readPolicies(client);
      root.innerHTML = renderWindow(buildPage({ policies, now: now() }));
      showNotice("");
    } catch (error) {
      root.innerHTML = renderWindow(buildUnreadablePage({ error, now: now() }));
      showNotice(describeFailure(error), "error");
    } finally {
      isBusy = false;
      root.removeAttribute("aria-busy");
    }
  }

  async function submitEntry(form) {
    if (isBusy) {
      return;
    }
    isBusy = true;
    const values = new FormData(form);
    try {
      if (form.dataset.entry === "restore") {
        const answer = await submitRestore(client, {
          name: field(values, "name"),
          namespace: field(values, "namespace"),
          policy: field(values, "policy"),
          targetApplication: field(values, "targetApplication"),
          inPlace: values.get("inPlace") === "on",
        });
        showNotice(describeAnswer("恢复", answer), answer?.accepted === true ? "info" : "error");
      } else {
        const answer = await submitDrill(client, {
          namespace: field(values, "namespace"),
          name: field(values, "name"),
        });
        showNotice(describeAnswer("演练", answer), answer?.accepted === true ? "info" : "error");
      }
    } catch (error) {
      showNotice(describeFailure(error), "error");
    } finally {
      isBusy = false;
    }
  }

  root.addEventListener("submit", (event) => {
    const form = event.target instanceof Element ? event.target.closest("form[data-entry]") : null;
    if (!form) {
      return;
    }
    event.preventDefault();
    submitEntry(form);
  });

  root.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest("button[data-action='reload']") : null;
    if (button) {
      refresh();
    }
  });

  return refresh();
}

/**
 * readPolicies reads every page of the policy list. The page size is the
 * control plane's own (KOSD-C-12), so the window follows the returned cursor:
 * a policy past the first page is still one BACKUP-C-1 presents.
 */
async function readPolicies(client) {
  const policies = [];
  const seen = new Set();
  let cursor = "";
  for (;;) {
    const page = await client.list(POLICY_KIND, cursor === "" ? {} : { continue: cursor });
    policies.push(...page.items);
    cursor = typeof page.continue === "string" ? page.continue : "";
    if (cursor === "") {
      return policies;
    }
    if (seen.has(cursor)) {
      throw new Error("控制面返回了重复的分页游标");
    }
    seen.add(cursor);
  }
}

/**
 * boot starts the window document its entry serves. Credentials are the host
 * handshake's business (KOSD-C-75); this window adds none of its own.
 */
export function boot() {
  const root = document.querySelector("#backup-window");
  if (!root) {
    return Promise.resolve();
  }
  const notice = document.querySelector("#backup-notice");
  const client = createControlPlane({ baseURL: window.location.origin });
  return mount(root, { client, notice });
}

function field(values, name) {
  const value = values.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function describeAnswer(label, answer) {
  if (answer?.accepted !== true) {
    return `${label}未被接受`;
  }
  const ref = answer.ref ?? {};
  const where = [ref.namespace, ref.name].filter((part) => Boolean(part)).join("/");
  const kind = ref.kind ? `${ref.kind} ` : "";
  return `${label}已接受：${kind}${where}`;
}

function describeFailure(error) {
  const envelope = error?.envelope ?? {};
  const code = envelope.code || error?.code || "request-failed";
  const message = envelope.message || error?.message || "控制面请求失败";
  const retry = envelope.retryable === true ? "，可重试" : "";
  return `${message}（${code}${retry}）`;
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  boot();
}
