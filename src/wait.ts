// 共享等待策略：exec 默认同步与 status busy 轮询使用同一组 timeout/poll。

/**
 * 等待 busy 变为 false；超时只停止等待，不改变终端/进程。
 * @param isBusy 当前是否 busy
 * @param timeoutMs 最长等待（ms）；0 = 不等待
 * @param pollMs 轮询间隔（ms），最小 1
 * @returns Promise 在 idle 或超时后 resolve
 */
export async function waitForIdle(isBusy: () => boolean, timeoutMs: number, pollMs: number): Promise<void> {
  const deadline = Date.now() + Math.max(0, timeoutMs)
  while (isBusy() && Date.now() < deadline) {
    const remaining = deadline - Date.now()
    const delay = Math.min(Math.max(1, pollMs), remaining)
    await new Promise<void>((resolve) => setTimeout(resolve, delay))
  }
}
