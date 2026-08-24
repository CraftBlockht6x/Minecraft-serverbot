#!/usr/bin/env node
/**
 * Session.js - mcbot attach <name> 的交互会话
 */

const readline = require('readline');
const { DaemonClient } = require('./IPC');
const Storage = require('./Storage');

class Session {
  constructor(name, botDir, baseDir) {
    this.name = name;
    this.botDir = botDir;
    this.baseDir = baseDir;
    this.storage = new Storage(baseDir);
    this.client = new DaemonClient(botDir);
    this.rl = null;
    this.memoryLimit = 512;
  }

  printHeader() {
    console.log(`已连接到 ${this.name} (内存: ${this.getMemoryText()})`);
    console.log('输入 .help 查看命令，.exit 或 Ctrl+D 退出');
    console.log('------------------- 显示窗口 -------------------');
  }

  getMemoryText() {
    const state = this.storage.readJson(`${this.botDir}/state.json`) || {};
    const rss = state.memoryUsage ? Math.round(state.memoryUsage.rss / 1024 / 1024) : 0;
    const limit = state.memoryLimit || this.memoryLimit;
    return `${rss}MB/${limit}MB`;
  }

  printPrompt() {
    this.rl.setPrompt(`[${this.name}] 输入: `);
    this.rl.prompt();
  }

  async start() {
    await this.client.connect();
    this.printHeader();

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: `[${this.name}] 输入: `,
    });

    this.client.onMessage = (type, data) => {
      if (type === 'log') {
        // 清掉当前行,输出日志,再重新打印输入提示
        process.stdout.clearLine(0);
        process.stdout.cursorTo(0);
        console.log(data);
        this.printPrompt();
      } else if (type === 'status') {
        this.memoryLimit = data.memoryLimit || this.memoryLimit;
      }
    };

    this.rl.on('line', (line) => {
      const input = line.trim();
      if (!input) {
        this.printPrompt();
        return;
      }
      this.handleInput(input);
    });

    this.rl.on('close', () => {
      console.log('\n断开连接...');
      console.log('------------------- 输入命令 -------------------');
      this.client.close();
      process.exit(0);
    });

    this.printPrompt();
  }

  handleInput(input) {
    // 本地交互命令
    if (input.startsWith('.')) {
      this.handleLocalCommand(input);
      return;
    }
    // 游戏斜杠命令
    if (input.startsWith('/')) {
      this.client.send({ type: 'gameCommand', data: input }).catch((err) => {
        console.log(`[错误] ${err.message}`);
        this.printPrompt();
      });
      return;
    }
    // 普通聊天
    this.client.send({ type: 'chat', data: input }).catch((err) => {
      console.log(`[错误] ${err.message}`);
      this.printPrompt();
    });
  }

  handleLocalCommand(input) {
    const parts = input.slice(1).trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const arg = parts.slice(1).join(' ');

    switch (cmd) {
      case 'help':
        console.log(`本地命令:
  .help                显示帮助
  .status              显示假人状态
  .reconnect           手动重连
  .clear               清空 AI 上下文
  .prompt <文本>       修改系统提示词(同时清空上下文)
  .log [N]             查看最近 N 条日志(默认 10)
  .exit / .quit        退出交互(假人继续运行)`);
        break;
      case 'status': {
        const state = this.storage.readJson(`${this.botDir}/state.json`) || {};
        const uptime = state.startedAt ? this.formatDuration(Date.now() - state.startedAt) : '未知';
        console.log(`姓名: ${state.name || this.name}`);
        console.log(`状态: ${state.status === 'online' ? '在线' : '离线'}`);
        console.log(`运行时间: ${uptime}`);
        console.log(`内存: ${this.getMemoryText()}`);
        console.log(`重连次数: ${state.reconnectCount || 0}`);
        console.log(`AI对话: ${this.storage.readFile(`${this.botDir}/.env`).includes('DEEPSEEK_API_KEY') ? '已启用' : '未启用'}`);
        break;
      }
      case 'reconnect':
        this.client.send({ type: 'restart' }).catch(() => {});
        console.log('[系统] 重连指令已发送');
        break;
      case 'clear':
        this.client.send({ type: 'clearContext' }).catch(() => {});
        console.log('[系统] 已发送清空上下文指令');
        break;
      case 'prompt':
        if (!arg) {
          console.log('用法: .prompt <新的系统提示词>');
        } else {
          // 通过修改配置文件并重启生效
          console.log('[系统] 提示词修改需重启后生效,请先 .exit,再执行 mcbot restart');
        }
        break;
      case 'log': {
        const lines = parseInt(arg, 10) || 10;
        const file = `${this.botDir}/chat.log`;
        const content = this.storage.readFile(file);
        const arr = content.split('\n').filter(Boolean);
        console.log('------------------- 最近日志 -------------------');
        console.log(arr.slice(-lines).join('\n') || '暂无日志');
        break;
      }
      case 'exit':
      case 'quit':
        this.rl.close();
        return;
      default:
        console.log(`未知命令: ${cmd}, 输入 .help 查看帮助`);
    }
    this.printPrompt();
  }

  formatDuration(ms) {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    if (h > 0) return `${h}小时${m % 60}分`;
    if (m > 0) return `${m}分${s % 60}秒`;
    return `${s}秒`;
  }
}

async function start(name, botDir, baseDir) {
  const session = new Session(name, botDir, baseDir);
  await session.start();
}

module.exports = { start };
