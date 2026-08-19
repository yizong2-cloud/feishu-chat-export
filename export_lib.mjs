// export_lib.mjs - core export library (CDP driving + store extraction)

export async function connect(port = 9333) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = list.find(t => t.type === 'page' && /feishu\.cn\/next\/messenger/.test(t.url)) || list.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((res, rej) => {
    const mid = ++id; pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id); pending.delete(msg.id);
      msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
    }
  };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  await send('Runtime.enable');
  const evl = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, timeout: 60000 });
    if (r.exceptionDetails) {
      throw new Error('page eval error: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text || JSON.stringify(r.exceptionDetails)));
    }
    return r.result.value;
  };
  return { send, evl };
}

// ---- in-page helpers (passed as expression strings) ----

export const PAGE_HELPERS = `
window.__EXPORT_HELPERS = {
  // enumerate feed chats from DOM + shortcut
  enumFeeds: () => {
    const ids = Array.from(document.querySelectorAll('[data-feed-id]')).map(el => el.getAttribute('data-feed-id'));
    const shortcut = Array.from(document.querySelectorAll('.feed-shortcut-item, .feed-shortcut-list [data-feed-id]'));
    return JSON.stringify({ids, shortcutCount: shortcut.length});
  },
  // current chat key in chatMap
  currentChat: () => {
    const st = window.__FEED_WIN_STORE.getState();
    const cm = st.get('chatMap');
    return cm.keySeq().first();
  },
  // click a feed item by id (must be rendered & in view)
  clickFeedById: (feedId) => {
    const el = document.querySelector('[data-feed-id="' + feedId + '"]');
    if (!el) return 'missing';
    el.scrollIntoView({block: 'center'});
    const r = el.getBoundingClientRect();
    return JSON.stringify({x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2)});
  },
  // click the "back to newest" floating button if visible
  clickToNewest: () => {
    const el = document.querySelector('.messageTip__toNewestTip');
    if (!el) return 'none';
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return 'none';
    return JSON.stringify({x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2)});
  },
  // click the shortcut chat by title
  clickShortcut: (title) => {
    const items = Array.from(document.querySelectorAll('.feed-shortcut-item, .feed-quickswitch [class*="item"]'));
    const el = items.find(e => (e.innerText || '').trim() === title) || items.find(e => (e.innerText || '').includes(title));
    if (!el) return 'missing';
    el.scrollIntoView({block: 'center'});
    const r = el.getBoundingClientRect();
    return JSON.stringify({x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2)});
  },
  // scroll the feed container
  scrollFeed: (delta) => {
    const sc = document.querySelector('.lark_feedMainList');
    if (!sc) return 'no feed';
    sc.scrollTop += delta;
    return String(sc.scrollTop);
  },
  // message window + min createTime of loaded messages
  loadState: () => {
    const st = window.__FEED_WIN_STORE.getState();
    const cm = st.get('chatMap');
    const k = cm.keySeq().first();
    const e = cm.get(k).entities;
    const m = cm.get(k).__messages__;
    let minT = 1e18, maxT = 0, count = 0;
    e.messages.keySeq().forEach(mid => {
      const t = Number(e.messages.get(mid).createTime);
      if (t) { count++; if (t < minT) minT = t; if (t > maxT) maxT = t; }
    });
    // createTime at the window's oldest position
    let startTime = 0;
    try {
      const idAtStart = m.messagePos2Id.get(m.start);
      if (idAtStart) startTime = Number(e.messages.get(idAtStart).createTime) || 0;
    } catch (err) {}
    return JSON.stringify({chat: k, start: m.start, end: m.end, loaded: e.messages.size, minT: minT === 1e18 ? 0 : minT, maxT, startTime});
  },
  // scroll message list to top
  msgToTop: () => {
    const sc = document.querySelector('.chatMessageContainer .scroller');
    if (sc) sc.scrollTop = 0;
    return 'ok';
  },
  msgToBottom: () => {
    const sc = document.querySelector('.chatMessageContainer .scroller');
    if (sc) sc.scrollTop = sc.scrollHeight;
    return 'ok';
  },
  msgScrollBy: (delta) => {
    const sc = document.querySelector('.chatMessageContainer .scroller');
    if (sc) sc.scrollTop += delta;
    return 'ok';
  },
  msgScrollInfo: () => {
    const sc = document.querySelector('.chatMessageContainer .scroller');
    return sc ? JSON.stringify({top: sc.scrollTop, max: sc.scrollHeight}) : 'none';
  },
  // collect media urls from rendered messages (only real content, skip avatars/blob)
  collectMedia: () => {
    const med = window.__MEDIA || (window.__MEDIA = {});
    const items = document.querySelectorAll('.js-message-item');
    let n = 0;
    for (const it of items) {
      const mid = it.id; if (!mid) continue;
      if (med[mid]) continue;
      const a = it.querySelector('a[href]');
      const fileEl = it.querySelector('[class*="file-name"], [class*="fileName"], [class*="file_name"]');
      const imgs = Array.from(it.querySelectorAll('img')).filter(im => !(im.className || '').toString().includes('ud__avatar'));
      const realImg = imgs.find(im => (im.currentSrc || im.src || '').startsWith('http'));
      if (a && a.href.startsWith('http')) { med[mid] = { link: a.href, name: fileEl ? fileEl.innerText : '' }; n++; }
      else if (fileEl) { med[mid] = { name: fileEl.innerText }; n++; }
      else if (realImg) { med[mid] = { img: realImg.currentSrc || realImg.src }; n++; }
    }
    return String(Object.keys(med).length);
  },
  getMedia: () => JSON.stringify(window.__MEDIA || {}),
  // chat meta
  chatMeta: () => {
    const st = window.__FEED_WIN_STORE.getState();
    const cm = st.get('chatMap');
    const k = cm.keySeq().first();
    const e = cm.get(k).entities;
    const chat = e.chats.get(k);
    const members = [];
    e.chatters.keySeq().forEach(cid => {
      const c = e.chatters.get(cid);
      if (c && c.name && String(cid) !== '1') members.push({id: cid, name: c.name, type: c.type});
    });
    return JSON.stringify({
      chat: k,
      name: chat ? chat.name : '',
      type: chat ? chat.type : null,
      chatterCount: chat ? chat.chatterCount : null,
      userCount: chat ? chat.userCount : null,
      ownerId: chat ? chat.ownerId : '',
      lastPos: chat ? chat.lastMessagePosition : null,
      members
    });
  }
};
`;

export function clickExpr(feedId) {
  return `window.__EXPORT_HELPERS.clickFeedById(${JSON.stringify(feedId)})`;
}
export function clickShortcutExpr(title) {
  return `window.__EXPORT_HELPERS.clickShortcut(${JSON.stringify(title)})`;
}

// extract messages with T0 <= createTime <= T1, from position range [fromPos, toPos]
// T0/T1: unix seconds (inclusive); null = unbounded
// returns JSON string array
export const EXTRACT_FN = (T0, T1, fromPos, toPos) => `
(() => {
  const T0 = ${T0 === null || T0 === undefined ? 'null' : T0};
  const T1 = ${T1 === null || T1 === undefined ? 'null' : T1};
  const FROMPOS = ${fromPos === undefined ? 'null' : fromPos};
  const TOPOS = ${toPos === undefined ? 'null' : toPos};
  const st = window.__FEED_WIN_STORE.getState();
  const cm = st.get('chatMap');
  const chatId = cm.keySeq().first();
  const e = cm.get(chatId).entities;
  const m = cm.get(chatId).__messages__;
  const msgs = e.messages;
  const p2id = m.messagePos2Id;
  const chatters = {};
  e.chatters.keySeq().forEach(cid => { const c = e.chatters.get(cid); if (c) chatters[cid] = {name: c.name, type: c.type}; });
  const reactions = e.reactions || {};
  const media = window.__MEDIA || {};
  const filesEntity = e.files || {};
  const IMG_BASE = 'https://internal-api-lark-file.feishu.cn/static-resource/v1/';
  const clean = (o) => {
    if (Array.isArray(o)) {
      const a = o.map(clean).filter(v => v !== undefined);
      return a.length ? a : undefined;
    }
    if (o && typeof o === 'object') {
      const r = {};
      for (const k of Object.keys(o)) {
        if (['typedElementRefs','values','wideStyle','style','styleKeys'].includes(k)) continue;
        const v = clean(o[k]);
        if (v !== undefined) r[k] = v;
      }
      return Object.keys(r).length ? r : undefined;
    }
    if (o === null || o === undefined || o === '' || o === 0) return undefined;
    return o;
  };
  const textOf = (c) => {
    const rt = c.richText;
    if (!rt || !rt.elements) return '';
    const collect = (id, visited) => {
      if (visited.has(id)) return '';
      visited.add(id);
      const el = rt.elements[id];
      if (!el) return '';
      let s = '';
      const p = el.property || {};
      if (p.text && p.text.content) s += p.text.content;
      else if (p.emotion && p.emotion.key) s += '[表情:' + p.emotion.key + ']';
      else if (p.mention) s += '@' + (p.mention.name || p.mention.id || '');
      if (el.childIds) for (const cid of el.childIds) s += collect(cid, visited);
      return s;
    };
    const order = rt.elementIds && rt.elementIds.length ? rt.elementIds : Object.keys(rt.elements);
    let s = '';
    for (const id of order) s += collect(id, new Set());
    return s;
  };
  const build = (mid) => {
    const raw = msgs.get(mid);
    if (!raw) return null;
    const msg = raw.toJS ? raw.toJS() : raw;
    const t = Number(msg.createTime) || 0;
    if (T0 !== null && t < T0) return null;
    if (T1 !== null && t > T1) return null;
    const c = msg.content || {};
    const reactionsArr = reactions.get ? reactions.get(mid) : (reactions[mid] || []);
    const img = c.image || null;
    const isImgType = (msg.type === 5 || msg.type === 10);
    const imageKey = (img && img.origin && img.origin.key) || (img && img.key) || c.imageKey || (isImgType ? (c.key || '') : '');
    const imageUrl = imageKey ? IMG_BASE + imageKey + '~?image_size=noop&cut_type=&quality=&format=image' : '';
    const fileKey = c.fileKey || '';
    let fileName = '';
    if (fileKey) {
      const fe = filesEntity.get ? filesEntity.get(fileKey) : filesEntity[fileKey];
      fileName = fe ? (fe.filename || fe.name || '') : '';
    }
    const mediaEntry = media[mid] || null;
    return {
      id: msg.id,
      type: msg.type,
      createTime: t,
      fromId: msg.fromId || '',
      fromName: chatters[msg.fromId] ? chatters[msg.fromId].name : '',
      text: textOf(c),
      imageKey,
      imageUrl,
      fileKey,
      fileName,
      key: c.key || '',
      width: c.width || '',
      height: c.height || '',
      systemType: c.systemType || null,
      systemText: c.text || '',
      replyTo: (msg.rootId && msg.rootId !== msg.id) ? {rootId: msg.rootId, parentId: msg.parentId || ''} : null,
      isRecalled: !!msg.isRecalled,
      status: msg.status || null,
      reactions: reactionsArr,
      media: mediaEntry,
      content: clean(c) || null
    };
  };
  // gather positions sorted
  const entries = [];
  p2id.forEach((id, pos) => {
    const p = Number(pos);
    if (FROMPOS !== null && p < FROMPOS) return;
    if (TOPOS !== null && p > TOPOS) return;
    entries.push([p, id]);
  });
  entries.sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [pos, id] of entries) {
    const b = build(id);
    if (b) { b.position = pos; out.push(b); }
  }
  return JSON.stringify(out);
})()`;
