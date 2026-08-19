import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { classifyPageState } from '../cli-utils.mjs';

const root = path.resolve(import.meta.dirname, '..');
const cli = path.join(root, 'feishu-cli.mjs');

test('help is available without a browser or cookies', () => {
  const result = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--incremental/);
  assert.match(result.stdout, /--base-url/);
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

test('startup classifier distinguishes login redirects from frontend incompatibility', () => {
  assert.equal(classifyPageState({ url: 'https://tenant.feishu.cn/accounts/page/login' }), 'login');
  assert.equal(classifyPageState({ title: '请重新登录飞书' }), 'login');
  assert.equal(classifyPageState({ url: 'https://tenant.feishu.cn/next/messenger', feedCount: 2 }), 'incompatible');
  assert.equal(classifyPageState({ url: 'https://tenant.feishu.cn/next/messenger', feedCount: 2, feedStore: true, feedWindowStore: true }), 'ready');
});
