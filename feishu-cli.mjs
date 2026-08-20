#!/usr/bin/env node
// feishu-cli.mjs — 飞书聊天记录按天/增量下载 CLI
//
// 用法示例：
//   node feishu-cli.mjs --today                      # 下载今天(00:00~现在)的消息
//   node feishu-cli.mjs --date 2026-08-14            # 下载某一天
//   node feishu-cli.mjs --since 2026-08-12           # 下载 2026-08-12 00:00 至今
//   node feishu-cli.mjs --since 2026-08-12T14:00     # 从具体时刻起
//   node feishu-cli.mjs --range 2026-08-12 2026-08-14
//   node feishu-cli.mjs --incremental                # 增量：从上次同步点之后的消息
//   node feishu-cli.mjs --date 2026-08-14 --markdown # 额外生成可喂给 AI 的文本
//
// 选项：
//   --out DIR          输出目录（默认 ~/feishu_export/daily）
//   --cookies FILE     cookies JSON 文件（默认用户配置目录中的 cookies.json）
//   --state FILE       状态文件（默认 <out>/.state.json，增量游标存这里）
//   --markdown         额外生成合并 Markdown 文本
//   --no-update-state  本次不更新增量游标
//   --refresh-chats    强制重新扫描会话列表（默认复用缓存）
//   --limit-chats N    只处理前 N 个会话（调试用）
//   --chat-id ID       只处理指定会话（可重复，适合隔离失败会话）
//   --headless         使用无头 Chrome（默认）
//   --no-headless      显示 Chrome 窗口（调试用）
//   --port PORT        Chrome 调试端口（默认随机）
//   --base-url URL     飞书租户地址（也可用 FEISHU_BASE_URL）
//   FEISHU_CHAT_TIMEOUT_MS  单个会话读取预算（默认 45000）
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { connect, PAGE_HELPERS, EXTRACT_FN } from './export_lib.mjs';
import { classifyPageState, classifyStartupFailure, hasFailedChats, isRetryableChatStatus, shouldUpdateState } from './cli-utils.mjs';

// ---------------- 参数解析 ----------------
const args = process.argv.slice(2);
const opt = { out: null, cookies: null, state: null, markdown: false, updateState: true, refreshChats: false, limitChats: null, chatIds: [], port: 0, headless: true };
let mode = null, modeArg = null, rangeArg = null;
const needValue = (flag, index) => {
  const value = args[index + 1];
  if (!value || value.startsWith('-')) {
    console.error(`${flag} 需要一个值`);
    process.exit(1);
  }
  return value;
};
const positiveInt = (flag, value, { allowZero = false } = {}) => {
  const n = Number(value);
  if (!Number.isInteger(n) || (allowZero ? n < 0 : n <= 0)) {
    console.error(`${flag} 必须是${allowZero ? '非负' : '正'}整数:`, value);
    process.exit(1);
  }
  return n;
};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  switch (a) {
    case '--today': mode = 'today'; break;
    case '--date': mode = 'date'; modeArg = needValue(a, i); i++; break;
    case '--since': mode = 'since'; modeArg = needValue(a, i); i++; break;
    case '--to': rangeArg = needValue(a, i); i++; break;
    case '--range': mode = 'range'; modeArg = needValue(a, i); i++; rangeArg = needValue(a, i); i++; break;
    case '--incremental': mode = 'incremental'; break;
    case '--out': opt.out = needValue(a, i); i++; break;
    case '--cookies': opt.cookies = needValue(a, i); i++; break;
    case '--state': opt.state = needValue(a, i); i++; break;
    case '--markdown': opt.markdown = true; break;
    case '--no-update-state': opt.updateState = false; break;
    case '--refresh-chats': opt.refreshChats = true; break;
    case '--limit-chats': opt.limitChats = positiveInt(a, needValue(a, i)); i++; break;
    case '--chat-id': opt.chatIds.push(needValue(a, i)); i++; break;
    case '--port': opt.port = positiveInt(a, needValue(a, i), { allowZero: true }); i++; break;
    case '--headless': opt.headless = true; break;
    case '--no-headless': opt.headless = false; break;
    case '--base-url': opt.baseUrl = needValue(a, i); i++; break;
    case '--help': case '-h': printHelp(); process.exit(0);
    default: if (a.startsWith('-')) { console.error('未知参数:', a); process.exit(1); }
  }
}
if (!mode) mode = 'today';

const HOME = os.homedir();
const CONFIG_DIR = process.env.FEISHU_EXPORT_CONFIG_DIR || (process.platform === 'darwin'
  ? path.join(HOME, 'Library', 'Application Support', 'feishu-export')
  : path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'feishu-export'));
const OUT_DIR = opt.out || path.join(HOME, 'feishu_export', 'daily');
const COOKIES_FILE = opt.cookies || path.join(CONFIG_DIR, 'cookies.json');
const STATE_FILE = opt.state || path.join(OUT_DIR, '.state.json');
const FEISHU_BASE_URL = (opt.baseUrl || process.env.FEISHU_BASE_URL || 'https://feishu.cn').replace(/\/+$/, '');
const configuredChatTimeout = Number(process.env.FEISHU_CHAT_TIMEOUT_MS || 45000);
const CHAT_TIMEOUT_MS = Number.isFinite(configuredChatTimeout) && configuredChatTimeout > 0 ? configuredChatTimeout : 45000;
try {
  const parsedBaseUrl = new URL(FEISHU_BASE_URL);
  if (!/^https?:$/.test(parsedBaseUrl.protocol)) throw new Error('protocol');
} catch {
  console.error('飞书地址无效（应为 http(s) URL）:', FEISHU_BASE_URL);
  process.exit(1);
}
fs.mkdirSync(OUT_DIR, { recursive: true });
const CHROME_CANDIDATES = [
  process.env.FEISHU_CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'
].filter(Boolean);
const CHROME = CHROME_CANDIDATES.find(fs.existsSync) || 'google-chrome';
const TZ = 8 * 3600; // UTC+8

let chromeProc = null;
let chromeUserDataDir = null;
let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  try { chromeProc?.kill(); } catch (e) {}
  try { if (chromeUserDataDir) fs.rmSync(chromeUserDataDir, { recursive: true, force: true, maxRetries: 6, retryDelay: 300 }); } catch (e) {}
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });
// prepare/cron may terminate a timed-out export with SIGTERM; clean the
// temporary Chrome profile there too, otherwise orphaned Chrome processes remain.
process.on('SIGTERM', () => { cleanup(); process.exit(143); });

// ---------------- 时间范围 ----------------
function parseBound(s, isEnd) {
  // s: 'YYYY-MM-DD' 或 'YYYY-MM-DDTHH:MM'
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):?(\d{2})?)?$/);
  if (!m) { console.error('时间格式错误:', s, '（应为 YYYY-MM-DD 或 YYYY-MM-DDTHH:MM）'); process.exit(1); }
  const [, y, mo, d, hh, mi] = m;
  const date = new Date(Date.UTC(+y, +mo - 1, +d, +(hh || 0), +(mi || 0), 0));
  if (date.getUTCFullYear() !== +y || date.getUTCMonth() !== +mo - 1 || date.getUTCDate() !== +d || +(hh || 0) > 23 || +(mi || 0) > 59) {
    console.error('时间不存在或超出范围:', s);
    process.exit(1);
  }
  if (isEnd && !hh) return Math.floor((Date.UTC(+y, +mo - 1, +d, 23, 59, 59) - TZ * 1000) / 1000) + 1;
  return Math.floor((Date.UTC(+y, +mo - 1, +d, +(hh || 0), +(mi || 0), 0) - TZ * 1000) / 1000);
}
const now = () => Math.floor(Date.now() / 1000);
function todayStart() { return Math.floor((Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()) - TZ * 1000) / 1000); }

let T0, T1 = null, rangeLabel;
const state0 = loadState();
if (mode === 'today') { T0 = todayStart(); }
else if (mode === 'date') { T0 = parseBound(modeArg, false); T1 = parseBound(modeArg, true); }
else if (mode === 'since') { T0 = parseBound(modeArg, false); if (rangeArg) T1 = parseBound(rangeArg, true); }
else if (mode === 'range') { T0 = parseBound(modeArg, false); T1 = parseBound(rangeArg, true); }
else if (mode === 'incremental') {
  if (!state0.lastSync) { console.error('状态文件中没有上次同步记录。首次请用 --since 或 --date 指定范围，之后再用 --incremental。'); process.exit(1); }
  T0 = state0.lastSync;
}
if (T1 === null) T1 = now();
if (T0 >= T1 && mode !== 'incremental') { console.error('时间范围为空：起点已晚于终点'); process.exit(1); }
if (mode === 'incremental' && T1 - T0 < 60) { console.log('距上次同步不到 1 分钟，没有新数据可下载。'); process.exit(0); }

const fmt = (t) => new Date(t * 1000 + TZ * 1000).toISOString().replace('T', ' ').slice(0, 16);
rangeLabel = `range_${new Date(T0 * 1000 + TZ * 1000).toISOString().slice(0, 10)}_${new Date(T1 * 1000 + TZ * 1000).toISOString().slice(0, 10)}`;
if (opt.chatIds.length) {
  const targetLabel = opt.chatIds.map(id => String(id).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48)).join('_').slice(0, 120);
  rangeLabel += `_chat_${targetLabel}`;
}
console.log(`下载范围: ${fmt(T0)} ~ ${fmt(T1)} (+08:00)`);
console.log(`输出目录: ${OUT_DIR}`);
if (opt.chatIds.length) console.log('指定会话模式：使用独立诊断文件，且不会推进增量游标。');

// ---------------- 状态文件 ----------------
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return { lastSync: 0, chats: null, perChat: {} }; }
}
let state = state0;

// ---------------- Chrome 启动 ----------------
async function launchChrome() {
  const port = opt.port || 9300 + Math.floor(Math.random() * 500);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-export-'));
  const chromeArgs = [
    ...(opt.headless ? ['--headless=new'] : []), `--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-features=AutomationControlled',
    '--window-size=1440,900', 'about:blank'
  ];
  const proc = spawn(CHROME, chromeArgs, { stdio: 'ignore' });
  proc.once('error', (error) => {
    console.error(`无法启动 Chrome（${CHROME}）：${error.message}`);
  });
  // 等待调试端口就绪
  for (let i = 0; i < 60; i++) {
    try {
      const r = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      if (r.webSocketDebuggerUrl) return { port, proc, userDataDir };
    } catch (e) {}
    await new Promise(r => setTimeout(r, 500));
  }
  proc.kill();
  throw new Error('Chrome 启动超时');
}

async function injectCookies(wsSend) {
  if (!fs.existsSync(COOKIES_FILE)) {
    throw new Error(`找不到 Cookies 文件：${COOKIES_FILE}\n请从浏览器导出 Cookies 后通过 --cookies 指定，或放入用户配置目录。`);
  }
  if (process.platform !== 'win32') {
    const mode = fs.statSync(COOKIES_FILE).mode & 0o777;
    if (mode & 0o077) throw new Error(`Cookies 文件权限过宽（${mode.toString(8)}），请执行 chmod 600 ${COOKIES_FILE}`);
  }
  let raw;
  try { raw = JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf8')); } catch (error) {
    throw new Error(`Cookies 文件不是有效 JSON：${error.message}`);
  }
  if (!Array.isArray(raw) || raw.some(c => !c || typeof c.name !== 'string' || typeof c.value !== 'string' || typeof c.domain !== 'string')) {
    throw new Error('Cookies 文件格式不正确：应为浏览器导出的 Cookie 数组。');
  }
  const cookies = raw.map(c => {
    const p = { name: c.name, value: c.value, domain: c.domain, path: c.path || '/', secure: !!c.secure, httpOnly: !!c.httpOnly };
    if (c.expirationDate) p.expires = Math.floor(c.expirationDate);
    if (c.sameSite === 'no_restriction') p.sameSite = 'None';
    return p;
  });
  await wsSend('Network.setCookies', { cookies });
}

// ---------------- 会话枚举（feed walk） ----------------
async function enumerateChats(evl) {
  if (state.chats && !opt.refreshChats) {
    console.log(`复用缓存的会话列表（${state.chats.length} 个，--refresh-chats 强制重扫）`);
    return filterDocumentPreviews(evl, state.chats);
  }
  console.log('扫描会话列表...');
  // 等待 feed 渲染出来（首启冷启动可能较慢）
  for (let i = 0; i < 40; i++) {
    const n = await evl(`document.querySelectorAll('[data-feed-id]').length`);
    if (Number(n) > 0) break;
    if (i % 5 === 0) console.log('  等待消息页加载...');
    await sleep(1000);
  }
  await sleep(2500); // 让应用完成初始化（滚动分页才会生效）
  const collect = async () => JSON.parse(await evl(`(() => JSON.stringify(Array.from(document.querySelectorAll('[data-feed-id]')).map(el => ({ id: el.getAttribute('data-feed-id'), title: (el.querySelector('._2b17aec6') || {}).innerText || '' }))))()`));
  const seen = new Map();
  const addAll = (items) => { let grew = false; for (const it of items) if (!seen.has(it.id)) { seen.set(it.id, it.title); grew = true; } return grew; };

  // 阶段1：向下滚动收集
  let stable = 0;
  for (let i = 0; i < 150; i++) {
    if (addAll(await collect())) stable = 0; else stable++;
    if (stable >= 8) {
      // 确认是否真的到了底部：直接跳到底，等一会再看有没有新项
      await evl(`(() => { const sc = document.querySelector('.lark_feedMainList'); if (sc) sc.scrollTop = sc.scrollHeight; return 'ok'; })()`);
      await sleep(1500);
      if (addAll(await collect())) { stable = 0; continue; }
      break;
    }
    await evl('window.__EXPORT_HELPERS.scrollFeed(500)');
    await sleep(650);
  }
  // 阶段2：滚回顶部再收集一遍（防漏）
  await evl(`(() => { const sc = document.querySelector('.lark_feedMainList'); if (sc) sc.scrollTop = sc.scrollHeight; return 'ok'; })()`);
  await sleep(1200);
  addAll(await collect());
  for (let i = 0; i < 150; i++) {
    await evl(`(() => { const sc = document.querySelector('.lark_feedMainList'); if (sc) sc.scrollTop -= 500; return 'ok'; })()`);
    await sleep(300);
    if (!addAll(await collect())) {
      const top = await evl(`(() => { const sc = document.querySelector('.lark_feedMainList'); return sc ? String(sc.scrollTop) : '0'; })()`);
      if (Number(top) <= 0) break;
    }
  }
  await evl(`(() => { const sc = document.querySelector('.lark_feedMainList'); if (sc) sc.scrollTop = 0; return 'ok'; })()`);
  await sleep(600);
  // 补充 previews 的 updateTime（用于跳过无更新的会话）
  const previewsRaw = await evl(`(() => {
    const st = window.__feedStore.getState();
    const p = st.previews;
    const out = {};
    if (!p) return JSON.stringify(out);
    const keys = p.keySeq ? p.keySeq().toArray() : Object.keys(p);
    for (const k of keys) { const v = p.get ? p.get(k) : p[k]; if (v && v.updateTime) out[k] = v.updateTime; }
    return JSON.stringify(out);
  })()`);
  const previews = JSON.parse(previewsRaw);
  const chats = [];
  for (const [id, title] of seen) chats.push({ id, title, updateTime: previews[id] || 0 });
  const filteredChats = await filterDocumentPreviews(evl, chats);
  state.chats = filteredChats;
  saveState();
  console.log(`发现 ${filteredChats.length} 个会话`);
  return filteredChats;
}

// The feed mixes real chats with document-comment/preview notifications. The
// latter have a DOM row and feed id but deliberately do not enter chatMap, so
// opening them can never succeed through the chat reader.
async function filterDocumentPreviews(evl, chats) {
  let ids = [];
  try {
    const raw = await evl(`(() => {
      const p = window.__feedStore?.getState?.().previews;
      if (!p) return '[]';
      const keys = p.keySeq ? p.keySeq().toArray() : Object.keys(p);
      const out = [];
      for (const key of keys) {
        const value = p.get ? p.get(key) : p[key];
        if (value && value.isPreview && value.docUrl) out.push(String(key));
      }
      return JSON.stringify(out);
    })()`);
    ids = JSON.parse(raw);
  } catch (error) {
    // If the optional metadata probe fails, keep the normal chat path intact;
    // the existing open failure handling remains the safe fallback.
    return chats;
  }
  const documentIds = new Set(ids);
  const filtered = chats.filter((chat) => !documentIds.has(String(chat.id)));
  if (filtered.length !== chats.length) {
    const skipped = chats.filter((chat) => documentIds.has(String(chat.id)));
    console.log(`跳过 ${skipped.length} 个文档评论/预览通知（非聊天）: ${skipped.slice(0, 5).map((chat) => chat.title || chat.id).join(', ')}${skipped.length > 5 ? '...' : ''}`);
    if (state.chats && state.chats.length !== filtered.length) {
      state.chats = filtered;
      saveState();
    }
  }
  return filtered;
}

// ---------------- 会话处理 ----------------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
class ChatTimeoutError extends Error {
  constructor(chat, timeoutMs) {
    super(`会话读取超过 ${timeoutMs}ms: ${chat || '未知会话'}`);
    this.name = 'ChatTimeoutError';
  }
}
function ensureChatBudget(deadline, chat) {
  if (Date.now() >= deadline) throw new ChatTimeoutError(chat, CHAT_TIMEOUT_MS);
}
async function chatSleep(ms, deadline, chat) {
  ensureChatBudget(deadline, chat);
  await sleep(Math.min(ms, Math.max(1, deadline - Date.now())));
  ensureChatBudget(deadline, chat);
}
async function closeApplinkTabs(port) {
  try {
    const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const bws = new WebSocket(ver.webSocketDebuggerUrl);
    let bid = 0; const bp = new Map();
    const bsend = (method, params = {}) => new Promise((res, rej) => { const mid = ++bid; bp.set(mid, { res, rej }); bws.send(JSON.stringify({ id: mid, method, params })); });
    bws.onmessage = (ev) => { const msg = JSON.parse(ev.data); if (msg.id && bp.has(msg.id)) { const { res, rej } = bp.get(msg.id); bp.delete(msg.id); msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result); } };
    await new Promise((res, rej) => { bws.onopen = res; bws.onerror = rej; });
    const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    let n = 0;
    for (const t of list) if (t.type === 'page' && t.url.includes('applink')) { await bsend('Target.closeTarget', { targetId: t.id }); n++; }
    bws.close();
    return n;
  } catch (e) { return 0; }
}

async function clickAt(send, pos, deadline, chat) {
  ensureChatBudget(deadline, chat);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y, pointerType: 'mouse', modifiers: 0, buttons: 0 });
  await chatSleep(120, deadline, chat);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, pointerType: 'mouse', modifiers: 0, button: 'left', buttons: 1, clickCount: 1 });
  await chatSleep(90, deadline, chat);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, pointerType: 'mouse', modifiers: 0, button: 'left', buttons: 0, clickCount: 1 });
}

async function openChat(send, evl, port, feedId, deadline, chatTitle) {
  ensureChatBudget(deadline, chatTitle);
  await evl(`(() => { const sc = document.querySelector('.lark_feedMainList'); if (sc) sc.scrollTop = 0; return 'ok'; })()`);
  await chatSleep(500, deadline, chatTitle);
  let posStr = await evl(`(() => {
    const el = document.querySelector('[data-feed-id="${feedId}"]');
    if (!el) return 'missing';
    el.scrollIntoView({ block: 'center' });
    const target = el.querySelector('.a11y_feed_card_item') || el;
    const r = target.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
  })()`);
  if (posStr === 'missing') {
    for (let i = 0; i < 100; i++) {
      ensureChatBudget(deadline, chatTitle);
      await evl('window.__EXPORT_HELPERS.scrollFeed(600)');
      await chatSleep(300, deadline, chatTitle);
      posStr = await evl(`(() => {
        const el = document.querySelector('[data-feed-id="${feedId}"]');
        if (!el) return 'missing';
        el.scrollIntoView({ block: 'center' });
        const target = el.querySelector('.a11y_feed_card_item') || el;
        const r = target.getBoundingClientRect();
        return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
      })()`);
      if (posStr !== 'missing') break;
    }
  }
  if (posStr === 'missing') return 'notfound';
  await clickAt(send, JSON.parse(posStr), deadline, chatTitle);
  for (let i = 0; i < 26; i++) {
    await chatSleep(500, deadline, chatTitle);
    const cur = await evl('window.__EXPORT_HELPERS.currentChat()');
    if (cur === feedId) break;
    if (i === 13) {
      // Some feed rows keep an overlay or stale virtual-list position after the
      // first trusted pointer click. Re-find the live row, invoke its normal DOM
      // click handler, then send one fresh trusted click at the new coordinates.
      posStr = await evl(`window.__EXPORT_HELPERS.activateFeedById(${JSON.stringify(feedId)})`);
      if (posStr !== 'missing') await clickAt(send, JSON.parse(posStr), deadline, chatTitle);
    }
  }
  const cur = await evl('window.__EXPORT_HELPERS.currentChat()');
  if (cur !== feedId) {
    const closed = await closeApplinkTabs(port);
    if (closed > 0) return 'applink';
    console.log(`    ${chatTitle || feedId}: 页面未切换到目标会话（当前会话键 ${cur || 'none'}）`);
    return 'openfail';
  }
  await chatSleep(3000, deadline, chatTitle);
  const btn = await evl('window.__EXPORT_HELPERS.clickToNewest()');
  if (btn && btn !== 'none') {
    await clickAt(send, JSON.parse(btn), deadline, chatTitle);
    await chatSleep(2200, deadline, chatTitle);
  }
  return 'ok';
}

// 加载窗口直到覆盖 T0（窗口最早消息时间 <= T0 或已到顶）
async function loadToT0(evl, feedId, T0, deadline, chatTitle) {
  let prevStart = -1, stall = 0;
  for (let i = 0; i < 1200; i++) {
    ensureChatBudget(deadline, chatTitle);
    await evl('window.__EXPORT_HELPERS.msgToTop()');
    if (stall >= 3) {
      await evl(`(() => { const sc = document.querySelector('.chatMessageContainer .scroller'); if (sc) sc.scrollTop = 120; return 'ok'; })()`);
      await chatSleep(120, deadline, chatTitle);
      await evl('window.__EXPORT_HELPERS.msgToTop()');
    }
    await chatSleep(700, deadline, chatTitle);
    let st;
    try { st = JSON.parse(await evl('window.__EXPORT_HELPERS.loadState()')); } catch (e) { break; }
    if (st.startTime && st.startTime <= T0) return st; // 窗口已覆盖范围起点
    if (st.start <= 0 && i > 0) return st;            // 已到最老
    if (st.start === prevStart) stall++; else stall = 0;
    if (stall >= 30) return st;
    prevStart = st.start;
  }
  return null;
}

// 渲染扫掠（补水图片/文件内容 + 收集媒体链接），有界
async function renderSweep(evl, deadline, chatTitle) {
  try {
    ensureChatBudget(deadline, chatTitle);
    await evl('window.__MEDIA = {}');
    await evl('window.__EXPORT_HELPERS.msgToBottom()');
    await chatSleep(1200, deadline, chatTitle);
    for (let i = 0; i < 600; i++) {
      ensureChatBudget(deadline, chatTitle);
      const infoStr = await evl('window.__EXPORT_HELPERS.msgScrollInfo()');
      if (infoStr === 'none') break;
      const info = JSON.parse(infoStr);
      if (info.top <= 0) break;
      await evl('window.__EXPORT_HELPERS.msgScrollBy(-500)');
      await evl('window.__EXPORT_HELPERS.collectMedia()');
      await chatSleep(50, deadline, chatTitle);
    }
  } catch (e) {
    if (e instanceof ChatTimeoutError) throw e;
  }
}

async function extractMessages(evl, T0, T1, deadline, chatTitle) {
  const posList = JSON.parse(await evl(`(() => {
    const st = window.__FEED_WIN_STORE.getState();
    const cm = st.get('chatMap');
    const k = cm.keySeq().first();
    const m = cm.get(k).__messages__;
    const arr = [];
    m.messagePos2Id.forEach((id, pos) => arr.push(Number(pos)));
    arr.sort((a, b) => a - b);
    return JSON.stringify(arr);
  })()`));
  const messages = [];
  const CHUNK = 600;
  for (let off = 0; off < posList.length; off += CHUNK) {
    ensureChatBudget(deadline, chatTitle);
    const slice = posList.slice(off, off + CHUNK);
    const chunkJson = await evl(EXTRACT_FN(T0, T1, slice[0], slice[slice.length - 1]));
    messages.push(...JSON.parse(chunkJson));
  }
  messages.sort((a, b) => a.createTime - b.createTime || a.position - b.position);
  return messages;
}

async function processChat(send, evl, port, chat, T0, T1) {
  const deadline = Date.now() + CHAT_TIMEOUT_MS;
  try {
    const r = await openChat(send, evl, port, chat.id, deadline, chat.title);
    if (r !== 'ok') return { chat, status: r, messages: [] };
    await loadToT0(evl, chat.id, T0, deadline, chat.title);
    await renderSweep(evl, deadline, chat.title);
    let messages = await extractMessages(evl, T0, T1, deadline, chat.title);
    // 增量游标去重：(createTime, position) <= cursor 的已下载过
    const cur = (state.perChat || {})[chat.id];
    if (cur && mode === 'incremental') {
      messages = messages.filter(m => m.createTime > cur.maxTime || (m.createTime === cur.maxTime && m.position > cur.maxPos));
    }
    const meta = JSON.parse(await evl('window.__EXPORT_HELPERS.chatMeta()'));
    return { chat, status: 'ok', messages, meta };
  } catch (e) {
    if (e instanceof ChatTimeoutError) return { chat, status: 'timeout', messages: [] };
    throw e;
  }
}

async function processChatWithRetry(send, evl, port, chat, T0, T1) {
  let result = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    result = await processChat(send, evl, port, chat, T0, T1);
    if (!isRetryableChatStatus(result.status) || attempt === 2) return result;
    console.log(`  ${chat.title || chat.id}: ${result.status}，准备重试 (${attempt}/1)`);
    await sleep(1000);
  }
  return result;
}

// ---------------- 输出 ----------------
function buildMarkdown(chatResults) {
  const L = [];
  L.push('# 飞书聊天记录汇总', '', `> 时间范围: ${fmt(T0)} ~ ${fmt(T1)} (+08:00)`, '');
  for (const r of chatResults) {
    if (!r.messages.length) continue;
    const name = (r.meta && r.meta.name) || r.chat.title || r.chat.id;
    L.push(`## ${name}（${r.messages.length} 条）`, '');
    let curDay = '';
    for (const m of r.messages) {
      const d = new Date(m.createTime * 1000 + TZ * 1000);
      const iso = d.toISOString(); // 加 8 小时后的 UTC 即 +08 本地时间
      const day = iso.slice(0, 10);
      if (day !== curDay) { L.push(`### ${day}`, ''); curDay = day; }
      const hm = iso.slice(11, 16);
      let body = m.text;
      if (!body) {
        if (m.imageUrl) body = `[图片](${m.imageUrl})`;
        else if (m.fileKey) body = `[文件${m.fileName ? '：' + m.fileName : ''}]`;
        else if (m.media && m.media.link) body = `[链接](${m.media.link})`;
        else if (m.systemText) body = m.systemText;
        else if (m.isRecalled) body = '（已撤回）';
        else body = '（消息）';
      }
      L.push(`- **${m.fromName || '未知'}** (${hm}): ${body}`);
    }
    L.push('');
  }
  return L.join('\n');
}

// ---------------- 主流程 ----------------
const { port, proc, userDataDir } = await launchChrome();
chromeProc = proc;
chromeUserDataDir = userDataDir;
const { send, evl } = await connect(port);
await send('Network.enable');
await send('Page.enable');
await send('Runtime.enable');
await injectCookies(send);
await send('Page.navigate', { url: `${FEISHU_BASE_URL}/next/messenger` });
// 等待 messenger 应用就绪。飞书前端改版后可能仍能渲染会话列表，
// 但不再暴露本导出器依赖的两个内部 store；这种情况应快速、明确失败，
// 不要误报为登录失效并白等完整 90 秒。
let ready = false;
let incompatibleRuntime = false;
let loginRequired = false;
let feedVisibleAt = 0;
let lastPageState = {};
for (let i = 0; i < 90; i++) {
  await sleep(1000);
  const r = await evl(`(() => {
    try {
      return JSON.stringify({
        url: location.href,
        title: document.title,
        readyState: document.readyState,
        feedCount: document.querySelectorAll('[data-feed-id]').length,
        feedStore: !!window.__feedStore,
        feedWindowStore: !!window.__FEED_WIN_STORE,
      });
    } catch (e) { return JSON.stringify({ feedCount: 0, feedStore: false, feedWindowStore: false }); }
  })()`);
  let state;
  try { state = JSON.parse(r); } catch (e) { state = { feedCount: 0, feedStore: false, feedWindowStore: false }; }
  lastPageState = state;
  const pageState = classifyPageState(state);
  if (pageState === 'login') { loginRequired = true; break; }
  if (state.feedCount > 0 && !feedVisibleAt) feedVisibleAt = Date.now();
  if (pageState === 'ready') { ready = true; break; }
  if (pageState === 'incompatible' && feedVisibleAt && Date.now() - feedVisibleAt >= 10000) { incompatibleRuntime = true; break; }
  if (i === 30 || i === 60) console.log('  等待飞书加载 (' + (i + 1) + 's)...');
}
if (!ready) {
  if (loginRequired) {
    console.error('飞书登录页已出现，登录态可能已过期；请重新导出浏览器 Cookies 到 ' + COOKIES_FILE);
  } else if (incompatibleRuntime) {
    console.error('飞书页面已加载，但当前前端未提供导出器所需的数据接口（__feedStore / __FEED_WIN_STORE）。请升级 feishu_export 导出器，或检查飞书前端是否改版。');
  } else if (classifyStartupFailure(lastPageState) === 'stalled') {
    console.error('飞书页面已完成加载，但会话列表没有出现；这通常是登录态未被浏览器接受、租户页面未完成初始化，或前端资源被拦截。请先重新导出 Cookies，再用 --no-headless 观察页面；若仍复现，再检查飞书租户/前端是否改版。');
  } else {
    console.error('飞书在 90 秒内未完成初始化（可能是网络/页面资源加载缓慢，也可能是登录态已过期）。请先稍后重试；若连续出现，再重新导出 Cookies 到 ' + COOKIES_FILE + '，或用 --no-headless 查看页面。');
  }
  try { proc.kill(); } catch (e) {}
  process.exit(1);
}
await evl(PAGE_HELPERS);

const chats = await enumerateChats(evl);
let candidates = chats;
if (opt.chatIds.length) {
  const requested = new Set(opt.chatIds);
  candidates = chats.filter(chat => requested.has(String(chat.id)));
  const found = new Set(candidates.map(chat => String(chat.id)));
  const missing = [...requested].filter(id => !found.has(String(id)));
  if (missing.length) {
    console.error(`找不到指定会话 ID: ${missing.join(', ')}；请用最近一次诊断 JSON 的 failedChats[].id 重试。`);
    process.exit(1);
  }
  console.log(`仅处理指定会话：${candidates.map(chat => chat.title || chat.id).join(', ')}`);
}
if (opt.limitChats) candidates = candidates.slice(0, opt.limitChats);
// 增量/范围模式：跳过最后活跃时间早于 T0 的会话（previews 有 updateTime 时）
const skipped = [];
candidates = candidates.filter(c => {
  if (opt.chatIds.length) return true;
  if (c.updateTime && c.updateTime < T0 * 1000) { skipped.push(c.title || c.id); return false; }
  return true;
});
if (skipped.length) console.log(`跳过 ${skipped.length} 个无更新的会话: ${skipped.slice(0, 8).join(', ')}${skipped.length > 8 ? '...' : ''}`);

const chatResults = [];
const MAX_CONSECUTIVE_OPEN_FAILURES = 3;
let consecutiveOpenFailures = 0;
let processed = 0;
for (const chat of candidates) {
  processed++;
  const startedAt = Date.now();
  const title = chat.title || chat.id;
  console.log(`  [${processed}/${candidates.length}] ${title}: 开始读取（单会话预算 ${Math.round(CHAT_TIMEOUT_MS / 1000)}s）`);
  try {
    const r = await processChatWithRetry(send, evl, port, chat, T0, T1);
    r.durationMs = Date.now() - startedAt;
    chatResults.push(r);
    const n = r.messages.length;
    const duration = `${(r.durationMs / 1000).toFixed(1)}s`;
    if (r.status === 'ok') consecutiveOpenFailures = 0;
    else consecutiveOpenFailures++;
    if (n) console.log(`  [${processed}/${candidates.length}] ${(r.meta && r.meta.name) || title}: ${n} 条（${duration}）`);
    else if (r.status !== 'ok') console.log(`  [${processed}/${candidates.length}] ${title}: 跳过(${r.status}，${duration})`);
    else console.log(`  [${processed}/${candidates.length}] ${title}: 无新增消息（${duration}）`);
    if (consecutiveOpenFailures >= MAX_CONSECUTIVE_OPEN_FAILURES) {
      console.error(`连续 ${MAX_CONSECUTIVE_OPEN_FAILURES} 个会话无法打开（${chatResults.slice(-MAX_CONSECUTIVE_OPEN_FAILURES).map(x => `${x.chat.title || x.chat.id}:${x.status}`).join(', ')}），停止本次导出；请检查飞书页面状态或导出器兼容性。`);
      try { proc.kill(); } catch (e) {}
      try { fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 6, retryDelay: 300 }); } catch (e) {}
      process.exit(2);
    }
  } catch (e) {
    const durationMs = Date.now() - startedAt;
    console.log(`  [${processed}/${candidates.length}] ${title}: 出错 ${e.message}（${(durationMs / 1000).toFixed(1)}s）`);
    chatResults.push({ chat, status: 'error: ' + e.message, messages: [], durationMs });
    consecutiveOpenFailures++;
    if (consecutiveOpenFailures >= MAX_CONSECUTIVE_OPEN_FAILURES) {
      console.error(`连续 ${MAX_CONSECUTIVE_OPEN_FAILURES} 个会话处理失败，停止本次导出；请检查飞书页面状态或导出器兼容性。`);
      try { proc.kill(); } catch (e) {}
      try { fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 6, retryDelay: 300 }); } catch (e) {}
      process.exit(2);
    }
  }
}

// 汇总输出
const withMsgs = chatResults.filter(r => r.messages.length);
const total = withMsgs.reduce((s, r) => s + r.messages.length, 0);
const failedChats = chatResults.filter(r => r.status !== 'ok');
const outJson = {
  exportedAt: new Date().toISOString(),
  range: { from: fmt(T0), to: fmt(T1), tz: '+08:00', fromUnix: T0, toUnix: T1 },
  totalMessages: total,
  chats: Object.fromEntries(withMsgs.map(r => [(r.meta && r.meta.chat) || r.chat.id, { meta: r.meta, messages: r.messages }])),
  skippedChats: skipped,
  failedChats: failedChats.map(r => ({ id: r.chat.id, title: r.chat.title || r.chat.id, status: r.status, durationMs: r.durationMs || null }))
};
const jsonPath = path.join(OUT_DIR, rangeLabel + '.json');
fs.writeFileSync(jsonPath, JSON.stringify(outJson));
console.log(`\n完成：${withMsgs.length} 个会话、${total} 条消息 → ${jsonPath}`);
if (opt.markdown) {
  const mdPath = path.join(OUT_DIR, rangeLabel + '.md');
  fs.writeFileSync(mdPath, buildMarkdown(chatResults));
  console.log(`Markdown 汇总 → ${mdPath}`);
}

// Keep the diagnostic files for inspection, but fail the command when any
// selected chat was not read completely. Callers (including Workboard) must
// never mistake a partial export for a complete source or advance the cursor.
if (hasFailedChats(chatResults)) {
  console.error(`本次导出未完成：${failedChats.length} 个会话读取失败；输出仅供诊断，状态游标未更新。`);
  try { proc.kill(); } catch (e) {}
  try { fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 6, retryDelay: 300 }); } catch (e) {}
  process.exit(2);
}

// 更新状态（增量游标）
const updateState = shouldUpdateState(opt.updateState, opt.chatIds);
if (updateState && withMsgs.length) {
  const maxByChat = {};
  let globalMax = state.lastSync || 0;
  for (const r of withMsgs) {
    const cid = (r.meta && r.meta.chat) || r.chat.id;
    let mx = { maxTime: 0, maxPos: 0 };
    for (const m of r.messages) {
      if (m.createTime > mx.maxTime || (m.createTime === mx.maxTime && m.position > mx.maxPos)) mx = { maxTime: m.createTime, maxPos: m.position };
      if (m.createTime > globalMax) globalMax = m.createTime;
    }
    if (mx.maxTime) maxByChat[cid] = mx;
  }
  if (globalMax > 0) {
    state.perChat = Object.assign({}, state.perChat, maxByChat);
    state.lastSync = Math.max(globalMax, state.lastSync || 0);
    saveState();
    console.log(`状态已更新：lastSync=${fmt(state.lastSync)}（下次 --incremental 将从这里继续）`);
  }
} else if (updateState) {
  console.log('本次没有新消息，状态游标保持不变。');
}

function saveState() {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
}

// 清理
try { proc.kill(); } catch (e) {}
try { fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 6, retryDelay: 300 }); } catch (e) {}
process.exit(0);

function printHelp() {
  console.log(`飞书聊天记录下载 CLI

用法:
  node feishu-cli.mjs --today
  node feishu-cli.mjs --date 2026-08-14
  node feishu-cli.mjs --since 2026-08-12
  node feishu-cli.mjs --since 2026-08-12T14:00
  node feishu-cli.mjs --range 2026-08-12 2026-08-14
  node feishu-cli.mjs --incremental

选项:
  --today              今天 00:00 至今（默认）
  --date YYYY-MM-DD    某一天
  --since 时间          从某时间点至今（增量起点）
  --to 时间             配合 --since 使用；默认至今
  --range A B          时间段
  --incremental        从上次同步点增量下载（读状态文件）
  --markdown           额外生成合并 Markdown 文本（适合直接发给 AI）
  --out DIR            输出目录（默认 ~/feishu_export/daily）
  --cookies FILE       cookies JSON 文件（默认用户配置目录中的 cookies.json）
  --state FILE         状态文件（默认 <out>/.state.json）
  --no-update-state    本次不更新增量游标
  --refresh-chats      强制重扫会话列表
  --limit-chats N      只处理前 N 个会话（调试用）
  --chat-id ID         只处理指定会话；可重复（用 failedChats[].id 隔离重试）
  --headless           使用无头 Chrome（默认）
  --no-headless        显示 Chrome 窗口（调试用）
  --port PORT          Chrome 调试端口（默认随机）
  --base-url URL       飞书租户地址（也可用 FEISHU_BASE_URL）
  --help               帮助`);
}
