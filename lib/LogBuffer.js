/**
 * 日志缓冲区
 * 固定间隔批量写入,进程退出前强制刷新
 */

const fs = require('fs');
const path = require('path');

class LogBuffer {
  constructor(filePath, intervalMs = 1000, maxBuffer = 100) {
    this.filePath = filePath;
    this.intervalMs = intervalMs;
    this.maxBuffer = maxBuffer;
    this.buffer = [];
    this.timer = null;

    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this.start();

    process.on('exit', () => this.flush());
    process.on('SIGINT', () => {
      this.flush();
      process.exit(0);
    });
    process.on('SIGTERM', () => {
      this.flush();
      process.exit(0);
    });
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.flush(), this.intervalMs);
  }

  log(line) {
    this.buffer.push(line);
    if (this.buffer.length >= this.maxBuffer) {
      this.flush();
    }
  }

  flush() {
    if (this.buffer.length === 0) return;
    const data = this.buffer.join('');
    this.buffer = [];
    try {
      fs.appendFileSync(this.filePath, data);
    } catch (err) {
      // 写入失败时保留回缓冲区稍后重试
      this.buffer.unshift(data);
      if (this.buffer.length > this.maxBuffer * 2) {
        this.buffer = this.buffer.slice(-this.maxBuffer * 2);
      }
    }
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.flush();
  }
}

module.exports = LogBuffer;
