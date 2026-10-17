// ============================================================
// background.js —— 抖音自动续火:调度 + 可信事件执行器
// 抖音消息面板忽略合成事件,因此点击/输入/回车都通过
// chrome.debugger(CDP Input 域)以"浏览器级可信事件"注入。
// 定时由 chrome.alarms 保证;支持多个好友,逐个续火。
// ============================================================

const DEFAULTS = { enabled: true, time: '10:00', message: 'test', names: ['潇然'] };
const APP_URL = 'https://www.douyin.com/';
const ALARM = 'dy-auto-daily';
const DAY_MS = 86400000;
const EXPECT_CS_VERSION = '1.1.1'; // 与 content.js 顶部的 CS_VERSION 一致;不一致说明页面里还是旧脚本,需要刷新注入

// ---------- 小工具 ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dedupe = (arr) => [...new Set((arr || []).map((s) => (s || '').trim()).filter(Boolean))];

const getCfg = async () => {
  const { cfg } = await chrome.storage.local.get('cfg');
  const merged = { ...DEFAULTS, ...(cfg || {}) };
  // 兼容旧版单好友配置
  if (!merged.names || !merged.names.length) merged.names = cfg && cfg.name ? [cfg.name] : [...DEFAULTS.names];
  merged.names = dedupe(merged.names);
  return merged;
};
const setLast = async (last) => chrome.storage.local.set({ last });

const nextDelay = (hhmm) => {
  const [h, m] = (hhmm || '10:00').split(':').map(Number);
  const now = new Date();
  const t = new Date(now);
  t.setHours(h || 10, m || 0, 0, 0);
  let d = t - now;
  if (d <= 0) d += DAY_MS;
  return d;
};

async function scheduleNext() {
  await chrome.alarms.clear(ALARM);
  const cfg = await getCfg();
  if (!cfg.enabled) return;
  const when = Date.now() + nextDelay(cfg.time);
  chrome.alarms.create(ALARM, { when });
  console.log('[dy-auto] 下次续火时间:', new Date(when).toLocaleString(), '→', cfg.names.length, '位好友:', cfg.names.join('、'));
}

// ---------- 与 content script 通信 ----------
function sendTab(tabId, msg) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, (resp) => {
      if (chrome.runtime.lastError) resolve({ __error: chrome.runtime.lastError.message });
      else resolve(resp || {});
    });
  });
}

async function waitContentReady(tabId, { allowReload = true } = {}) {
  let reloaded = false;
  for (let i = 0; i < 20; i++) {
    const r = await sendTab(tabId, { type: 'PING' });
    const err = !r || !!r.__error; // content script 还没注入(装扩展前就打开的页面)
    const stale = !!(r && r.ok && r.v && r.v !== EXPECT_CS_VERSION); // 页面里还是旧版 content script
    if (r && r.ok && !stale) {
      if (reloaded) await sleep(3000); // 刚刷新过,等抖音 SPA 起来
      return true;
    }
    if (allowReload && !reloaded && (err || stale) && i >= 2) {
      reloaded = true;
      chrome.tabs.reload(tabId); // 刷新一次注入最新版 content script
      await waitTabComplete(tabId);
    }
    await sleep(1000);
  }
  return false;
}

// ---------- CDP(debugger) ----------
const DEBUGGER_VER = '1.3';
let attachedTab = null;

async function attach(tabId) {
  if (attachedTab === tabId) return;
  await new Promise((res, rej) => chrome.debugger.attach({ tabId }, DEBUGGER_VER, () =>
    chrome.runtime.lastError ? rej(new Error('attach失败: ' + chrome.runtime.lastError.message)) : res()));
  attachedTab = tabId;
}
async function detach() {
  if (attachedTab == null) return;
  const t = attachedTab;
  attachedTab = null;
  await new Promise((res) => chrome.debugger.detach({ tabId: t }, () => res()));
}
function cdp(method, params) {
  if (attachedTab == null) return Promise.reject(new Error('debugger 未附加'));
  return new Promise((res, rej) => {
    chrome.debugger.sendCommand({ tabId: attachedTab }, method, params || {}, (r) => {
      if (chrome.runtime.lastError) rej(new Error(method + '失败: ' + chrome.runtime.lastError.message));
      else res(r);
    });
  });
}
async function cdpClick(x, y) {
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}
async function cdpTypeText(text) {
  await cdp('Input.insertText', { text });
}
async function cdpEnter() {
  const k = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...k });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...k });
}

// ---------- 页面准备 ----------
async function findDouyinTab() {
  const tabs = await chrome.tabs.query({ url: ['https://www.douyin.com/*', 'https://*.douyin.com/*'] });
  return tabs.find((t) => !t.discarded && t.status !== 'unloaded') || tabs[0] || null;
}
async function waitTabComplete(tabId, timeout = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const t = await chrome.tabs.get(tabId);
    if (t.status === 'complete') return true;
    await sleep(800);
  }
  return false;
}
async function ensurePage() {
  let tab = await findDouyinTab();
  if (!tab) {
    tab = await chrome.tabs.create({ url: APP_URL, active: true });
    await waitTabComplete(tab.id);
    await sleep(4000); // 等 SPA 首屏与登录态恢复
  }
  return tab;
}

// ---------- 面板/列表状态操作(全部通过 CDP 可信点击) ----------

// 打开消息面板(若已打开则跳过),返回最新状态
async function openDialog(tabId) {
  let st = await sendTab(tabId, { type: 'STATUS' });
  if (!st.ok) throw new Error('状态查询失败: ' + (st.note || ''));
  if (st.loginWall) throw new Error('页面处于登录墙,请先手动扫码登录抖音网页版');
  if (st.dialogOpen && !st.editorVisible) return st; // 已在会话列表
  if (!st.dialogOpen) {
    const entry = await sendTab(tabId, { type: 'GET_POINT', target: 'entry' });
    if (!entry.ok) throw new Error('找不到消息入口按钮');
    await cdpClick(entry.x, entry.y);
    await sleep(1800);
    st = await sendTab(tabId, { type: 'STATUS' });
    if (!st.dialogOpen) throw new Error('点击消息入口后面板未打开(可能被风控拦截)');
  }
  return st;
}

// 把面板"关掉再打开",回到会话列表状态(用于切换聊天对象)
async function backToList(tabId) {
  let st = await sendTab(tabId, { type: 'STATUS' });
  if (!st.dialogOpen) { await openDialog(tabId); return; }
  if (!st.editorVisible) return; // 本来就在列表
  const entry = await sendTab(tabId, { type: 'GET_POINT', target: 'entry' });
  if (!entry.ok) throw new Error('找不到消息入口按钮');
  await cdpClick(entry.x, entry.y); // 关闭
  await sleep(1200);
  await cdpClick(entry.x, entry.y); // 重开 → 会话列表
  await sleep(1800);
  st = await sendTab(tabId, { type: 'STATUS' });
  if (!st.dialogOpen || st.editorVisible) throw new Error('回到会话列表失败');
}

// ---------- 给单个好友续火 ----------
async function sendToOne(tabId, name, message) {
  // 1) 确保面板打开且处于"会话列表"状态(或已停在目标会话)
  let st = await sendTab(tabId, { type: 'STATUS', name });
  if (!st.ok) throw new Error('状态查询失败: ' + (st.note || ''));
  if (st.loginWall) throw new Error('页面处于登录墙,请先扫码登录');
  if (!st.dialogOpen) {
    const entry = await sendTab(tabId, { type: 'GET_POINT', target: 'entry' });
    if (!entry.ok) throw new Error('找不到消息入口按钮');
    await cdpClick(entry.x, entry.y);
    await sleep(1800);
    st = await sendTab(tabId, { type: 'STATUS', name });
    if (!st.dialogOpen) throw new Error('消息面板未能打开(可能被风控拦截)');
  }
  if (st.editorVisible && !st.chatTitleOk) {
    // 当前停在他人的聊天窗 → 回列表重进
    await backToList(tabId);
    st = await sendTab(tabId, { type: 'STATUS', name });
  }

  // 2) 进入目标会话
  if (!st.editorVisible) {
    let conv = await sendTab(tabId, { type: 'GET_POINT', target: 'conv', name });
    if (!conv.ok) {
      // 兜底:面板内搜索框搜名字
      console.log('[dy-auto] 列表未找到,尝试搜索:', name);
      const si = await sendTab(tabId, { type: 'GET_POINT', target: 'searchInput' });
      if (!si.ok) throw new Error('会话列表与搜索框都找不到「' + name + '」(请先与该好友聊过一次)');
      await cdpClick(si.x, si.y);
      await sleep(600);
      await cdpTypeText(name);
      await sleep(1500);
      conv = await sendTab(tabId, { type: 'GET_POINT', target: 'searchResult', name });
    }
    if (!conv.ok) throw new Error('找不到联系人「' + name + '」: ' + (conv.note || ''));
    await cdpClick(conv.x, conv.y);
    await sleep(2200);
    st = await sendTab(tabId, { type: 'STATUS', name });
    if (!st.editorVisible) throw new Error('点击会话后聊天窗未打开');
    if (!st.chatTitleOk) throw new Error('打开的会话标题不是「' + name + '」,已中止(防发错人)');
  } else if (!st.chatTitleOk) {
    throw new Error('当前聊天窗不是「' + name + '」,已中止(防发错人)');
  }

  // 3) 输入并发送
  const ed = await sendTab(tabId, { type: 'GET_POINT', target: 'editor' });
  if (!ed.ok) throw new Error('找不到消息输入框');
  await cdpClick(ed.x, ed.y);
  await sleep(500);
  await cdpTypeText(message);
  await sleep(600);
  const check = await sendTab(tabId, { type: 'EDITOR_TEXT' });
  if (!check.ok || !(check.text || '').includes(message)) {
    throw new Error('文字未写入输入框(内容: ' + JSON.stringify((check.text || '').slice(0, 40)) + ')');
  }
  await cdpEnter();
  await sleep(3000);

  const after = await sendTab(tabId, { type: 'EDITOR_TEXT' });
  const empty = after.ok && !(after.text || '').replace(/\u200b/g, '').trim();
  const preview = await sendTab(tabId, { type: 'PREVIEW', name });
  const previewHit = preview.ok && (preview.preview || '').includes(message) && /刚刚|现在/.test(preview.preview || '');
  if (!empty || !previewHit) {
    throw new Error('发送后校验未通过(输入框清空=' + empty + ', 会话预览=' + (preview.preview || '无') + ')');
  }
}

// ---------- 主流程:逐个好友 ----------
async function runOnce(source = 'manual') {
  const cfg = await getCfg();
  const stamp = () => new Date().toLocaleString('zh-CN', { hour12: false });
  const lines = ['@ ' + stamp()];
  let tab = null;
  try {
    if (source === 'alarm' && !cfg.enabled) return;
    if (!cfg.names.length) throw new Error('未设置好友(请在弹窗里勾选或手动输入)');

    tab = await ensurePage();
    console.log('[dy-auto] 使用标签页', tab.id);
    const ready = await waitContentReady(tab.id);
    if (!ready) throw new Error('content script 未就绪(页面可能未加载完成)');
    await attach(tab.id);
    await sleep(500);

    let allOk = true;
    for (let i = 0; i < cfg.names.length; i++) {
      const name = cfg.names[i];
      if (i > 0) {
        // 上一个好友的聊天窗还开着 → 先回列表
        try { await backToList(tab.id); } catch (e) { throw new Error('切换会话失败: ' + e.message); }
      }
      try {
        await sendToOne(tab.id, name, cfg.message);
        console.log('[dy-auto] ✅', name, '续火成功 @', stamp());
        lines.push('✅ ' + name + ':已发送「' + cfg.message + '」');
      } catch (e) {
        allOk = false;
        const err = String(e && e.message || e);
        console.error('[dy-auto] ❌', name, err);
        lines.push('❌ ' + name + ':' + err);
      }
    }
    await setLast({ at: Date.now(), ok: allOk, source, msg: lines.join('\n') });
    setBadge(allOk);
    return { ok: allOk, details: lines.slice(1) };
  } catch (e) {
    const msg = String(e && e.message || e);
    console.error('[dy-auto] ❌', msg);
    lines.push('❌ ' + msg);
    await setLast({ at: Date.now(), ok: false, source, msg: lines.join('\n') });
    setBadge(false);
    return { ok: false, error: msg };
  } finally {
    await detach();
  }
}

// ---------- 拉取好友(会话列表)→ 供弹窗多选下拉使用 ----------
async function loadFriends() {
  let tab = null;
  try {
    tab = await ensurePage();
    const ready = await waitContentReady(tab.id);
    if (!ready) return { ok: false, note: '抖音页面未就绪' };
    await attach(tab.id);
    await sleep(500);
    await openDialog(tab.id);
    await backToList(tab.id);
    const r = await sendTab(tab.id, { type: 'CONV_LIST' });
    if (!r.ok) return { ok: false, note: r.note || '读取会话列表失败' };
    const names = dedupe(r.names);
    await chrome.storage.local.set({ friendsCache: { at: Date.now(), names } });
    return { ok: true, names };
  } catch (e) {
    return { ok: false, note: String(e && e.message || e) };
  } finally {
    await detach();
  }
}

function setBadge(ok) {
  chrome.action.setBadgeBackgroundColor({ color: ok ? '#2e7d32' : '#c62828' });
  chrome.action.setBadgeText({ text: ok ? '✓' : '✗' });
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), 60000);
}

// ---------- 事件注册 ----------
chrome.runtime.onInstalled.addListener(() => { scheduleNext(); });
chrome.runtime.onStartup.addListener(() => { scheduleNext(); });

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== ALARM) return;
  runOnce('alarm').finally(() => scheduleNext());
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case 'RUN_NOW': {
          const r = await runOnce('manual');
          return sendResponse(r);
        }
        case 'LOAD_FRIENDS':
          return sendResponse(await loadFriends());
        case 'RESCHEDULE':
          await scheduleNext();
          return sendResponse({ ok: true });
        default:
          return sendResponse({ ok: false, note: 'unknown' });
      }
    } catch (e) {
      return sendResponse({ ok: false, note: String(e && e.message || e) });
    }
  })();
  return true;
});
