/**
 * 文件/目录存储工具
 */

const fs = require('fs');
const path = require('path');

class Storage {
  constructor(baseDir) {
    this.baseDir = baseDir;
  }

  botDir(name) {
    return path.join(this.baseDir, 'bots', name);
  }

  ensureBotDir(name) {
    const dir = this.botDir(name);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      const envPath = path.join(dir, '.env');
      if (!fs.existsSync(envPath)) {
        fs.writeFileSync(envPath, this.defaultBotEnv(name));
      }
    }
    return dir;
  }

  defaultBotEnv(name) {
    return `SYSTEM_PROMPT=你是 Minecraft 服务器里的玩家,性格友善幽默,用简短中文回答。
SERVER_HOST=127.0.0.1
SERVER_PORT=19132
MEMORY_LIMIT_MB=512
CMD_PREFIX=!
WELCOME_MSG=
ANTI_AFK=false
ANTI_AFK_INTERVAL=30000
AUTO_RECONNECT=true
RECONNECT_ON_KICK=false
MAX_RECONNECTS=3
VERSION=
VIEW_DISTANCE=10
CONNECT_TIMEOUT=15000
RECONNECT_INTERVAL=5000
ECHO_CHAT=false
AI_TRIGGER=mention
AI_KEYWORDS=
AI_GREETING=
AI_RATE_LIMIT_MS=5000
AI_LINE_DELAY_MS=500
AI_MAX_LINES=5
CHAT_MODE=text
IGNORE_SERVER_CHAT=true
RAW_PACKET_DEBUG=false
`;
  }

  listBots() {
    const botsDir = path.join(this.baseDir, 'bots');
    if (!fs.existsSync(botsDir)) return [];
    return fs.readdirSync(botsDir).filter((f) => {
      const p = path.join(botsDir, f);
      return fs.statSync(p).isDirectory();
    });
  }

  exists(filePath) {
    return fs.existsSync(filePath);
  }

  readFile(filePath) {
    if (!fs.existsSync(filePath)) return '';
    return fs.readFileSync(filePath, 'utf8');
  }

  writeFile(filePath, content) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, content);
  }

  readJson(filePath) {
    try {
      if (!fs.existsSync(filePath)) return null;
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      return null;
    }
  }

  writeJson(filePath, data) {
    this.writeFile(filePath, JSON.stringify(data, null, 2));
  }

  appendFile(filePath, content) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(filePath, content);
  }
}

module.exports = Storage;
