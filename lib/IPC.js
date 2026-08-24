/**
 * 进程间通信
 * - DaemonServer: 守护进程内的 Unix Socket 服务端,用于 attach 客户端连接
 * - DaemonClient: CLI/Session 里的 Unix Socket 客户端
 * - BotMessenger: 假人子进程与守护进程通过 process.send 通信
 */

const net = require('net');
const fs = require('fs');
const path = require('path');

function socketPath(botDir) {
  return path.join(botDir, 'daemon.sock');
}

class DaemonServer {
  constructor(botDir) {
    this.botDir = botDir;
    this.sock = socketPath(botDir);
    this.server = null;
    this.clients = [];
    this.onMessage = null; // function(type, data)
  }

  start() {
    if (fs.existsSync(this.sock)) {
      try { fs.unlinkSync(this.sock); } catch (_) { /* ignore */ }
    }
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        this.clients.push(socket);
        let buf = '';
        socket.on('data', (data) => {
          buf += data.toString();
          let idx;
          while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx);
            buf = buf.slice(idx + 1);
            try {
              const msg = JSON.parse(line);
              if (this.onMessage) this.onMessage(msg.type, msg.data, msg);
            } catch (_) {
              // ignore malformed json
            }
          }
        });
        socket.on('close', () => {
          this.clients = this.clients.filter((c) => c !== socket);
        });
        socket.on('error', () => {
          this.clients = this.clients.filter((c) => c !== socket);
        });
      });
      this.server.listen(this.sock, () => {
        fs.chmodSync(this.sock, 0o666);
        resolve();
      });
      this.server.on('error', reject);
    });
  }

  broadcast(type, data) {
    const line = JSON.stringify({ type, data }) + '\n';
    const dead = [];
    this.clients.forEach((c) => {
      if (c.destroyed) {
        dead.push(c);
        return;
      }
      try {
        c.write(line);
      } catch (_) {
        dead.push(c);
      }
    });
    this.clients = this.clients.filter((c) => !dead.includes(c));
  }

  close() {
    this.clients.forEach((c) => c.destroy());
    if (this.server) {
      this.server.close();
      try { fs.unlinkSync(this.sock); } catch (_) { /* ignore */ }
    }
  }
}

class DaemonClient {
  constructor(botDir) {
    this.botDir = botDir;
    this.sock = socketPath(botDir);
    this.socket = null;
    this.onMessage = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.socket = net.createConnection(this.sock, () => resolve());
      this.socket.on('error', reject);
      let buf = '';
      this.socket.on('data', (data) => {
        buf += data.toString();
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          try {
            const msg = JSON.parse(line);
            if (this.onMessage) this.onMessage(msg.type, msg.data);
          } catch (_) { /* ignore */ }
        }
      });
    });
  }

  ping() {
    return new Promise((resolve) => {
      if (!fs.existsSync(this.sock)) return resolve(false);
      const s = net.createConnection(this.sock);
      s.on('connect', () => {
        s.destroy();
        resolve(true);
      });
      s.on('error', () => resolve(false));
      setTimeout(() => {
        s.destroy();
        resolve(false);
      }, 500);
    });
  }

  send(msg) {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) return reject(new Error('未连接'));
      try {
        this.socket.write(JSON.stringify(msg) + '\n', (err) => {
          if (err) reject(err);
          else resolve();
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  close() {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }
}

class BotMessenger {
  constructor() {
    this.onMessage = null;
    process.on('message', (msg) => {
      if (this.onMessage) this.onMessage(msg.type, msg.data);
    });
  }

  send(type, data) {
    if (process.send) {
      process.send({ type, data });
    }
  }
}

module.exports = {
  DaemonServer,
  DaemonClient,
  BotMessenger,
  socketPath,
};
