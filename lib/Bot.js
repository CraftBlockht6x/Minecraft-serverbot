#!/usr/bin/env node
/**
 * Bot.js - 单个假人子进程
 * 由 Daemon.js fork 启动,通过 process.send 与守护进程通信
 */

const { createClient } = require('bedrock-protocol');
const path = require('path');
const { randomUUID } = require('crypto');

const Config = require('./Config');
const Storage = require('./Storage');
const LogBuffer = require('./LogBuffer');
const { BotMessenger } = require('./IPC');

const name = process.argv[2];
if (!name) {
  console.error('缺少假人名称');
  process.exit(1);
}

const baseDir = path.resolve(__dirname, '..');
const cfg = Config.loadBot(baseDir, name);
const storage = new Storage(baseDir);
const botDir = storage.botDir(name);
storage.ensureBotDir(name);

const messenger = new BotMessenger();
const chatLog = new LogBuffer(path.join(botDir, 'chat.log'), cfg.LOG_INTERVAL_MS || 1000);
const aiLog = cfg.DEEPSEEK_API_KEY ? new LogBuffer(path.join(botDir, 'ai.log'), cfg.LOG_INTERVAL_MS || 1000) : null;
const errorLog = new LogBuffer(path.join(botDir, 'error.log'), cfg.LOG_INTERVAL_MS || 1000);

const conversationFile = path.join(botDir, 'conversation.json');
const stateFile = path.join(botDir, 'state.json');

// 每个假人固定的命令请求 origin uuid,用于匹配服务端的 command_output 返回
const BOT_COMMAND_ORIGIN_UUID = randomUUID();

let conversation = storage.readJson(conversationFile) || [{ role: 'system', content: cfg.SYSTEM_PROMPT }];
let reconnectCount = 0;
let lastAiReplyAt = 0;
let client = null;
let antiAfkTimer = null;
let statusTimer = null;
let startedAt = Date.now();

// 记录假人自己最近发送的内容,防止 /say /me 回显导致自循环
const sentMessageBuffer = [];
const SENT_MESSAGE_TTL_MS = 30000;

function recordSentMessage(raw) {
  const normalized = String(raw).replace(/\s+/g, ' ').trim();
  if (!normalized) return;
  const now = Date.now();
  // 清理过期
  while (sentMessageBuffer.length && sentMessageBuffer[0].at < now - SENT_MESSAGE_TTL_MS) {
    sentMessageBuffer.shift();
  }
  sentMessageBuffer.push({ at: now, text: normalized });
}

function isSelfEcho(message) {
  const normalized = String(message).replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  const now = Date.now();
  while (sentMessageBuffer.length && sentMessageBuffer[0].at < now - SENT_MESSAGE_TTL_MS) {
    sentMessageBuffer.shift();
  }
  return sentMessageBuffer.some((item) => normalized.includes(item.text) || item.text.includes(normalized));
}

function localLog(...args) {
  const line = `[${new Date().toLocaleTimeString()}] ${args.join(' ')}`;
  chatLog.log(line + '\n');
  messenger.send('log', line);
}

// 只写入日志文件,不广播到 attach 命令行,避免刷屏
function localDebug(...args) {
  const line = `[${new Date().toLocaleTimeString()}] ${args.join(' ')}`;
  chatLog.log(line + '\n');
}

function localError(...args) {
  const line = `[${new Date().toLocaleTimeString()}] [错误] ${args.join(' ')}`;
  errorLog.log(line + '\n');
  messenger.send('log', line);
}

function localAiLog(line) {
  if (!aiLog) return;
  aiLog.log(`[${new Date().toISOString()}] ${line}\n`);
}

function saveConversation() {
  storage.writeJson(conversationFile, conversation);
}

function saveState(extra = {}) {
  const mem = process.memoryUsage();
  storage.writeJson(stateFile, {
    name,
    startedAt,
    reconnectCount,
    memoryUsage: { rss: mem.rss, heapUsed: mem.heapUsed },
    memoryLimit: cfg.MEMORY_LIMIT_MB,
    status: client && !client._closed ? 'online' : 'offline',
    ...extra,
  });
}

function getStatusName(code) {
  const names = {
    0: 'login_success',
    1: 'failed_client',
    2: 'failed_spawn',
    3: 'player_spawn',
    4: 'failed_invalid_tenant',
    5: 'failed_vanilla_edu',
    6: 'failed_edu_vanilla',
    7: 'failed_server_full',
    8: 'failed_editor_vanilla_mismatch',
    9: 'failed_vanilla_editor_mismatch',
  };
  return names[code] ?? `unknown(${code})`;
}

function getTextTypeName(type) {
  const names = {
    0: 'raw', 1: 'chat', 2: 'translation', 3: 'popup', 4: 'jukebox_popup',
    5: 'tip', 6: 'system', 7: 'whisper', 8: 'announcement',
    9: 'json_whisper', 10: 'json', 11: 'json_announcement',
  };
  if (typeof type === 'string') {
    const clean = type.trim().toLowerCase();
    return Object.values(names).includes(clean) ? clean : `unknown(${type})`;
  }
  return names[type] ?? `unknown(${type})`;
}

const TEXT_TYPE_IDS = {
  raw: 0, chat: 1, translation: 2, popup: 3, jukebox_popup: 4,
  tip: 5, system: 6, whisper: 7, announcement: 8,
  json_whisper: 9, json: 10, json_announcement: 11,
};

const TEXT_CATEGORY_IDS = {
  message_only: 0, authored: 1, parameters: 2,
};

// 常见 Minecraft 翻译键映射(支持 text 包与 command_output 的 message_id)
const TRANSLATIONS = {
  // 多人游戏
  'multiplayer.player.joined': '%s 加入了游戏',
  'multiplayer.player.left': '%s 离开了游戏',
  'multiplayer.disconnect.not_whitelisted': '你不在白名单中',
  'multiplayer.disconnect.server_full': '服务器已满',
  'multiplayer.disconnect.kicked': '你被踢出服务器',
  'multiplayer.disconnect.banned': '你已被封禁',

  // 聊天
  'chat.type.text': '<%s> %s',
  'chat.type.announcement': '[%s] %s',
  'chat.type.admin': '[%s: %s]',
  'chat.type.emote': '* %s %s',

  // 命令输出
  'commands.players.list': '在线玩家: %s/%s',
  'commands.players.list.names': '玩家列表: %s',
  'commands.generic.permission.selector': '你没有使用此选择器的权限',
  'commands.generic.permission': '你没有权限执行此命令',
  'commands.generic.notFound': '未知命令',
  'commands.generic.syntax': '语法错误',
  'commands.generic.player.notFound': '找不到该玩家',
  'commands.tell.success': '已私信 %s: %s',
  'commands.message.display.incoming': '%s 悄悄对你说: %s',
  'commands.message.display.outgoing': '你对 %s 悄悄说: %s',
  'commands.tp.successVictim': '你已被传送到 %s',
  'commands.tp.success': '已将 %s 传送到 %s',
  'commands.give.success': '已给予 %s %s 个 %s',
  'commands.kill.successful': '已击杀 %s',
  'commands.time.set': '时间已设置为 %s',
  'commands.weather.clear': '天气已设置为晴朗',
  'commands.weather.rain': '天气已设置为下雨',
  'commands.weather.thunder': '天气已设置为雷暴',

  // 断开连接
  'disconnect.kicked': '被踢出: %s',
  'disconnect.disconnected': '连接已断开',
};

// 统一翻译: 去掉前导 %,查找映射表,替换 %1 %2 %s %1$s 等占位符
function formatTranslation(key, params = []) {
  if (!key) return '';
  const cleanKey = String(key).replace(/^%/, '').trim();
  let template = TRANSLATIONS[cleanKey] || cleanKey;
  const arr = Array.isArray(params) ? params : [];

  // 先替换带索引的 %1$s %2$s
  arr.forEach((p, i) => {
    template = template.replace(new RegExp(`%${i + 1}\\$s`, 'g'), String(p));
  });
  // 再替换未编号的 %s
  arr.forEach((p) => {
    template = template.replace('%s', String(p));
  });
  // 最后替换旧式 %1 %2(不带 $s)
  arr.forEach((p, i) => {
    template = template.replace(new RegExp(`%${i + 1}(?!\\$)`, 'g'), String(p));
  });
  return template;
}

function normalizeUuid(uuid) {
  if (!uuid) return '';
  return String(uuid).toLowerCase().replace(/-/g, '');
}

function extractRawtext(obj) {
  if (!obj) return '';
  if (typeof obj === 'string') return obj;
  if (Array.isArray(obj)) return obj.map(extractRawtext).join('');
  if (typeof obj === 'object') {
    if (obj.text) return String(obj.text);
    if (obj.translate) {
      const withArr = Array.isArray(obj.with) ? obj.with.map(extractRawtext) : [];
      // 简单替换 %s %1$s 等占位符
      let text = obj.translate;
      withArr.forEach((w, i) => {
        text = text.replace(new RegExp(`%${i + 1}\\$s`, 'g'), w).replace(/%s/g, w);
      });
      return text;
    }
    if (obj.rawtext) return extractRawtext(obj.rawtext);
  }
  return '';
}

function parseJsonMessage(message) {
  try {
    const data = typeof message === 'string' ? JSON.parse(message) : message;
    return extractRawtext(data);
  } catch (_) {
    return '';
  }
}

function isWhisperLike(message) {
  // 部分服务端把 /msg 反馈或私聊内容以普通聊天格式下发,
  // 通过常见关键词辅助识别为私聊
  const patterns = [
    /悄悄地?对?你[说說]/,
    /whispers? to you/i,
    /tells? you:/i,
    /privately messages? you/i,
  ];
  return patterns.some((p) => p.test(message));
}

// 从服务端转发的私聊文本中尝试提取发送者名字
function extractWhisperSender(message) {
  const patterns = [
    /^(.+?)\s+悄悄地?对?你[说說]/,
    /^(.+?)\s+whispers? to you:/i,
    /^(.+?)\s+tells? you:/i,
    /^(.+?)\s+privately messages? you/i,
  ];
  for (const p of patterns) {
    const m = message.match(p);
    if (m) {
      return m[1]
        .replace(/§./gi, '')
        .replace(/[<>">\[\]]/g, '')
        .trim();
    }
  }
  return null;
}

function pushConversation(role, content) {
  conversation.push({ role, content });
  const max = (cfg.MAX_CONTEXT_LENGTH || 20) + 1; // +1 for system
  if (conversation.length > max) {
    conversation = [conversation[0], ...conversation.slice(-(max - 1))];
  }
  saveConversation();
}

function sendTextPacket(message, type = 'chat') {
  if (!client || client._closed) return false;
  try {
    // Bedrock 1.26+ text 包: type/category 使用字符串枚举名(node-protodef mapper 要求)
    const category = (type === 'chat' || type === 'whisper' || type === 'announcement')
      ? 'authored'
      : 'message_only';

    client.queue('text', {
      needs_translation: false,
      category,
      type,
      source_name: name,
      message,
      xuid: '',
      platform_chat_id: '',
      has_filtered_message: false,
    });
    return true;
  } catch (err) {
    localError('发送聊天包失败:', err.message);
    return false;
  }
}

function sendCommandRequest(command) {
  if (!client || client._closed) return false;
  try {
    // Bedrock 1.26+ command_request 包结构
    client.queue('command_request', {
      command,
      origin: {
        type: 'player',
        uuid: BOT_COMMAND_ORIGIN_UUID,
        request_id: '',
        player_entity_id: 0n,
      },
      internal: false,
      version: 'latest',
    });
    return true;
  } catch (err) {
    localError('执行命令失败:', err.message);
    return false;
  }
}

function sendChatMessage(message, target = null) {
  // 根据 CHAT_MODE 选择发送方式
  // text: 直接发 text 包(部分 1.26+ 原版服会因未签名聊天而断开)
  // say:  通过 /say 命令发送(显示为 [Server] message,需要 OP 权限)
  // me:   通过 /me 命令发送(显示为 * BotName message,需要 OP 权限)
  // target: 如果指定了玩家名,则通过 /tell 向对方发送悄悄话
  const mode = (cfg.CHAT_MODE || 'text').toLowerCase();
  let ok = false;
  if (target) {
    ok = sendCommandRequest(`/tell ${target} ${message}`);
  } else if (mode === 'say') {
    ok = sendCommandRequest(`/say ${message}`);
  } else if (mode === 'me') {
    ok = sendCommandRequest(`/me ${message}`);
  } else {
    ok = sendTextPacket(message, 'chat');
  }
  if (ok) recordSentMessage(message);
  return ok;
}

function handleGameCommand(raw) {
  const cmd = raw.trim();
  if (!cmd) return;
  if (cmd.startsWith('/')) {
    if (sendCommandRequest(cmd)) localLog(`[命令] 已执行: ${cmd}`);
  } else {
    if (sendChatMessage(cmd)) localLog(`[控制台] 发送聊天: ${cmd}`);
  }
}

async function callDeepSeek(userContent) {
  if (!cfg.DEEPSEEK_API_KEY) return null;
  pushConversation('user', userContent);

  const url = `${cfg.DEEPSEEK_BASE_URL}/chat/completions`;
  const body = {
    model: cfg.DEEPSEEK_MODEL,
    messages: conversation,
    max_tokens: cfg.AI_MAX_TOKENS || 256,
    temperature: cfg.AI_TEMPERATURE || 0.7,
  };
  localAiLog(`[请求] ${JSON.stringify(body)}`);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      localAiLog(`[错误] HTTP ${res.status}: ${text}`);
      return null;
    }
    const data = await res.json();
    localAiLog(`[响应] ${JSON.stringify(data)}`);
    const reply = data.choices?.[0]?.message?.content?.trim();
    if (reply) pushConversation('assistant', reply);
    return reply || null;
  } catch (err) {
    localAiLog(`[异常] ${err.message}`);
    return null;
  }
}

async function handleInGameCommand(source, message) {
  if (!message.startsWith(cfg.CMD_PREFIX)) return false;
  const parts = message.slice(cfg.CMD_PREFIX.length).trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const arg = parts.slice(1).join(' ');

  const replies = {
    help: `可用命令: ${cfg.CMD_PREFIX}help, ${cfg.CMD_PREFIX}online, ${cfg.CMD_PREFIX}status, ${cfg.CMD_PREFIX}time, ${cfg.CMD_PREFIX}echo <内容>`,
    online: `当前在线假人: ${name}`,
    status: `我是 ${name},状态正常`,
    time: `现在时间: ${new Date().toLocaleString()}`,
    echo: arg || '请输入要回声的内容',
  };

  const reply = replies[cmd];
  if (reply) {
    sendChatMessage(reply);
    localLog(`[游戏命令] ${source}: ${message} -> ${reply}`);
  }
  return !!reply;
}

let aiGreetingSent = false;

function getKeywords() {
  if (!cfg.AI_KEYWORDS) return [];
  return cfg.AI_KEYWORDS
    .split(/[,，]/)
    .map((k) => k.trim())
    .filter(Boolean);
}

function matchKeywords(message) {
  const keywords = getKeywords();
  if (!keywords.length) return false;
  const lower = message.toLowerCase();
  return keywords.some((k) => lower.includes(k.toLowerCase()));
}

async function triggerAIResponse(source, message, isWhisper = false, whisperTarget = null) {
  if (!cfg.DEEPSEEK_API_KEY) {
    localDebug('[AI] 未配置 DEEPSEEK_API_KEY,跳过');
    return;
  }
  if (source === name) return;

  const mentioned = message.includes(name);
  const keywordMatched = matchKeywords(message);
  const keywords = getKeywords();
  localDebug(`[AI] 触发检查: 模式=${cfg.AI_TRIGGER}, 私聊=${isWhisper}, 提到=${mentioned}, 关键词命中=${keywordMatched}, 关键词=[${keywords.join(', ')}], 来源=${source}`);

  // 收到私聊时强制命中 AI,否则按 AI_TRIGGER 配置判断
  let shouldTrigger = isWhisper;
  if (!shouldTrigger && cfg.AI_TRIGGER === 'none') {
    localDebug('[AI] AI_TRIGGER=none,跳过回复');
    return;
  }
  if (!shouldTrigger) {
    if (cfg.AI_TRIGGER === 'all') {
      shouldTrigger = true;
    } else if (cfg.AI_TRIGGER === 'mention') {
      shouldTrigger = mentioned || keywordMatched;
    } else if (cfg.AI_TRIGGER === 'keyword') {
      shouldTrigger = keywordMatched;
    } else {
      localDebug(`[AI] 未知触发模式 ${cfg.AI_TRIGGER},跳过`);
      return;
    }
  }

  if (!shouldTrigger) {
    localDebug('[AI] 未满足触发条件,跳过回复');
    return;
  }

  const now = Date.now();
  if (now - lastAiReplyAt < (cfg.AI_RATE_LIMIT_MS || 5000)) {
    localLog('[AI] 速率限制中,跳过回复');
    return;
  }

  // 首次触发时发送一次性问候语(不是系统提示词,是配置里可选的 AI_GREETING)
  if (!aiGreetingSent && cfg.AI_GREETING) {
    aiGreetingSent = true;
    sendChatMessage(cfg.AI_GREETING, whisperTarget);
    localLog(`[AI] 首次触发,发送问候: ${cfg.AI_GREETING}${whisperTarget ? ' -> ' + whisperTarget : ''}`);
  }

  const prompt = isWhisper
    ? `玩家 "${source}" 悄悄对你说:"${message}"，请也用简短的中文悄悄话回复。`
    : `玩家 "${source}" 对你说:"${message}"`;
  localLog('[AI] 收到消息,正在请求 DeepSeek...');
  const reply = await callDeepSeek(prompt);
  if (!reply) {
    localLog('[AI] 未获得回复');
    return;
  }
  const maxLines = cfg.AI_MAX_LINES ? parseInt(cfg.AI_MAX_LINES, 10) : 5;
  const lines = reply
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(0, maxLines)
    .map((l) => (l.length > 200 ? l.slice(0, 197) + '...' : l));

  if (!lines.length) {
    localLog('[AI] 未获得有效回复');
    return;
  }

  localLog(`[AI] 回复共 ${lines.length} 行${whisperTarget ? ' (悄悄话 -> ' + whisperTarget + ')' : ''}`);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (sendChatMessage(line, whisperTarget)) {
      lastAiReplyAt = now + i * 500;
      localLog(`[AI] 回复[${i + 1}/${lines.length}]: ${line}`);
    } else {
      localError(`[AI] 回复[${i + 1}/${lines.length}] 发送失败,请检查 CHAT_MODE 或服务器权限`);
    }
    if (i < lines.length - 1) {
      await new Promise((r) => setTimeout(r, cfg.AI_LINE_DELAY_MS || 500));
    }
  }
}

function startAntiAfk() {
  if (!cfg.ANTI_AFK || cfg.ANTI_AFK_INTERVAL <= 0) return;
  antiAfkTimer = setInterval(() => {
    if (!client || client._closed) return;
    try {
      client.queue('animate', { action_id: 1, runtime_entity_id: 0 });
    } catch (err) {
      localError('防踢动作失败:', err.message);
    }
  }, cfg.ANTI_AFK_INTERVAL);
}

function stopAntiAfk() {
  if (antiAfkTimer) {
    clearInterval(antiAfkTimer);
    antiAfkTimer = null;
  }
}

function createBot() {
  const opts = {
    host: cfg.SERVER_HOST,
    port: cfg.SERVER_PORT,
    username: name,
    offline: true,
    connectTimeout: cfg.CONNECT_TIMEOUT || 15000,
    viewDistance: cfg.VIEW_DISTANCE || 10,
  };
  if (cfg.VERSION) opts.version = cfg.VERSION;

  client = createClient(opts);
  let state = 'connecting';
  let wasKicked = false;

  client.on('status', (status) => {
    const code = typeof status === 'number' ? status : status?.status;
    localLog(`登录状态: ${getStatusName(code)}`);
  });

  client.on('login', () => {
    state = 'login';
    localLog('已通过服务器认证');
  });

  client.on('join', () => {
    state = 'join';
    reconnectCount = 0;
    localLog('成功加入服务器');
    saveState({ exitReason: null });
  });

  client.on('spawn', () => {
    state = 'spawn';
    localLog('已在世界中生成');
    startAntiAfk();
  });

  client.on('player_list', (packet) => {
    if (!cfg.WELCOME_MSG || !packet.records) return;
    packet.records.forEach((rec) => {
      if (rec.username && rec.username !== name) {
        setTimeout(() => sendChatMessage(`${rec.username}, ${cfg.WELCOME_MSG}`), 1500);
      }
    });
  });

  client.on('text', (packet) => {
    if (cfg.RAW_PACKET_DEBUG === true || cfg.RAW_PACKET_DEBUG === 'true') {
      localDebug('[RAW text]', JSON.stringify(packet));
    }

    const typeName = getTextTypeName(packet.type);
    const source = (packet.source_name || '[SERVER]').replace(/§./gi, '').trim();
    let msg = (packet.message || '').replace(/§./gi, '').trim();

    // json 类型强制解析 rawtext 内容(即使 message 已经是 JSON 字符串)
    if (typeName === 'json' || typeName === 'json_whisper' || typeName === 'json_announcement') {
      const parsed = parseJsonMessage(packet.message);
      if (parsed) msg = parsed;
    }

    // translation 类型或包含翻译键的非玩家聊天消息进行统一翻译
    const params = Array.isArray(packet.parameters) ? packet.parameters : [];
    const looksLikeTranslationKey = msg.startsWith('%') || TRANSLATIONS[msg.replace(/^%/, '')];
    if (typeName === 'translation' || (looksLikeTranslationKey && typeName !== 'chat' && typeName !== 'whisper')) {
      msg = formatTranslation(msg, params);
    }
    if (!msg) return;

    const isWhisperPacket = typeName === 'whisper' || typeName === 'json_whisper' || isWhisperLike(msg);

    // 判断是否为真实玩家私聊,并解析出发送者名字
    let actualSource = source;
    let whisperTarget = null;
    let isPlayerWhisper = false;
    if (isWhisperPacket) {
      if (source !== name && source.toLowerCase() !== '[server]') {
        whisperTarget = source;
        isPlayerWhisper = true;
      } else {
        const parsedSender = extractWhisperSender(msg);
        if (parsedSender && parsedSender !== name) {
          actualSource = parsedSender;
          whisperTarget = parsedSender;
          isPlayerWhisper = true;
        }
      }
    }

    let line = '';
    if (typeName === 'chat' || typeName === 'whisper' || typeName === 'json_whisper') {
      line = isWhisperPacket ? `[私聊] <${actualSource}> ${msg}` : `<${actualSource}> ${msg}`;
    } else if (typeName === 'announcement' || typeName === 'json_announcement') {
      line = `[公告] ${msg}`;
    } else if (typeName === 'system') {
      line = `[系统] ${msg}`;
    } else if (typeName === 'translation' || typeName === 'json' || typeName === 'raw') {
      line = `[命令/系统] ${msg}`;
    } else {
      line = `[${typeName}] ${actualSource}: ${msg}`;
    }

    // 假人自己发送的内容以及 [SERVER] 回显不再重复显示在命令行,但仍写入日志文件
    const isServerEcho = source.toLowerCase() === '[server]' && isSelfEcho(msg);
    if (actualSource === name || isServerEcho) {
      localDebug(line);
      return;
    }

    localLog(line);

    if (!isPlayerWhisper && cfg.IGNORE_SERVER_CHAT !== false && cfg.IGNORE_SERVER_CHAT !== 'false' && source.toLowerCase() === '[server]') {
      localDebug('[AI] 来源为 [SERVER],跳过处理');
      return;
    }
    if (!isPlayerWhisper && typeName !== 'chat' && typeName !== 'whisper' && typeName !== 'json_whisper') return;

    handleInGameCommand(actualSource, msg).then((handled) => {
      if (handled) return;
      if (cfg.ECHO_CHAT) sendChatMessage(`收到来自 ${actualSource} 的消息`, whisperTarget);
      triggerAIResponse(actualSource, msg, isPlayerWhisper, whisperTarget);
    }).catch((err) => localError('处理消息出错:', err.message));
  });

  client.on('command_output', (packet) => {
    if (cfg.RAW_PACKET_DEBUG === true || cfg.RAW_PACKET_DEBUG === 'true') {
      localDebug('[RAW command_output]', JSON.stringify(packet));
    }

    const outputs = packet.output || [];
    const originUuid = normalizeUuid(packet.origin?.uuid);
    const botUuid = normalizeUuid(BOT_COMMAND_ORIGIN_UUID);
    if (originUuid !== botUuid) {
      localDebug(`[命令结果] 收到非本假人命令返回,忽略 (origin.uuid: ${packet.origin?.uuid || 'none'}, bot: ${BOT_COMMAND_ORIGIN_UUID})`);
      return;
    }
    if (!outputs.length) {
      localLog(`[命令结果] 命令执行完成,成功次数: ${packet.success_count ?? '?'}`);
      return;
    }
    outputs.forEach((out) => {
      let line = '';
      if (typeof out === 'string') {
        line = out;
      } else if (out && typeof out === 'object') {
        // 优先使用 message_id + parameters 翻译(1.26+ 命令输出结构)
        if (out.message_id) {
          line = formatTranslation(out.message_id, out.parameters);
        } else {
          line = out.message || out.text || extractRawtext(out);
        }
      }
      line = String(line).replace(/§./gi, '').trim();
      if (line) localLog(`[命令结果] ${line}`);
    });
  });

  client.on('kick', (reason) => {
    wasKicked = true;
    localLog('被服务器踢出:', reason);
  });

  client.on('disconnect', (packet) => {
    const reason = packet.message || packet.reason || JSON.stringify(packet);
    localLog('收到断开包:', reason);
  });

  client.on('error', (err) => {
    localError('连接错误:', err.message);
  });

  client.on('close', () => {
    state = 'closed';
    stopAntiAfk();
    localLog('连接已关闭');
    saveState({ exitReason: wasKicked ? 'kicked' : 'disconnected' });

    if (!cfg.AUTO_RECONNECT) return;
    if (wasKicked && !cfg.RECONNECT_ON_KICK) {
      localLog('被踢出且未启用被踢重连,停止重连');
      return;
    }
    if (reconnectCount >= (cfg.MAX_RECONNECTS || 3)) {
      localLog(`重连次数已达上限 (${cfg.MAX_RECONNECTS || 3}),停止重连`);
      return;
    }
    reconnectCount += 1;
    localLog(`${cfg.RECONNECT_INTERVAL || 5000}ms 后第 ${reconnectCount} 次重连...`);
    setTimeout(createBot, cfg.RECONNECT_INTERVAL || 5000);
  });
}

messenger.onMessage = (type, data) => {
  if (type === 'chat') {
    if (sendChatMessage(data)) localLog(`[控制台] 发送聊天: ${data}`);
  } else if (type === 'gameCommand') {
    handleGameCommand(data);
  } else if (type === 'clearContext') {
    conversation = [{ role: 'system', content: cfg.SYSTEM_PROMPT }];
    saveConversation();
    localLog('[AI] 上下文已清空');
  } else if (type === 'stop') {
    localLog('收到停止指令,正在关闭...');
    saveConversation();
    if (client) client.close();
    process.exit(0);
  }
};

statusTimer = setInterval(() => {
  saveState();
  messenger.send('status', storage.readJson(stateFile));
}, 2000);

process.on('exit', () => {
  if (statusTimer) clearInterval(statusTimer);
  saveState();
  saveConversation();
});

process.on('uncaughtException', (err) => {
  localError('未捕获异常:', err.message);
  saveState({ exitReason: 'exception: ' + err.message });
  setTimeout(() => process.exit(1), 500);
});

saveState({ exitReason: null });
createBot();
