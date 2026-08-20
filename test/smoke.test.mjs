import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { classifyPageState, classifyStartupFailure, hasFailedChats, isRetryableChatStatus, shouldUpdateState } from '../cli-utils.mjs';
import { PAGE_HELPERS } from '../export_lib.mjs';

const root = path.resolve(import.meta.dirname, '..');
const cli = path.join(root, 'feishu-cli.mjs');

test('help is available without a browser or cookies', () => {
  const result = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--incremental/);
  assert.match(result.stdout, /--base-url/);
  assert.match(result.stdout, /--chat-id/);
});

test('missing option values fail early', () => {
  const result = spawnSync(process.execPath, [cli, '--cookies'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /需要一个值/);
});

test('invalid dates fail before launching Chrome', () => {
  const result = spawnSync(process.execPath, [cli, '--date', '2026-02-30'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /时间不存在/);
});

test('invalid chat limits fail before launching Chrome', () => {
  const result = spawnSync(process.execPath, [cli, '--limit-chats', '0'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /必须是正整数/);
});

test('missing chat id fails before launching Chrome', () => {
  const result = spawnSync(process.execPath, [cli, '--chat-id'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--chat-id 需要一个值/);
});

test('startup classifier distinguishes login redirects from frontend incompatibility', () => {
  assert.equal(classifyPageState({ url: 'https://tenant.feishu.cn/accounts/page/login' }), 'login');
  assert.equal(classifyPageState({ title: '请重新登录飞书' }), 'login');
  assert.equal(classifyPageState({ url: 'https://tenant.feishu.cn/next/messenger', feedCount: 2 }), 'incompatible');
  assert.equal(classifyPageState({ url: 'https://tenant.feishu.cn/next/messenger', feedCount: 2, feedStore: true, feedWindowStore: true }), 'ready');
});

test('startup classifier distinguishes a fully loaded page with no session list', () => {
  assert.equal(classifyStartupFailure({ readyState: 'loading', feedCount: 0 }), 'loading');
  assert.equal(classifyStartupFailure({ readyState: 'complete', feedCount: 0 }), 'stalled');
  assert.equal(classifyStartupFailure({ readyState: 'complete', feedCount: 2 }), 'incompatible');
});

test('partial chat results are treated as a failed export', () => {
  assert.equal(hasFailedChats([{ status: 'ok' }, { status: 'timeout' }]), true);
  assert.equal(hasFailedChats([{ status: 'ok' }]), false);
  assert.equal(hasFailedChats([]), false);
});

test('only transient chat-open failures are retried', () => {
  assert.equal(isRetryableChatStatus('openfail'), true);
  assert.equal(isRetryableChatStatus('applink'), true);
  assert.equal(isRetryableChatStatus('timeout'), false);
  assert.equal(isRetryableChatStatus('notfound'), false);
});

test('targeted chat diagnostics never advance the global incremental state', () => {
  assert.equal(shouldUpdateState(true, []), true);
  assert.equal(shouldUpdateState(false, []), false);
  assert.equal(shouldUpdateState(true, ['feed-1']), false);
});

test('feed activation targets the real accessible card when a wrapper is not clickable', () => {
  assert.match(PAGE_HELPERS, /a11y_feed_card_item/);
  assert.match(PAGE_HELPERS, /activateFeedById/);
});
