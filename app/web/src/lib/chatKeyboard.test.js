import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldSendOnEnter } from './chatKeyboard.js';

test('Enter 发送，Shift+Enter 和其他按键保持编辑', () => {
  assert.equal(shouldSendOnEnter({ key: 'Enter' }), true);
  assert.equal(shouldSendOnEnter({ key: 'Enter', shiftKey: true }), false);
  assert.equal(shouldSendOnEnter({ key: 'a' }), false);
});

test('中文输入法确认候选词不会发送，包括 React 包装事件', () => {
  assert.equal(shouldSendOnEnter({ key: 'Enter', isComposing: true }), false);
  assert.equal(shouldSendOnEnter({ key: 'Enter', nativeEvent: { isComposing: true } }), false);
});

test('Safari 的 229 事件不发送，组合输入结束后恢复 Enter 发送', () => {
  assert.equal(shouldSendOnEnter({ key: 'Enter', keyCode: 229 }), false);
  assert.equal(shouldSendOnEnter({ key: 'Enter', nativeEvent: { keyCode: 229 } }), false);
  assert.equal(shouldSendOnEnter({ key: 'Enter', nativeEvent: { keyCode: 13, isComposing: false } }), true);
});
