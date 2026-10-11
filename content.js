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

  const missing = emptyRequired(scope);
  if (missing.length) notes.push(`required fields still empty: ${missing.join(', ')}`);

  return { scope, notes };
}

// Labels of visible required fields in scope that are still empty.
function emptyRequired(scope) {
  const missing = [...scope.querySelectorAll('input, textarea, select')]
    .filter((el) => (el.required || el.getAttribute('aria-required') === 'true') && visible(el))
    .filter((el) => (el.type === 'checkbox' || el.type === 'radio' ? !scope.querySelector(`input[name="${CSS.escape(el.name)}"]:checked`) : !clean(el.value)))
    .map((el) => labelText(el).slice(0, 30) || el.name || el.tagName.toLowerCase());
  return [...new Set(missing)];
}

// A "confirm" button that belongs to a form with a message box or empty required fields is that
// form's own submit button (e.g. 応募する on an unfilled proposal form), not a confirmation step.
function isUnfilledFormSubmit(btn) {
  const form = btn.closest('form');
  return !!form && (!!form.querySelector('textarea') || emptyRequired(form).length > 0);
}

// ---------- CrowdWorks proposal form (/proposals/new?job_offer_id=...) ----------

function digits(v) {
  return String(v || '').replace(/[^\d]/g, '');
}

// Lowest yen amount in the client's posted conditions, e.g. "4,000円 〜 5,000円" -> 4000.
function cwClientAmount(form, hourly) {
  const texts = hourly ? [form.querySelector('.offered_hourly_wage')?.textContent] : [];
  for (const c of document.querySelectorAll('.job_offer-conditions .condition')) {
    const name = clean(c.querySelector('.condition_name')?.textContent);
    if (hourly ? /時間単価/.test(name) : /予算|報酬|金額/.test(name) && !/形式|時間単価/.test(name)) {
      texts.push(c.querySelector('.condition_body')?.textContent);
    }
  }
  for (const t of texts) {
    const m = (t || '').match(/([\d,]+)\s*円/);
    if (m) return digits(m[1]);
  }
  return '';
}

function cwSetAmount(dummy, hidden, value) {
  setValue(dummy, value);
  // CrowdWorks recalculates the hidden real field from the visible one on key events.
  dummy.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: '0' }));
  if (hidden && (!hidden.value || hidden.value === '0')) hidden.value = value;
}

function fillCrowdWorks(role, form) {
  const notes = [];
  const q = (sel) => form.querySelector(sel);

  // "契約金額を提示" (propose an amount), presented as the contract amount (not the worker's take-home).
  const withAmount = q('#without_condition_false');
  if (withAmount && !withAmount.checked) withAmount.click();

  const hourly = (q('input.payment_type:checked')?.value || 'hourly') === 'hourly';
  const presentAs = q(hourly ? '#how_to_present_hourly_contract_amount' : '#how_to_present_fixed_price_contract_amount');
  if (presentAs && !presentAs.checked) presentAs.click();

  const configured = digits(hourly ? role.hourlyWage : role.price);
  const amount = configured || cwClientAmount(form, hourly);
  const dummy = q(hourly ? 'input.user_input_hourly_wage' : 'input.user_input_budget');
  const hidden = q(hourly ? 'input.hourly_wage' : 'input.budget');
  if (!dummy) notes.push(`${hourly ? 'hourly rate' : 'price'} field not found`);
  else if (!amount) notes.push(`no ${hourly ? 'hourly rate' : 'price'} set and the client posted none`);
  else cwSetAmount(dummy, hidden, amount);

  if (hourly && digits(role.hoursPerWeek)) {
    const hours = q('#proposal_conditions_attributes_0_hours_limit');
    if (hours) setValue(hours, digits(role.hoursPerWeek));
  }

  // Completion date (fixed price, optional): only when empty.
  const days = Number(role.deliveryDays);
  const [y, mo, d] = ['1i', '2i', '3i'].map((p) => q(`#proposal_conditions_attributes_0_milestones_attributes_0_deadline_${p}`));
  if (!hourly && days > 0 && y && mo && d && !y.value) {
    const dt = new Date(Date.now() + days * 86400000);
    if ([...y.options].some((o) => o.value === String(dt.getFullYear()))) {
      setValue(y, String(dt.getFullYear()));
      setValue(mo, String(dt.getMonth() + 1));
      setValue(d, String(dt.getDate()));
    }
  }

  const message = q('#proposal_conditions_attributes_0_message_attributes_body') || q('textarea.message-body');
  if (message) setValue(message, role.message);
  else notes.push('message field not found');
  if (!clean(role.message)) notes.push('message template is empty');

  const submit = q('input[type="submit"][name="commit"]');
  if (!submit) notes.push('submit button not found');

  return {
    notes, submit, amount, dummy, hidden, message,
    summary: `${hourly ? `¥${amount}/hour` : `¥${amount}`}${configured ? '' : ' (client\'s posted amount)'}`,
  };
}

// What is no longer filled in (CrowdWorks' scripts or a draft restore can reset fields after we set them).
function cwUnfilled({ amount, dummy, hidden, message }) {
  const lost = [];
  if (!message || !clean(message.value)) lost.push('message');
  if (!dummy || !hidden || digits(dummy.value) !== amount || digits(hidden.value) !== amount) {
    lost.push(`amount (input "${dummy?.value ?? ''}", sent "${hidden?.value ?? ''}")`);
  }
  return lost;
}

// Returns undefined when this isn't a CrowdWorks proposal page, so the generic flow takes over.
async function bidCrowdWorks(role) {
  const onForm = /^\/proposals(\/new)?\/?$/.test(location.pathname);
  if (!onForm) {
    // Submitted and redirected away from the form: the proposal went through.
    if (role.step > 0) return report('done', shortTextMatches(SUCCESS_RE) || `submitted (now on ${location.pathname})`);
    return undefined;
  }
  const form = await waitFor(() => document.querySelector('form#new_proposal'), 15000);
  if (!form) {
    const already = shortTextMatches(ALREADY_RE);
    return report(already ? 'skipped' : 'failed', already || 'CrowdWorks proposal form not found (logged out, already applied, or job closed?)');
  }
  if (role.step > 0 && window.__cwSubmitted) {
    // Same page as the click: the POST is still in flight. Navigation will kill this script and
    // the next page reports the result; only complain if nothing happens for a long time.
    await sleep(30000);
    return report('failed', 'clicked 応募する but the page did not change');
  }
  if (role.step > 0) {
    // Back on the form after submitting = CrowdWorks rejected it; don't resubmit in a loop.
    const errors = [...document.querySelectorAll('.cw-has_error .cw-help_block, .error, .alert, .cw-alert, .flash')]
      .filter(visible).map((e) => clean(e.textContent)).filter(Boolean);
    return report('failed', `CrowdWorks rejected the proposal${errors.length ? `: ${[...new Set(errors)].join(' / ').slice(0, 200)}` : ''}`);
  }

  let filled = fillCrowdWorks(role, form);
  if (filled.notes.length) return report('review', filled.notes.join('; '));
  // Let the page's own scripts settle, then make sure our values stuck; refill once if they didn't.
  await sleep(1500);
  if (cwUnfilled(filled).length) {
    filled = fillCrowdWorks(role, form);
    await sleep(1500);
  }
  let lost = cwUnfilled(filled);
  if (lost.length) return report('review', `did not stay filled: ${lost.join(', ')} — not submitted`);
  if (!role.autoSubmit) return report('review', `form filled (${filled.summary}) — auto-submit is OFF, submit it yourself`);
  await sleep(800);
  // Last check immediately before the click: never send an empty proposal.
  lost = cwUnfilled(filled);
  if (lost.length) return report('review', `did not stay filled: ${lost.join(', ')} — not submitted`);
  await chrome.runtime.sendMessage({ type: 'bidStep' });
  window.__cwSubmitted = true;
  filled.submit.click();
  return watchAfterClick();
}

function report(status, msg) {
  return chrome.runtime.sendMessage({ type: 'bidResult', status, msg });
}

async function bid(siteKey, role) {
  const site = SITES[siteKey];
  if (role.step >= role.maxSteps) return report('failed', 'too many steps without finishing');
  await sleep(1500);

  if (siteKey === 'crowdworks') {
    const r = await bidCrowdWorks(role);
    if (r !== undefined) return r;
  }

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
        if (btn && !isUnfilledFormSubmit(btn)) return { kind: 'confirm', btn };
      }
    }
    // On a proposal form page, "応募する" is the submit button, not a link to the form — never click it unfilled.
    if (PROPOSAL_PATH_RE.test(location.pathname)) return null;
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
      const lost = emptyRequired(scope);
      if (lost.length || !clean(result.field.value)) {
        return report('review', `did not stay filled: ${[...lost, ...(clean(result.field.value) ? [] : ['message'])].join(', ')} — not submitted`);
      }
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
