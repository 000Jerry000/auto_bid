// Runs on every CrowdWorks / Lancers / Coconala page, but only acts in tabs the
// background worker opened (search-page monitor tabs and bid tabs).

(async () => {
  const siteKey = siteKeyForHost(location.host);
  if (!siteKey) return;
  let role;
  try {
    role = await chrome.runtime.sendMessage({ type: 'hello' });
  } catch {
    return;
  }
  if (!role) return;
  if (role.role === 'monitor') await monitor(siteKey);
  else if (role.role === 'bid') await bid(siteKey, role);
})();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

function visible(el) {
  if (!el || !el.isConnected) return false;
  const style = getComputedStyle(el);
  if (style.visibility === 'hidden' || style.display === 'none') return false;
  return el.getClientRects().length > 0;
}

async function waitFor(fn, timeoutMs, intervalMs = 500) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await sleep(intervalMs);
  }
  return fn();
}

// ---------- monitor ----------

function collectJobs(site) {
  const jobs = new Map();
  for (const a of document.querySelectorAll(site.listLinkSelector)) {
    let path;
    try {
      path = new URL(a.href, location.href).pathname;
    } catch {
      continue;
    }
    const m = path.match(site.jobIdRe);
    if (!m) continue;
    let title = clean(a.textContent);
    if (title.length < 4) {
      const card = a.closest('article, li, [class*="Item"], [class*="item"], [class*="job"], [class*="card"]');
      const heading = card && card.querySelector('h1, h2, h3, h4, [class*="title"], [class*="Title"]');
      title = clean(heading ? heading.textContent : card ? card.textContent.slice(0, 80) : '');
    }
    const prev = jobs.get(m[1]);
    if (!prev || title.length > prev.title.length) jobs.set(m[1], { id: m[1], title: title.slice(0, 120) });
  }
  return [...jobs.values()];
}

async function monitor(siteKey) {
  const site = SITES[siteKey];
  // Search pages may render client-side; wait for job links, then let the list settle.
  await waitFor(() => collectJobs(site).length > 0, 15000);
  await sleep(1500);
  const jobs = collectJobs(site);
  chrome.runtime.sendMessage({ type: 'jobs', site: siteKey, jobs });
}

// ---------- bid ----------

const NEGATIVE_BUTTON_RE = /下書き|保存|戻る|キャンセル|修正|削除|クリア|プレビュー|テンプレート|ログアウト|検索|質問|お気に入り|気になる/;
const FINAL_SUBMIT_RES = [/送信|この内容で|提案する|応募する|確定/, /確認/, /次へ/];
const SUCCESS_RE = /(応募|提案|見積).{0,12}(完了|送信しました|しました|受け付けました)|ありがとうございま/;
const ALREADY_RE = /応募済み|提案済み|募集終了|受付終了|募集は終了/;
const PROPOSAL_PATH_RE = /propos|offer|apply|entry|estimate/i;

function shortTextMatches(re) {
  // Match against short visible text nodes only, so phrases inside a job description don't trigger.
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = clean(n.textContent);
    if (t.length && t.length < 60 && re.test(t) && visible(n.parentElement)) return t;
  }
  return null;
}

function buttonText(el) {
  return clean(el.tagName === 'INPUT' ? el.value : el.textContent);
}

function clickables(scope) {
  return [...scope.querySelectorAll('button, input[type="submit"], input[type="button"], a, [role="button"]')].filter(
    (el) => visible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true'
  );
}

function findButton(scope, re) {
  return clickables(scope).find((el) => {
    const t = buttonText(el);
    return t.length > 0 && t.length < 25 && re.test(t) && !NEGATIVE_BUTTON_RE.test(t);
  });
}

function findFinalSubmit(scope) {
  for (const re of FINAL_SUBMIT_RES) {
    const btn = findButton(scope, re);
    if (btn) return btn;
  }
  return null;
}

function activate(el) {
  // Follow links in this tab (avoid target=_blank opening a tab we don't track).
  if (el.tagName === 'A' && el.href && !el.href.startsWith('javascript:') && !el.getAttribute('href').startsWith('#')) {
    location.assign(el.href);
  } else {
    el.click();
  }
}

function labelText(el) {
  const parts = [el.name, el.id, el.placeholder, el.getAttribute('aria-label')];
  if (el.labels) for (const l of el.labels) parts.push(l.textContent);
  const box = el.closest('dd, td, .form-group, [class*="field"], [class*="Field"], [class*="form"]');
  const head = box && (box.previousElementSibling || box.querySelector('label, dt, th, h3, h4'));
  if (head) parts.push(head.textContent.slice(0, 60));
  return clean(parts.filter(Boolean).join(' '));
}

function setValue(el, value) {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype :
    el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  // Use the native setter so React/Vue notice the change.
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  for (const type of ['input', 'change', 'blur']) el.dispatchEvent(new Event(type, { bubbles: true }));
}

function findMessageField() {
  const areas = [...document.querySelectorAll('textarea')].filter(
    (t) => visible(t) && !t.readOnly && !t.disabled && !/質問|question/i.test(labelText(t))
  );
  if (!areas.length) return null;
  const hinted = areas.filter((t) => /message|body|content|propos|description|appeal|comment|メッセージ|提案|内容|応募|自己/i.test(labelText(t)));
  const pool = hinted.length ? hinted : areas;
  const area = (el) => el.offsetWidth * el.offsetHeight;
  return pool.sort((a, b) => area(b) - area(a))[0];
}

function fillForm(role, messageField) {
  const scope = messageField.form || document;
  const notes = [];

  setValue(messageField, role.message);

  if (String(role.price).trim()) {
    const priceField = [...scope.querySelectorAll('input')].find(
      (el) =>
        ['number', 'text', 'tel', ''].includes(el.type) && visible(el) && !el.readOnly && !el.disabled &&
        /price|amount|budget|reward|金額|報酬|価格|見積|料金/i.test(labelText(el)) &&
        !/手数料|受取|受け取り|fee_rate|receive/i.test(labelText(el))
    );
    if (priceField) setValue(priceField, String(role.price).replace(/[^\d]/g, ''));
    else notes.push('price field not found');
  }

  const days = Number(role.deliveryDays);
  if (days > 0) {
    const d = new Date(Date.now() + days * 86400000);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    for (const el of scope.querySelectorAll('input[type="date"]')) {
      if (visible(el) && !el.value && !el.readOnly) setValue(el, iso);
    }
  }

  for (const cb of scope.querySelectorAll('input[type="checkbox"]')) {
    if (!cb.checked && /同意|規約|確認しました|了承|agree|confirm/i.test(labelText(cb) + ' ' + clean(cb.parentElement?.textContent))) {
      cb.click();
    }
  }

  const missing = [...scope.querySelectorAll('input, textarea, select')]
    .filter((el) => (el.required || el.getAttribute('aria-required') === 'true') && visible(el))
    .filter((el) => (el.type === 'checkbox' || el.type === 'radio' ? !scope.querySelector(`input[name="${CSS.escape(el.name)}"]:checked`) : !el.value))
    .map((el) => labelText(el).slice(0, 30) || el.name || el.tagName.toLowerCase());
  if (missing.length) notes.push(`required fields still empty: ${[...new Set(missing)].join(', ')}`);

  return { scope, notes };
}

function report(status, msg) {
  return chrome.runtime.sendMessage({ type: 'bidResult', status, msg });
}

async function bid(siteKey, role) {
  const site = SITES[siteKey];
  if (role.step >= role.maxSteps) return report('failed', 'too many steps without finishing');
  await sleep(1500);

  if (role.step > 0) {
    const done = shortTextMatches(SUCCESS_RE);
    if (done) return report('done', done);
  }

  // On the job page itself (step 0) never treat a textarea as the proposal form — it may be a public Q&A box.
  const onProposalPage = role.step > 0 || PROPOSAL_PATH_RE.test(location.pathname);

  const result = await waitFor(() => {
    if (role.step === 0) {
      const already = clickables(document).map(buttonText).find((t) => t.length < 25 && ALREADY_RE.test(t));
      if (already) return { kind: 'already', text: already };
    }
    if (onProposalPage) {
      const field = findMessageField();
      if (field) return { kind: 'form', field };
      if (role.step > 0) {
        const done = shortTextMatches(SUCCESS_RE);
        if (done) return { kind: 'done', text: done };
        const btn = findFinalSubmit(document);
        if (btn) return { kind: 'confirm', btn };
      }
    }
    const pb = findButton(document, site.proposeButtonRe);
    if (pb) return { kind: 'propose', btn: pb };
    return null;
  }, 20000, 1000);

  if (!result) return report('failed', 'could not find a proposal button or form on this page');

  switch (result.kind) {
    case 'already':
      return report('skipped', result.text);
    case 'done':
      return report('done', result.text);
    case 'propose':
      await chrome.runtime.sendMessage({ type: 'bidStep' });
      activate(result.btn);
      return watchAfterClick();
    case 'confirm':
      if (!role.autoSubmit) return report('review', 'confirmation page reached — auto-submit is OFF');
      await chrome.runtime.sendMessage({ type: 'bidStep' });
      activate(result.btn);
      return watchAfterClick();
    case 'form': {
      const { scope, notes } = fillForm(role, result.field);
      if (notes.length) return report('review', notes.join('; '));
      if (!role.autoSubmit) return report('review', 'form filled — auto-submit is OFF, submit it yourself');
      const btn = findFinalSubmit(scope) || findFinalSubmit(document);
      if (!btn) return report('review', 'form filled but no submit button found');
      await sleep(800);
      await chrome.runtime.sendMessage({ type: 'bidStep' });
      activate(btn);
      return watchAfterClick();
    }
  }
}

// If the click navigates, this script dies and the next page continues the flow.
// If it doesn't (single-page app or validation error), keep checking here.
async function watchAfterClick() {
  await sleep(4000);
  const role = await chrome.runtime.sendMessage({ type: 'hello' });
  if (!role || role.role !== 'bid') return;
  const done = await waitFor(() => shortTextMatches(SUCCESS_RE), 8000, 1000);
  if (done) return report('done', done);
  // Still on a page with work to do (e.g. SPA moved to the form or a confirm step): run another step.
  return bid(siteKeyForHost(location.host), role);
}
