importScripts('sites.js');

const ALARM = 'tick';
const BID_TIMEOUT_MS = 3 * 60 * 1000;
const MAX_SEEN_PER_SITE = 3000;
const MAX_LOG = 300;
const MAX_STEPS = 5;

// ---------- storage helpers ----------

// Serialize all read-modify-write cycles so concurrent messages don't clobber each other.
let lock = Promise.resolve();
function withLock(fn) {
  const run = lock.then(fn, fn);
  lock = run.catch(() => {});
  return run;
}

async function getState() {
  const st = await chrome.storage.local.get(null);
  const settings = mergeSettings(st.settings);
  return {
    settings,
    seen: st.seen || {},
    baseline: st.baseline || {},
    queue: st.queue || [],
    current: st.current || null,
    bidTimes: st.bidTimes || [],
    monitor: st.monitor || { windowId: null, tabs: {} },
    log: st.log || [],
  };
}

async function addLog(level, msg, extra = {}) {
  const { log = [] } = await chrome.storage.local.get('log');
  log.unshift({ time: Date.now(), level, msg, ...extra });
  await chrome.storage.local.set({ log: log.slice(0, MAX_LOG) });
}

function notify(id, title, message) {
  chrome.notifications.create(id, { type: 'basic', iconUrl: 'icon.png', title, message });
}

// ---------- monitor tabs ----------

async function ensureWindow(monitor) {
  if (monitor.windowId != null) {
    try {
      await chrome.windows.get(monitor.windowId);
      return monitor.windowId;
    } catch {
      monitor.tabs = {};
    }
  }
  const win = await chrome.windows.create({ focused: false, url: 'about:blank' });
  monitor.windowId = win.id;
  return win.id;
}

async function refreshMonitors(state) {
  const { settings, monitor } = state;
  const windowId = await ensureWindow(monitor);
  for (const key of Object.keys(SITES)) {
    const conf = settings.sites[key];
    const tabId = monitor.tabs[key];
    if (!conf.enabled) {
      if (tabId != null) {
        chrome.tabs.remove(tabId).catch(() => {});
        delete monitor.tabs[key];
      }
      continue;
    }
    let tab = null;
    if (tabId != null) tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) {
      tab = await chrome.tabs.create({ windowId, url: conf.searchUrl, active: false, pinned: true });
      monitor.tabs[key] = tab.id;
    } else if (tab.url !== conf.searchUrl) {
      await chrome.tabs.update(tab.id, { url: conf.searchUrl });
    } else {
      await chrome.tabs.reload(tab.id, { bypassCache: true });
    }
  }
  await chrome.storage.local.set({ monitor });
}

// ---------- job handling ----------

function splitKeywords(text) {
  return (text || '')
    .split(/[\s,、]+/)
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);
}

function passesFilters(job, settings) {
  const title = (job.title || '').toLowerCase();
  const include = splitKeywords(settings.includeKeywords);
  const exclude = splitKeywords(settings.excludeKeywords);
  if (exclude.some((k) => title.includes(k))) return false;
  if (include.length && !include.some((k) => title.includes(k))) return false;
  return true;
}

async function handleJobs(site, jobs) {
  const state = await getState();
  if (!state.settings.running) return;
  const seen = new Set(state.seen[site] || []);

  if (!jobs.length) {
    await addLog('warn', `${SITES[site].label}: no jobs found on the search page (logged out or page layout changed?)`);
    return;
  }

  if (!state.baseline[site]) {
    state.baseline[site] = true;
    await chrome.storage.local.set({ baseline: state.baseline });
    if (!state.settings.bidExisting) {
      jobs.forEach((j) => seen.add(j.id));
      await chrome.storage.local.set({ seen: { ...state.seen, [site]: [...seen].slice(-MAX_SEEN_PER_SITE) } });
      await addLog('info', `${SITES[site].label}: watching (${jobs.length} existing jobs ignored)`);
      return;
    }
    await addLog('info', `${SITES[site].label}: watching — queueing ${jobs.length} listed jobs`);
  }

  const fresh = jobs.filter((j) => !seen.has(j.id));
  if (!fresh.length) return;
  fresh.forEach((j) => seen.add(j.id));

  for (const job of fresh) {
    if (passesFilters(job, state.settings)) {
      state.queue.push({ site, id: job.id, title: job.title, url: SITES[site].jobUrl(job.id), foundAt: Date.now() });
      await addLog('info', `${SITES[site].label}: new job queued — ${job.title}`, { url: SITES[site].jobUrl(job.id) });
    } else {
      await addLog('info', `${SITES[site].label}: new job skipped by keyword filter — ${job.title}`, { url: SITES[site].jobUrl(job.id) });
    }
  }
  await chrome.storage.local.set({
    seen: { ...state.seen, [site]: [...seen].slice(-MAX_SEEN_PER_SITE) },
    queue: state.queue,
  });
}

let rateLimitLogged = false;

async function processQueue() {
  const state = await getState();
  const { settings, current, queue } = state;
  if (!settings.running || current || !queue.length) return;

  const now = Date.now();
  const bidTimes = state.bidTimes.filter((t) => now - t < 24 * 3600 * 1000);
  const lastHour = bidTimes.filter((t) => now - t < 3600 * 1000).length;
  if (lastHour >= settings.maxPerHour || bidTimes.length >= settings.maxPerDay) {
    // Wait; the queue is retried on every tick. Log once per stretch of waiting, not every tick.
    if (!rateLimitLogged) {
      rateLimitLogged = true;
      const which = lastHour >= settings.maxPerHour ? `${lastHour}/${settings.maxPerHour} this hour` : `${bidTimes.length}/${settings.maxPerDay} today`;
      await addLog('warn', `Bid limit reached (${which}) — ${queue.length} job(s) waiting in the queue`);
    }
    return;
  }
  rateLimitLogged = false;

  const task = queue.shift();
  const windowId = await ensureWindow(state.monitor);
  const tab = await chrome.tabs.create({ windowId, url: bidStartUrl(task.site, task.id), active: false });
  bidTimes.push(now);
  await chrome.storage.local.set({
    queue,
    bidTimes,
    monitor: state.monitor,
    current: { tabId: tab.id, task, startedAt: now, step: 0 },
  });
  await addLog('info', `${SITES[task.site].label}: opening job to bid — ${task.title}`, { url: task.url });
}

async function finishCurrent(status, msg) {
  const { current } = await getState();
  if (!current) return;
  const { task, tabId } = current;
  const label = SITES[task.site].label;
  const level = status === 'done' ? 'success' : status === 'review' || status === 'skipped' ? 'warn' : 'error';
  await chrome.storage.local.set({ current: null });
  await addLog(level, `${label}: ${status.toUpperCase()} — ${task.title}${msg ? ` (${msg})` : ''}`, { url: task.url });

  if (task.manual) {
    // Started from the popup in the user's own tab: never close it.
    notify(`tab-${tabId}`, `${status === 'done' ? 'Proposal sent' : status.toUpperCase()} (${label})`, `${task.title}\n${msg || ''}`);
  } else if (status === 'done') {
    notify(`tab-${tabId}`, `Proposal sent (${label})`, task.title);
    setTimeout(() => chrome.tabs.remove(tabId).catch(() => {}), 3000);
  } else if (status === 'skipped') {
    chrome.tabs.remove(tabId).catch(() => {});
  } else {
    // Leave the tab open so it can be finished by hand.
    notify(`tab-${tabId}`, status === 'review' ? `Check proposal (${label})` : `Bid failed (${label})`, `${task.title}\n${msg || ''}`);
  }
}

function renderTemplate(template, task) {
  const d = new Date();
  const date = `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
  return template
    .replaceAll('{title}', task.title || '')
    .replaceAll('{url}', task.url)
    .replaceAll('{site}', SITES[task.site].label)
    .replaceAll('{date}', date);
}

// Bid on the job open in the given tab (from the popup). Works whether or not watching is running.
async function bidNow(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return { ok: false, error: 'Tab not found.' };
  const url = new URL(tab.url);
  const site = siteKeyForHost(url.host);
  if (!site) return { ok: false, error: 'Not a CrowdWorks / Lancers / Coconala page.' };
  const state = await getState();
  if (state.current && Date.now() - state.current.startedAt > BID_TIMEOUT_MS) {
    await finishCurrent('failed', 'timed out');
    state.current = null;
  }
  if (state.current) return { ok: false, error: `Busy with another bid: ${state.current.task.title}` };

  const id = (url.pathname.match(SITES[site].jobIdRe) || [])[1] || url.searchParams.get('job_offer_id') || url.pathname;
  const task = { site, id, title: tab.title, url: tab.url, foundAt: Date.now(), manual: true };
  const seen = new Set(state.seen[site] || []);
  seen.add(id);
  await chrome.storage.local.set({
    current: { tabId, task, startedAt: Date.now(), step: 0 },
    seen: { ...state.seen, [site]: [...seen].slice(-MAX_SEEN_PER_SITE) },
  });
  await addLog('info', `${SITES[site].label}: manual bid — ${tab.title}`, { url: tab.url });
  if (SITES[site].proposeUrl && /^\d+$/.test(id)) {
    // Go straight to the proposal form (e.g. CrowdWorks proposals/new?job_offer_id=...).
    await chrome.tabs.update(tabId, { url: SITES[site].proposeUrl(id) });
  } else {
    // Reload so the content script starts fresh and picks up its bid role.
    await chrome.tabs.reload(tabId);
  }
  return { ok: true };
}

// ---------- tick ----------

// Refresh cycle: reload the search pages, bid on every job they queued, and only then wait the interval
// before the next reload. While bids are pending, a tick just keeps the queue moving.
async function tick() {
  await withLock(async () => {
    const state = await getState();
    if (!state.settings.running) return;
    if (state.current && Date.now() - state.current.startedAt > BID_TIMEOUT_MS) {
      await finishCurrent('failed', 'timed out');
    }
    const now = await getState();
    if (now.current || now.queue.length) await processQueue();
    else await refreshMonitors(now);
    // Fallback / watchdog; replaced by a fresh interval when the last pending bid finishes.
    await scheduleAlarm(now.settings);
  });
}

// One-shot timer for the next tick, intervalSec from now.
async function scheduleAlarm(settings) {
  await chrome.alarms.clear(ALARM);
  if (settings.running) {
    const sec = Math.max(30, Number(settings.intervalSec) || 30);
    chrome.alarms.create(ALARM, { delayInMinutes: sec / 60 });
  }
}

// When the last pending bid is finished, count the wait before the next refresh from now.
async function rearmIfIdle() {
  const { settings, current, queue } = await getState();
  if (settings.running && !current && !queue.length) await scheduleAlarm(settings);
}

async function start() {
  await withLock(async () => {
    const { settings } = await getState();
    settings.running = true;
    // Re-baseline so jobs posted while stopped are not bid on in bulk.
    await chrome.storage.local.set({ settings, baseline: {}, queue: [], current: null });
    await addLog('info', `Started (every ${Math.max(30, settings.intervalSec)}s, auto-submit ${settings.autoSubmit ? 'ON' : 'OFF'})`);
    await scheduleAlarm(settings);
  });
  await tick();
}

async function stop() {
  await withLock(async () => {
    const { settings } = await getState();
    settings.running = false;
    await chrome.storage.local.set({ settings, queue: [], current: null });
    await chrome.alarms.clear(ALARM);
    await addLog('info', 'Stopped');
  });
}

// ---------- events ----------

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) tick();
});

chrome.runtime.onStartup.addListener(async () => {
  const { settings } = await getState();
  await scheduleAlarm(settings);
});

chrome.runtime.onInstalled.addListener(async () => {
  const { settings } = await getState();
  await chrome.storage.local.set({ settings });
  await scheduleAlarm(settings);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  const { oldValue = {}, newValue = {} } = changes.settings;
  if (oldValue.intervalSec !== newValue.intervalSec && newValue.running) {
    scheduleAlarm(mergeSettings(newValue));
  }
  // A changed search URL means a different result set: take a fresh baseline for that site.
  const changedSites = Object.keys(SITES).filter(
    (k) => oldValue.sites && newValue.sites && oldValue.sites[k]?.searchUrl !== newValue.sites[k]?.searchUrl
  );
  if (changedSites.length) {
    withLock(async () => {
      const { baseline } = await getState();
      changedSites.forEach((k) => delete baseline[k]);
      await chrome.storage.local.set({ baseline });
    });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  withLock(async () => {
    const state = await getState();
    if (state.current && state.current.tabId === tabId) {
      await chrome.storage.local.set({ current: null });
      await addLog('warn', `${SITES[state.current.task.site].label}: bid tab was closed — ${state.current.task.title}`);
      await processQueue();
      await rearmIfIdle();
    }
    for (const [k, id] of Object.entries(state.monitor.tabs)) {
      if (id === tabId) delete state.monitor.tabs[k];
    }
    await chrome.storage.local.set({ monitor: state.monitor });
  });
});

chrome.notifications.onClicked.addListener(async (id) => {
  const m = id.match(/^tab-(\d+)$/);
  if (!m) return;
  const tab = await chrome.tabs.get(Number(m[1])).catch(() => null);
  if (!tab) return;
  await chrome.windows.update(tab.windowId, { focused: true });
  await chrome.tabs.update(tab.id, { active: true });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender).then(sendResponse, (err) => {
    console.error(err);
    sendResponse(null);
  });
  return true;
});

async function handleMessage(msg, sender) {
  const tabId = sender.tab && sender.tab.id;
  switch (msg.type) {
    case 'hello': {
      const state = await getState();
      if (state.settings.running) {
        for (const [site, id] of Object.entries(state.monitor.tabs)) {
          if (id === tabId) return { role: 'monitor', site };
        }
      }
      const cur = state.current;
      if (cur && cur.tabId === tabId) {
        const conf = state.settings.sites[cur.task.site];
        return {
          role: 'bid',
          site: cur.task.site,
          step: cur.step,
          maxSteps: MAX_STEPS,
          autoSubmit: state.settings.autoSubmit,
          message: renderTemplate(conf.template, cur.task),
          price: conf.price,
          hourlyWage: conf.hourlyWage,
          hoursPerWeek: conf.hoursPerWeek,
          deliveryDays: conf.deliveryDays,
        };
      }
      return null;
    }
    case 'jobs':
      return withLock(async () => {
        const { monitor } = await getState();
        if (monitor.tabs[msg.site] !== tabId) return;
        await handleJobs(msg.site, msg.jobs);
        await processQueue();
      });
    case 'bidStep':
      return withLock(async () => {
        const { current } = await getState();
        if (!current || current.tabId !== tabId) return;
        current.step += 1;
        await chrome.storage.local.set({ current });
      });
    case 'bidResult':
      return withLock(async () => {
        const { current } = await getState();
        if (!current || current.tabId !== tabId) return;
        await finishCurrent(msg.status, msg.msg);
        await processQueue();
        await rearmIfIdle();
      });
    case 'bidNow':
      return withLock(() => bidNow(msg.tabId));
    case 'start':
      return start();
    case 'stop':
      return stop();
    case 'resetSeen':
      return withLock(async () => {
        await chrome.storage.local.set({ seen: {}, baseline: {} });
        await addLog('info', 'Seen-job history cleared');
      });
    case 'clearLog':
      return chrome.storage.local.set({ log: [] });
    default:
      return null;
  }
}
