/**
 * “千万别点”彩蛋模块
 */

import { logInfo } from "../common/logger.js";

/**
 * 随机运行一个彩蛋事件
 */
export function ramdonRun() {
  const randomEvent = events[Math.floor(Math.random() * events.length)];
  logInfo(`运行事件id: ${randomEvent.id}`);
  randomEvent.run();
}

/**
 * 指定运行一个彩蛋事件
 * @param {number} eventId 事件id
 */
export function runEvent(eventId) {
  const event = events.find(e => e.id === eventId);
  if (event) {
    logInfo(`运行事件id: ${eventId}`);
    event.run();
  } else {
    logError(`未找到事件id: ${eventId}`);
  }
}

// 彩蛋事件们-------------------------------------------------------------------------------------------

const events = [
  {
    id: 0,
    run: () => {
      // 打开《中国人能飞》MV
      window.open('https://www.bilibili.com/video/BV1QCgK6YEuM', '_blank');
    }
  }
]