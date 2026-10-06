async function refresh() {
  const s = await loadSettings();
  const { log, queue = [], bidTimes = [], current } = await chrome.storage.local.get(['log', 'queue', 'bidTimes', 'current']);
  renderStatus(s);
  const today = bidTimes.filter((t) => Date.now() - t < 24 * 3600 * 1000).length;
  document.getElementById('stats').textContent =
    `Bids last 24h: ${today}/${s.maxPerDay} · queued: ${queue.length}` + (current ? ` · bidding: ${current.task.title}` : '');
  renderLog(document.getElementById('log'), log, 12);
}

async function setupBidNow() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) return;
  let url;
  try {
    url = new URL(tab.url);
  } catch {
    return;
  }
  const site = siteKeyForHost(url.host);
  if (!site) return;
  const box = document.getElementById('bidNowBox');
  const msg = document.getElementById('bidNowMsg');
  box.hidden = false;
  const s = await loadSettings();
  msg.textContent = `Fills the ${SITES[site].label} proposal form with your template` + (s.autoSubmit ? ' and submits it.' : '. Auto-submit is OFF, so you press the final button.');
  document.getElementById('bidNow').addEventListener('click', async () => {
    const res = await chrome.runtime.sendMessage({ type: 'bidNow', tabId: tab.id });
    if (res && res.ok) window.close();
    else msg.textContent = (res && res.error) || 'Could not start.';
  });
}

bindToggle();
setupBidNow();
document.getElementById('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
chrome.storage.onChanged.addListener((_, area) => area === 'local' && refresh());
refresh();
