/**
 * 配置加载器
 * 优先级: bots/<name>/.env > 全局 .env > 代码默认值
 */

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  // 全局默认
  DEEPSEEK_API_KEY: undefined,
  DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
  DEEPSEEK_MODEL: 'deepseek-v4-flash',
  AI_TRIGGER: 'mention',
  AI_KEYWORDS: '',
  AI_GREETING: '',
  AI_RATE_LIMIT_MS: '5000',
  AI_LINE_DELAY_MS: '500',
  AI_MAX_LINES: '5',
  CHAT_MODE: 'text',
  IGNORE_SERVER_CHAT: 'true',
  RAW_PACKET_DEBUG: 'false',
  MAX_CONTEXT_LENGTH: '20',
  AI_MAX_TOKENS: '256',
  AI_TEMPERATURE: '0.7',
  LOG_INTERVAL_MS: '1000',
  ECHO_CHAT: 'false',

  // 单假人默认(可被 .env 覆盖)
  SYSTEM_PROMPT: '你是 Minecraft 服务器里的一个玩家,性格友善、幽默,会用简短的中文回答。',
  SERVER_HOST: '127.0.0.1',
  SERVER_PORT: '19132',
  MEMORY_LIMIT_MB: '512',
  CMD_PREFIX: '!',
  WELCOME_MSG: '',
  ANTI_AFK: 'false',
  ANTI_AFK_INTERVAL: '30000',
  AUTO_RECONNECT: 'true',
  RECONNECT_ON_KICK: 'false',
  MAX_RECONNECTS: '3',
  VERSION: '',
  VIEW_DISTANCE: '10',
  CONNECT_TIMEOUT: '15000',
  RECONNECT_INTERVAL: '5000',
};

function parseEnv(content) {
  const result = {};
  if (!content) return result;
  content.split(/\r?\n/).forEach((line) => {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) {
      result[m[1]] = m[2];
    }
  });
  return result;
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  return parseEnv(fs.readFileSync(filePath, 'utf8'));
}

function castValue(key, value) {
  if (value === undefined || value === null) return undefined;
  if (value === '') return DEFAULTS[key] ?? undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^\d+$/.test(value)) return parseInt(value, 10);
  if (/^\d+\.\d+$/.test(value)) return parseFloat(value);
  return value;
}

function merge(base, overrides) {
  const result = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) result[key] = castValue(key, value);
  }
  return result;
}

function loadGlobal(baseDir) {
  const globalEnv = loadEnvFile(path.join(baseDir, '.env'));
  return merge(DEFAULTS, globalEnv);
}

function loadBot(baseDir, name) {
  const globalCfg = loadGlobal(baseDir);
  const botEnv = loadEnvFile(path.join(baseDir, 'bots', name, '.env'));
  return merge(globalCfg, botEnv);
}

module.exports = {
  loadGlobal,
  loadBot,
  DEFAULTS,
};
