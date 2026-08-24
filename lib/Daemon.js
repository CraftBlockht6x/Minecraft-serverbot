#!/usr/bin/env node
/**
 * Daemon.js - 单个假人的守护进程
 * 负责启动/监控/重启 Bot 子进程,并作为 IPC 中介
 */

const { fork } = require('child_process');
const fs = require('fs');
const path = require('path');

const Config = require('./Config');
const Storage = require('./Storage');
const { DaemonServer } = require('./IPC');

const name = process.argv[2];
if (!name) {
  console.error('缺少假人名称');
  process.exit(1);
}

const baseDir = path.resolve(__dirname, '..');
const cfg = Config.loadBot(baseDir, name);
const storage = new Storage(baseDir);
const botDir = storage.ensureBotDir(name);

const botScript = path.join(baseDir, 'lib', 'Bot.js');
const pidFile = path.join(botDir, 'daemon.pid');

let child = null;
let restarting = false;
let stopRequested = false;

const server = new DaemonServer(botDir);

function log(line) {
  const text = `[${new Date().toLocaleTimeString()}] [Daemon] ${line}`;
  fs.appendFileSync(path.join(botDir, 'daemon.log'), text + '\n');
}

function writePid() {
  fs.writeFileSync(pidFile, String(process.pid));
}

function removePid() {
  try { fs.unlinkSync(pidFile); } catch (_) { /* ignore */ }
}

function spawnBot() {
  if (stopRequested) return;
  log(`启动 Bot 子进程 (内存限制 ${cfg.MEMORY_LIMIT_MB || 512}MB)`);
  child = fork(botScript, [name], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    execArgv: [`--max-old-space-size=${cfg.MEMORY_LIMIT_MB || 512}`],
  });

  child.stdout.on('data', (data) => {
    fs.appendFileSync(path.join(botDir, 'bot.stdout.log'), data.toString());
  });
  child.stderr.on('data', (data) => {
    fs.appendFileSync(path.join(botDir, 'bot.stderr.log'), data.toString());
  });

  child.on('message', (msg) => {
    if (msg.type === 'log') {
      server.broadcast('log', msg.data);
    } else if (msg.type === 'status') {
      server.broadcast('status', msg.data);
    }
  });

  child.on('exit', (code) => {
    log(`Bot 子进程退出 (code: ${code})`);
    if (stopRequested) {
      removePid();
      process.exit(0);
    }
    if (!restarting) {
      restarting = true;
      log('2秒后自动重启...');
      setTimeout(() => {
        restarting = false;
        spawnBot();
      }, 2000);
    }
  });

  child.on('error', (err) => {
    log(`Bot 子进程错误: ${err.message}`);
  });
}

server.onMessage = (type, data) => {
  if (type === 'stop') {
    stopRequested = true;
    if (child) {
      child.send({ type: 'stop' });
      setTimeout(() => {
        if (child && !child.killed) child.kill('SIGTERM');
      }, 3000);
    }
  } else if (type === 'restart') {
    log('收到重启指令,正在重启 Bot');
    if (child) {
      child.kill('SIGTERM');
    }
  } else if (['chat', 'gameCommand', 'clearContext'].includes(type)) {
    if (child) child.send({ type, data });
  }
};

async function main() {
  writePid();
  await server.start();
  spawnBot();

  process.on('SIGINT', () => {
    log('收到 SIGINT,正在停止...');
    stopRequested = true;
    if (child) child.send({ type: 'stop' });
    setTimeout(() => process.exit(0), 1000);
  });

  process.on('SIGTERM', () => {
    log('收到 SIGTERM,正在停止...');
    stopRequested = true;
    if (child) child.send({ type: 'stop' });
    setTimeout(() => process.exit(0), 1000);
  });
}

main().catch((err) => {
  log(`守护进程异常: ${err.message}`);
  removePid();
  process.exit(1);
});
