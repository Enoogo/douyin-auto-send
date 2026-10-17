// popup.js —— 抖音自动续火 配置面板
const $ = (s) => document.querySelector(s);
const DEFAULTS = { enabled: true, time: '10:00', message: 'test', names: ['潇然'], manual: '' };

let friendsCache = []; // 从抖音会话列表拉取的好友(供下拉多选)

function msg(type, payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...(payload || {}) }, (r) => {
      if (chrome.runtime.lastError) resolve({ ok: false, note: chrome.runtime.lastError.message });
      else resolve(r || {});
    });
  });
}

const parseNames = (s) => [...new Set((s || '').split(/[,，、;；\n\s]+/).map((x) => x.trim()).filter(Boolean))];

async function load() {
  const { cfg, friendsCache: fc, last } = await chrome.storage.local.get(['cfg', 'friendsCache', 'last']);
  const c = { ...DEFAULTS, ...(cfg || {}) };
  $('#time').value = c.time;
  $('#message').value = c.message;
  $('#enabled').checked = !!c.enabled;
  friendsCache = (fc && fc.names) || [];
  // 手动输入框 = 已配置但不在好友列表里的名字(避免重复)
  const inCache = new Set(friendsCache);
  const extra = (c.names || []).filter((n) => !inCache.has(n));
  const manualVal = (c.manual && c.manual.trim()) ? c.manual : extra.join(',');
  $('#manual').value = manualVal || (friendsCache.length ? '' : (c.names[0] || ''));
  renderFriendList();
  showLast(last);
}

function renderFriendList() {
  const list = $('#frList');
  list.innerHTML = '';
  if (!friendsCache.length) {
    const d = document.createElement('div');
    d.className = 'fr';
    d.textContent = '(空 — 点上方「拉取」按钮读取会话列表)';
    list.appendChild(d);
  }
  for (const n of friendsCache) {
    const label = document.createElement('label');
    label.className = 'fr';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'frChk';
    cb.dataset.name = n;
    label.appendChild(cb);
    label.appendChild(document.createTextNode(n));
    list.appendChild(label);
  }
  syncCount();
}

function syncCount() {
  $('#cnt').textContent = String($('#frList').querySelectorAll('.frChk:checked').length);
}

function currentNames() {
  const checked = [...$('#frList').querySelectorAll('.frChk:checked')].map((cb) => cb.dataset.name);
  return [...new Set([...checked, ...parseNames($('#manual').value)])];
}

function showLast(last) {
  const box = $('#status');
  if (!last) { box.textContent = '还没有执行记录。可先「拉取好友」再点「立即发送一次」测试。'; box.className = ''; return; }
  const time = new Date(last.at).toLocaleString('zh-CN', { hour12: false });
  box.textContent = (last.ok ? '✅ ' : '⚠️ ') + time + '\n' + last.msg;
  box.className = last.ok ? 'ok' : 'err';
}

async function save() {
  const names = currentNames();
  const cfg = {
    enabled: $('#enabled').checked,
    time: $('#time').value || '10:00',
    message: $('#message').value || 'test',
    names,
    manual: $('#manual').value.trim()
  };
  await chrome.storage.local.set({ cfg });
  await msg('RESCHEDULE');
  showLast({ at: Date.now(), ok: true, msg: '设置已保存 → ' + cfg.names.length + ' 位好友: ' + cfg.names.join('、') + '\n定时: 每天 ' + cfg.time });
}

async function loadFriendsFromPage() {
  const box = $('#status');
  box.textContent = '正在读取抖音会话列表…(会打开/复用抖音页,稍等)';
  box.className = '';
  $('#loadFr').disabled = true;
  try {
    const r = await msg('LOAD_FRIENDS');
    if (!r.ok) throw new Error(r.note || '拉取失败');
    friendsCache = r.names || [];
    await chrome.storage.local.set({ friendsCache: { at: Date.now(), names: friendsCache } });
    const want = new Set(currentNames());
    renderFriendList();
    for (const cb of $('#frList').querySelectorAll('.frChk')) {
      cb.checked = want.has(cb.dataset.name); // 之前选的尽量保持勾选
    }
    // 已在列表中的名字从手动输入里去掉,避免重复
    const inCache = new Set(friendsCache);
    const manualLeft = parseNames($('#manual').value).filter((n) => !inCache.has(n));
    $('#manual').value = manualLeft.join(',');
    syncCount();
    box.textContent = '已拉取 ' + friendsCache.length + ' 位好友,请勾选要续火的对象。';
    box.className = 'ok';
  } catch (e) {
    box.textContent = '拉取失败: ' + (e.message || e) + '\n(请确认抖音网页版已登录,可改用下方手动输入)';
    box.className = 'err';
  } finally {
    $('#loadFr').disabled = false;
  }
}

// ---------- 事件 ----------
$('#save').addEventListener('click', save);

$('#now').addEventListener('click', async () => {
  await save();
  const box = $('#status');
  box.textContent = '执行中(逐个好友发送,请稍候)…';
  box.className = '';
  const r = await msg('RUN_NOW');
  const { last } = await chrome.storage.local.get('last');
  showLast(last || { at: Date.now(), ok: r.ok, msg: r.note || (r.ok ? '成功' : '失败') });
});

$('#ddBtn').addEventListener('click', () => {
  $('#ddPanel').hidden = !$('#ddPanel').hidden;
});
$('#loadFr').addEventListener('click', (e) => { e.stopPropagation(); loadFriendsFromPage(); });
$('#frList').addEventListener('change', syncCount);
$('#selAll').addEventListener('click', () => { $('#frList').querySelectorAll('.frChk').forEach((cb) => { cb.checked = true; }); syncCount(); });
$('#selNone').addEventListener('click', () => { $('#frList').querySelectorAll('.frChk').forEach((cb) => { cb.checked = false; }); syncCount(); });

load();
