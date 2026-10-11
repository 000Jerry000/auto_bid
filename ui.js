// Helpers shared by the popup and the options page.

async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return mergeSettings(settings);
}

function renderStatus(settings) {
  const status = document.getElementById('status');
  const toggle = document.getElementById('toggle');
  status.textContent = settings.running ? (settings.autoSubmit ? 'Running · auto-submit' : 'Running · review mode') : 'Stopped';
  status.className = 'badge ' + (settings.running ? 'on' : 'off');
  toggle.textContent = settings.running ? 'Stop' : 'Start';
}

function renderLog(listEl, log, limit) {
  listEl.replaceChildren();
  for (const entry of (log || []).slice(0, limit)) {
    const li = document.createElement('li');
    li.className = entry.level;
    const time = document.createElement('time');
    time.textContent = new Date(entry.time).toLocaleTimeString();
    li.append(time, ' ');
    if (entry.url) {
      const a = document.createElement('a');
      a.href = entry.url;
      a.target = '_blank';
      a.textContent = entry.msg;
      li.append(a);
    } else {
      li.append(entry.msg);
    }
    listEl.append(li);
  }
  if (!listEl.children.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'No activity yet.';
    listEl.append(li);
  }
}

function bindToggle() {
  document.getElementById('toggle').addEventListener('click', async () => {
    const s = await loadSettings();
    await chrome.runtime.sendMessage({ type: s.running ? 'stop' : 'start' });
  });
}
