/**
 * “千万别点”彩蛋模块
 */

import { logInfo, logError } from "../common/logger.js";

/**
 * 随机运行一个彩蛋事件
 */
export function ramdonRun() {
  const randomEvent = events[Math.floor(Math.random() * events.length)];
  logInfo(`运行事件id: ${randomEvent.id}（${randomEvent.name}）`);
  randomEvent.run();
}

/**
 * 指定运行一个彩蛋事件
 * @param {number} eventId 事件id
 */
export function runEvent(eventId) {
  const event = events.find(e => e.id === eventId);
  if (event) {
    logInfo(`指定运行事件id: ${eventId}（${event.name}）`);
    event.run();
  } else {
    logError(`未找到事件id: ${eventId}`);
  }
}

window.test = runEvent;

// 彩蛋事件们-------------------------------------------------------------------------------------------

const events = [
  {
    id: 0,
    name: '《中国人能飞》MV',
    run: () => {
      window.open('https://www.bilibili.com/video/BV1QCgK6YEuM', '_blank');
    }
  },
  {
    id: 1,
    name: '《Never gonna give you up》MV',
    run: () => {
      window.open('https://www.bilibili.com/video/BV1GJ411x7h7', '_blank');
    }
  },
  {
    id: 2,
    name: '颜色反转',
    run: () => {
      document.body.style.filter = 'invert(1)';
    }
  },
  {
    id: 3,
    name: '彩色文字',
    run: () => {
      const style = document.createElement('style');
      style.innerHTML = `
          @keyframes rainbow {
            0% { color: red; }
            20% { color: orange; }
            40% { color: yellow; }
            60% { color: green; }
            80% { color: blue; }
            100% { color: purple; }
          }
          .rainbow-text {
            animation: rainbow 1s infinite;
          }`;
      document.head.appendChild(style);
      document.querySelectorAll('*').forEach(el => el.classList.add('rainbow-text'));
    }  
  },
  {
    id: 4,
    name: '钢管落地音效',
    run: () => {
      const audio = new Audio('./media/sound/钢管落地.mp3');
      audio.volume = 1.0;
      audio.play().catch(e => {
        logError("千万别点：钢管落地：自动播放被阻止（请允许此网站自动播放）：", e);
      });

      if (!audio.paused) {
        audio.remove();
      }
    }  
  },
  {
    id: 5,
    name: '你屏幕有根毛',
    run: () => {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");

      const length = 250 + Math.random() * 150;
      const startX = Math.random() * (window.innerWidth - length * 0.8);
      const startY = Math.random() * (window.innerHeight * 0.8);
      const color = `#201008`;

      // 生成3个随机控制点创建自然曲线
      const points = [];
      for (let i = 0; i < 3; i++) {
        points.push({
          x: i * (length / 2),
          y: (Math.random() - 0.5) * 30
        });
      }

      // 构建二次贝塞尔曲线路径
      const pathData = `M0,0 Q${points[1].x},${points[1].y} ${points[2].x},${points[2].y}`;

      svg.innerHTML = `
        <path 
          d="${pathData}" 
          stroke="${color}" 
          stroke-width="${0.8 + Math.random() * 0.7}" 
          fill="none"
          stroke-linecap="round"
        />
      `;

      svg.setAttribute("style", `
        position: fixed;
        left: ${startX}px;
        top: ${startY}px;
        width: ${length}px;
        height: 40px;
        overflow: visible;
        pointer-events: none;
        z-index: 9999;
        transform: rotate(${Math.random() * 360}deg);
        opacity: ${0.8 + Math.random() * 0.2};
      `);

      document.body.appendChild(svg);  
    }
  },
  {
    id: 6,
    name: '汉字乱码',
    run: () => {
      document.body.innerHTML = document.body.innerHTML.replace(/[\u4e00-\u9fa5]/g, function (c) {
        return String.fromCharCode(c.charCodeAt(0) ^ 0xA5);
      });
    }
  },
  {
    id: 7,
    name: '二进制代码雨',
    run: () => {
      const chars = '01';
      const canvas = document.createElement('canvas');
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      canvas.style.position = 'fixed';
      canvas.style.top = '0';
      canvas.style.left = '0';
      document.body.appendChild(canvas);

      const ctx = canvas.getContext('2d');
      const fontSize = 16;
      const columns = canvas.width / fontSize;
      const drops = [];

      for (let i = 0; i < columns; i++) {
        drops[i] = 1;
      }

      function draw() {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.05)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        ctx.fillStyle = '#0F0';
        ctx.font = `${fontSize}px monospace`;

        for (let i = 0; i < drops.length; i++) {
          const text = chars.charAt(Math.floor(Math.random() * chars.length));
          ctx.fillText(text, i * fontSize, drops[i] * fontSize);

          if (drops[i] * fontSize > canvas.height && Math.random() > 0.975) {
            drops[i] = 0;
          }
          drops[i]++;
        }
      }

      setInterval(draw, 33);
    }
  }
]