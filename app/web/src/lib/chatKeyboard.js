// 中文输入法用 Enter 确认候选词；Safari 在部分输入法事件中通过 229 标识组合输入。
export function shouldSendOnEnter(event) {
  const nativeEvent = event.nativeEvent || event;
  return event.key === 'Enter'
    && !event.shiftKey
    && !event.isComposing
    && !nativeEvent.isComposing
    && event.keyCode !== 229
    && nativeEvent.keyCode !== 229;
}
