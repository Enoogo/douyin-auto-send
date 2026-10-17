// ============================================================
// content.js —— 抖音自动续火:页面侧"侦察兵"  (CS_VERSION 需与 background.js 的 EXPECT_CS_VERSION 一致)
// 只负责:查找元素、报告坐标/状态。所有"点击/输入"都由
// background 通过 chrome.debugger(CDP)发送可信事件完成,
// 因为抖音消息面板会忽略 el.click() 等合成事件(isTrusted 校验)。
// ============================================================
(() => {
  if (window.__dyAutoInjected) return;
  window.__dyAutoInjected = true;
  const CS_VERSION = '1.1.1';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);

  const isVisible = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 5 && r.height > 5;
  };

  const norm = (s) => (s || '').replace(/\s+/g, '').trim();

  const firstLine = (el) => (el.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean)[0] || '';

  const point = async (el) => {
    el.scrollIntoView({ block: 'center', inline: 'center' });
    await sleep(250);
    const r = el.getBoundingClientRect();
    return { ok: true, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  };

  // ---------- 各目标的定位 ----------

  const findEntry = () => {
    const el = $('[data-e2e="im-entry"]');
    return isVisible(el) ? el : null;
  };

  const findDialog = () => $('[data-e2e="im-dialog"]');

  const dialogOpen = () => {
    const d = findDialog();
    if (!d) return false;
    const r = d.getBoundingClientRect();
    if (r.width < 20 || r.height < 20) return false;
    // 面板里要有可见内容(会话列表/聊天区任一可见元素)
    return [...d.querySelectorAll('div')].some((el) => isVisible(el) && el !== d);
  };

  const findConvItem = (name) => {
    const items = [...document.querySelectorAll('[data-e2e="conversation-item"]')];
    return items.find((el) => isVisible(el) && firstLine(el) === norm(name)) ||
           items.find((el) => isVisible(el) && (el.innerText || '').includes(norm(name))) || null;
  };

  const findEditor = () => {
    const list = [
      $('[data-slate-editor="true"]'),
      $('.messageEditorinputArea'),
      ...[...document.querySelectorAll('[contenteditable="true"]')]
    ];
    return list.find((el) => el && isVisible(el)) || null;
  };

  const findChatTitle = (name) => {
    // 聊天窗标题:文本===名字、不在会话列表项里、位于面板上半部(标题栏)
    const d = findDialog();
    if (!d) return null;
    const dr = d.getBoundingClientRect();
    return [...d.querySelectorAll('div, span, p')].find((el) => {
      if (!isVisible(el)) return false;
      if (norm(el.innerText || '') !== norm(name)) return false;
      if (el.closest('[data-e2e="conversation-item"]')) return false;
      const r = el.getBoundingClientRect();
      return r.width < 400 && r.width > 20 && r.top < dr.top + Math.min(300, dr.height * 0.35);
    }) || null;
  };

  const findSearchInput = () => {
    const d = findDialog();
    if (!d) return null;
    const inputs = [...d.querySelectorAll('input')].filter((el) => isVisible(el));
    return inputs.find((el) => (el.placeholder || '').includes('搜索')) || inputs[0] || null;
  };

  const findSearchResult = (name) => {
    const d = findDialog();
    if (!d) return null;
    return [...d.querySelectorAll('[data-e2e], div, li')].find((el) => {
      if (!isVisible(el)) return false;
      if (el.closest('[data-e2e="conversation-item"]')) return false;
      const t = (el.innerText || '').trim();
      if (norm(t) !== norm(name) && !(t.length < 60 && t.includes(name))) return false;
      const r = el.getBoundingClientRect();
      return r.width > 40 && r.width < 500; // 排除整页级容器
    }) || null;
  };

  const findLoginWall = () => {
    const el = [...document.querySelectorAll('div, p, span')].find((n) => {
      const t = n.innerText || '';
      return isVisible(n) && t.length < 40 && /扫码登录|手机号登录|验证码登录/.test(t) && !n.querySelector('*');
    });
    return !!el;
  };

  // ---------- 状态与坐标查询 ----------

  const status = (name) => {
    const entry = findEntry();
    const editor = findEditor();
    const title = editor ? findChatTitle(name) : null;
    const d = findDialog();
    const dr = d ? d.getBoundingClientRect() : null;
    return {
      ok: true,
      loginWall: findLoginWall(),
      entryVisible: !!entry,
      entryPoint: entry ? { x: Math.round(entry.getBoundingClientRect().x + entry.getBoundingClientRect().width / 2), y: Math.round(entry.getBoundingClientRect().y + entry.getBoundingClientRect().height / 2) } : null,
      dialogOpen: dialogOpen(),
      dialogRect: dr ? [Math.round(dr.x), Math.round(dr.y), Math.round(dr.width), Math.round(dr.height)] : null,
      convVisible: !!findConvItem(name),
      editorVisible: !!editor,
      chatTitleOk: !!title
    };
  };

  const conversationPreview = (name) => {
    const item = findConvItem(name);
    return { ok: !!item, preview: item ? (item.innerText || '').replace(/\n/g, ' | ') : '' };
  };

  // 读取当前可见的会话列表(每个会话首行=名字),用于"多选好友"下拉
  const listConversations = () => {
    const seen = new Set();
    const names = [];
    for (const el of document.querySelectorAll('[data-e2e="conversation-item"]')) {
      if (!isVisible(el)) continue;
      const n = firstLine(el);
      if (n && !seen.has(n)) { seen.add(n); names.push(n); }
    }
    return names;
  };

  // ---------- 消息处理 ----------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      try {
        switch (msg.type) {
          case 'PING':
            return sendResponse({ ok: true, ready: true, v: CS_VERSION });

          case 'STATUS':
            return sendResponse(status(msg.name || ''));

          case 'GET_POINT': {
            let el = null, note = '';
            if (msg.target === 'entry') el = findEntry();
            else if (msg.target === 'conv') { el = findConvItem(msg.name || ''); note = el ? '' : '会话列表中找不到' + (msg.name || ''); }
            else if (msg.target === 'editor') el = findEditor();
            else if (msg.target === 'searchInput') el = findSearchInput();
            else if (msg.target === 'searchResult') el = findSearchResult(msg.name || '');
            if (!el) return sendResponse({ ok: false, note });
            const p = await point(el);
            return sendResponse({ ok: true, x: p.x, y: p.y, note });
          }

          case 'EDITOR_TEXT': {
            const ed = findEditor();
            return sendResponse({ ok: !!ed, text: ed ? (ed.innerText || '') : '' });
          }

          case 'CONV_LIST':
            return sendResponse({ ok: true, open: dialogOpen(), names: listConversations() });

          case 'PREVIEW':
            return sendResponse(conversationPreview(msg.name || ''));

          default:
            return sendResponse({ ok: false, note: 'unknown msg ' + msg.type });
        }
      } catch (e) {
        return sendResponse({ ok: false, note: String(e && e.message || e) });
      }
    })();
    return true; // 异步响应
  });
})();
