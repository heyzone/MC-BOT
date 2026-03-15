/**
 * Pathfinder PRO (Hybrid Plus Edition)
 * Update: 修复配置保存失效 + 优化按钮交互
 */
const { spawn } = require('child_process');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const os = require('os');

process.on('uncaughtException', (err) => console.error(' [系统警告] 异常:', err.message));
process.on('unhandledRejection', (reason) => console.error(' [系统警告] 拒绝:', reason));

const mineflayer = require("mineflayer");
const express = require('express');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const axios = require('axios');
const multer = require('multer');
const FormData = require('form-data');
const upload = multer({ storage: multer.memoryStorage() });

const app = express();
const activeBots = new Map();
const CONFIG_FILE = path.join(__dirname, 'bots_config.json');
const mcDataCache = new Map();
const pteroMonitorTimers = new Map();
const webAfkTimers = new Map();
let ffProcess = null;
let ffLogs = [];

app.use(express.json());

// --- [ 内存监控 ] ---
function getMemoryStatus() {
    const used = process.memoryUsage().rss; let total = os.totalmem(); 
    if (process.env.SERVER_MEMORY) total = parseInt(process.env.SERVER_MEMORY) * 1024 * 1024;
    else {
        try {
            if (fsSync.existsSync('/sys/fs/cgroup/memory/memory.limit_in_bytes')) { const limit = parseInt(fsSync.readFileSync('/sys/fs/cgroup/memory/memory.limit_in_bytes', 'utf8').trim()); if (limit < 9223372036854771712) total = limit; } 
            else if (fsSync.existsSync('/sys/fs/cgroup/memory.max')) { const limit = fsSync.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim(); if (limit !== 'max') total = parseInt(limit); }
        } catch (e) {}
    }
    const percent = ((used / total) * 100).toFixed(1);
    return { used: (used / 1024 / 1024).toFixed(1), total: (total / 1024 / 1024).toFixed(0), percent };
}

setInterval(() => {
    const status = getMemoryStatus();
    if (parseFloat(status.percent) >= 85) { mcDataCache.clear(); if (parseFloat(status.percent) > 92) process.exit(1); }
}, 30000);

// --- [ 核心逻辑 ] ---
async function saveBotsConfig() { try { const config = Array.from(activeBots.values()).map(b => ({ host: b.targetHost, port: b.targetPort, username: b.username, settings: b.settings, logs: b.logs.slice(0, 30) })); await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2)); } catch (err) {} }

function startServerMonitor(botId) {
    if (pteroMonitorTimers.has(botId)) { clearInterval(pteroMonitorTimers.get(botId)); pteroMonitorTimers.delete(botId); }
    const botMeta = activeBots.get(botId);
    if (!botMeta || !botMeta.settings.keepAlive) return;
    const pto = botMeta.settings.pterodactyl; 
    if (!pto.url || !pto.id || !pto.key) { botMeta.pushLog(`⚠️ 守护启动失败: 翼龙配置不完整`, 'text-red-400'); return; }

    botMeta.pushLog(`🛡️ 守护监控已启动`, 'text-purple-400');
    const timer = setInterval(async () => {
        const currentBot = activeBots.get(botId);
        if (!currentBot || !currentBot.settings.keepAlive) { clearInterval(timer); pteroMonitorTimers.delete(botId); return; }
        try {
            const res = await axios.get(`${currentBot.settings.pterodactyl.url}/api/client/servers/${currentBot.settings.pterodactyl.id}/resources`, { headers: { 'Authorization': `Bearer ${currentBot.settings.pterodactyl.key}`, 'Accept': 'application/json' }, timeout: 5000 });
            if (res.data.attributes.current_state === 'offline') { currentBot.pushLog(`⚠️ 服务器离线，正在开机...`, 'text-yellow-400 font-bold'); await axios.post(`${currentBot.settings.pterodactyl.url}/api/client/servers/${currentBot.settings.pterodactyl.id}/power`, { signal: 'start' }, { headers: { 'Authorization': `Bearer ${currentBot.settings.pterodactyl.key}` } }); }
        } catch (e) { currentBot.pushLog(`❌ 守护请求失败: ${e.message}`, 'text-red-400'); }
    }, 120 * 1000);
    pteroMonitorTimers.set(botId, timer);
}

function startWebAfk(botId) {
    const botMeta = activeBots.get(botId);
    if (!botMeta) return;

    const pto = botMeta.settings.pterodactyl;
    if (!pto || !pto.url) { 
        botMeta.pushLog(`❌ 挂机启动失败: 请先填写翼龙URL并保存`, 'text-red-400 font-bold');
        botMeta.settings.webAfk = false; 
        return;
    }

    if (webAfkTimers.has(botId)) clearInterval(webAfkTimers.get(botId));
    botMeta.settings.webAfk = true;
    botMeta.pushLog(`🌐 网页挂机已启动`, 'text-green-400 font-bold');

    const doAfkLoop = async () => {
        const currentBot = activeBots.get(botId);
        if (!currentBot || !currentBot.settings.webAfk) { if (webAfkTimers.has(botId)) clearInterval(webAfkTimers.get(botId)); webAfkTimers.delete(botId); return; }
        const { url, key } = currentBot.settings.pterodactyl;
        const safeUrl = url.replace(/\/$/, "");
        let latestBalance = currentBot.lastWebBalance || 0;
        try {
            const headers = { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0', 'Referer': `${safeUrl}/wallet` };
            if (key.includes('=')) headers['Cookie'] = key; else headers['Authorization'] = `Bearer ${key}`;
            const res = await axios.get(`${safeUrl}/wallet/balance`, { headers, timeout: 5000 });
            
            // 【新增】调试日志：打印原始返回数据，方便排查余额为何是 0
            // 如果您看到了 JSON 数据，可以发给我，我帮您适配字段
            currentBot.pushLog(`🔍 API原始数据: ${JSON.stringify(res.data).substring(0, 100)}`, 'text-slate-400');

            const balance = findCredits(res.data);
            if (balance > 0 || balance === 0) { latestBalance = parseFloat(balance); currentBot.lastWebBalance = latestBalance; }
        } catch (err) { 
            currentBot.pushLog(`⚠️ 余额获取失败: ${err.message}`, 'text-yellow-400');
        }
        currentBot.pushLog(`💰 网页余额: ${latestBalance}`, 'text-emerald-400');
    };
    doAfkLoop();
    const timer = setInterval(doAfkLoop, 120000);
    webAfkTimers.set(botId, timer);
}

function stopWebAfk(botId) {
    const botMeta = activeBots.get(botId);
    if (botMeta) { botMeta.settings.webAfk = false; botMeta.pushLog(`🛑 网页挂机已停止`, 'text-red-400'); }
    if (webAfkTimers.has(botId)) { clearInterval(webAfkTimers.get(botId)); webAfkTimers.delete(botId); }
}

function findCredits(data) {
    if (!data) return 0; if (typeof data === 'number') return data;
    if (data.balance !== undefined) return data.balance; if (data.credits !== undefined) return data.credits;
    if (data.points !== undefined) return data.points; if (data.xpl !== undefined) return data.xpl;
    for (let k in data) { if (typeof data[k] === 'object') { const found = findCredits(data[k]); if (found > 0) return found; } }
    return 0;
}

// --- [ 增强型 Bot 逻辑 ] ---

function handleExit(botMeta, reason = "未知") {
    if (!activeBots.has(botMeta.id)) return; 

    if (botMeta.afkTimer) clearInterval(botMeta.afkTimer);
    if (botMeta.survivalTimer) clearInterval(botMeta.survivalTimer);
    botMeta.isRepairing = false;
    botMeta.isMoving = false;
    botMeta.status = "断开";

    botMeta.retryCount = (botMeta.retryCount || 0) + 1;
    const delay = Math.min(60000, 2000 * Math.pow(2, botMeta.retryCount - 1)); 

    botMeta.pushLog(`🔌 断开连接 (${reason})，${(delay/1000).toFixed(1)}秒后重试 (第${botMeta.retryCount}次)...`, 'text-orange-400 font-bold');

    setTimeout(() => {
        if (activeBots.has(botMeta.id) && !botMeta.isRepairing) {
            attemptRepair(botMeta.id, botMeta, "自动重连");
        }
    }, delay);
}

async function checkSurvival(bot, botMeta) {
    if (!bot || !bot.entity) return;
    
    if (bot.health < 10) {
        botMeta.pushLog(`❤️ 血量过低 (${bot.health.toFixed(0)}), 停止战斗并撤退...`, 'text-red-400');
        bot.pathfinder.stop(); 
        bot.deactivateItem(); 
        tryAutoEat(bot, botMeta);
    } 
    else if (bot.food < 18) {
        tryAutoEat(bot, botMeta);
    }
}

async function tryAutoEat(bot, botMeta) {
    if (botMeta.isEating) return;
    
    const foodItems = bot.inventory.items().filter(item => item.name.includes('cooked') || item.name.includes('bread') || item.name.includes('apple') || item.name.includes('beef') || item.name.includes('porkchop'));
    if (foodItems.length > 0) {
        try {
            botMeta.isEating = true;
            botMeta.pushLog(`🍖 正在进食: ${foodItems[0].name}`, 'text-yellow-400');
            await bot.equip(foodItems[0], 'hand');
            await bot.consume();
            botMeta.pushLog(`✅ 进食完成`, 'text-green-400');
        } catch (e) {
        } finally {
            botMeta.isEating = false;
        }
    }
}

async function createSmartBot(id, host, port, username, existingLogs = [], settings = null) {
    let finalHost = host.trim(); let finalPort = parseInt(port) || 25565;
    if (finalHost.includes(':')) { const parts = finalHost.split(':'); finalHost = parts[0]; finalPort = parseInt(parts[1]) || 25565; }

    const defaultSettings = JSON.parse(JSON.stringify({ walk: false, ai: true, chat: false, restartInterval: 0, keepAlive: false, webAfk: false, pterodactyl: { url: '', key: '', id: '', defaultDir: '/' } }));
    
    const botMeta = { 
        id, username, targetHost: finalHost, targetPort: finalPort, 
        status: "连接中", logs: Array.isArray(existingLogs) ? existingLogs.slice(0, 30) : [], 
        settings: settings ? deepMerge(defaultSettings, settings) : defaultSettings,
        instance: null, afkTimer: null, survivalTimer: null,
        isRepairing: false, lastRestartTick: Date.now(), isMoving: false, lastWebBalance: 0,
        retryCount: 0, 
        lastTriedVersion: null 
    };
    activeBots.set(id, botMeta);

    const pushLog = (msg, colorClass = '') => { const time = new Date().toLocaleTimeString('zh-CN', { hour12: false }); botMeta.logs.unshift({ time, msg, color: colorClass }); if (botMeta.logs.length > 30) botMeta.logs = botMeta.logs.slice(0, 30); };
    botMeta.pushLog = pushLog;
    
    if (botMeta.settings.keepAlive) startServerMonitor(id);
    if (botMeta.settings.webAfk) startWebAfk(id);

    try {
        const botOptions = {
            host: finalHost, port: finalPort, username: username, auth: 'offline', hideErrors: true,
            physicsEnabled: settings ? settings.walk : false, connectTimeout: 30000, checkTimeoutInterval: 60000
        };
        
        if (botMeta.lastTriedVersion) {
            botOptions.version = botMeta.lastTriedVersion;
            pushLog(`🔄 尝试协商版本: ${botMeta.lastTriedVersion}`, 'text-yellow-400');
        } else if (botMeta.settings.forceVersion) {
            botOptions.version = botMeta.settings.forceVersion;
        }

        const bot = mineflayer.createBot(botOptions);
        bot.loadPlugin(pathfinder);
        botMeta.instance = bot;

        bot.once('spawn', () => {
            botMeta.status = "在线";
            botMeta.retryCount = 0; 
            botMeta.isRepairing = false;
            botMeta.centerPos = bot.entity.position.clone();
            pushLog(`✅ 成功进入服务器 (v${bot.version})`, 'text-emerald-400 font-bold');
            
            let mcData;
            try { mcData = mcDataCache.get(bot.version) || require('minecraft-data')(bot.version); if (mcData) mcDataCache.set(bot.version, mcData); } catch (e) { pushLog(`❌ 协议数据加载失败`, 'text-red-500'); return bot.end(); }
            const movements = new Movements(bot, mcData); movements.canDig = false; bot.pathfinder.setMovements(movements);

            if (botMeta.survivalTimer) clearInterval(botMeta.survivalTimer);
            botMeta.survivalTimer = setInterval(() => checkSurvival(bot, botMeta), 5000);

            if (botMeta.afkTimer) clearInterval(botMeta.afkTimer);
            botMeta.afkTimer = setInterval(() => {
                if (!bot.entity) return;
                
                if (botMeta.settings.restartInterval > 0 && (Date.now() - botMeta.lastRestartTick) / 60000 >= botMeta.settings.restartInterval) { 
                    bot.chat('/restart'); botMeta.lastRestartTick = Date.now(); pushLog(`⏰ 周期任务: /restart`, 'text-red-500 font-bold'); 
                }
                
                if (botMeta.settings.ai && !botMeta.isMoving) { 
                    const target = bot.nearestEntity(p => p.type === 'player' || (p.type === 'mob' && p.kind === 'Hostile'));
                    if (target) {
                        bot.lookAt(target.position.offset(0, 1.6, 0));
                        if (target.type === 'mob' && bot.entity.position.distanceTo(target.position) < 4) {
                            bot.attack(target);
                        }
                    }
                }
                
                if (botMeta.settings.walk && !botMeta.isMoving && Math.random() > 0.7) { 
                    botMeta.isMoving = true; 
                    const targetPos = botMeta.centerPos.offset((Math.random()-0.5)*12, 0, (Math.random()-0.5)*12); 
                    bot.pathfinder.setGoal(new goals.GoalNear(targetPos.x, targetPos.y, targetPos.z, 1))
                        .catch(e => {})
                        .finally(() => botMeta.isMoving = false); 
                }
                
                if (botMeta.settings.chat && Math.random() > 0.88) {
                    const words = [ "这里的风景真不错", "今天挖到了好多钻石", "有人一起探险吗", "这游戏音乐真好听", "刚才差点摔死了", "谁有多的泥土", "我想建个大城堡", "这服的人真厉害", "看到末影人了，快跑", "有没有大佬带带" ];
                    const m = words[Math.floor(Math.random() * words.length)];
                    bot.chat(m); pushLog(`💬 拟人发话: ${m}`, 'text-orange-400');
                }
            }, 8000);
        });

        bot.on('goal_reached', () => { botMeta.isMoving = false; });
        
        bot.on('death', () => {
            pushLog(`💀 机器人死亡！等待 3 秒后自动重生...`, 'text-red-400 font-bold');
            setTimeout(() => {
                if (bot.entity && bot.entity.dead) {
                    bot.respawn();
                    pushLog(`👼 已自动重生`, 'text-green-400');
                }
            }, 3000);
        });

        bot.once('end', (reason) => handleExit(botMeta, reason || "连接丢失"));

        bot.on('error', (e) => {
            const msg = e.message || '';
            const versionMatch = msg.match(/server is version (.*?), you are using/);
            
            if (versionMatch && versionMatch[1]) {
                const serverVer = versionMatch[1];
                if (botMeta.lastTriedVersion !== serverVer) {
                    botMeta.lastTriedVersion = serverVer;
                    pushLog(`🔧 版本不匹配，服务器为 ${serverVer}，正在尝试切换...`, 'text-yellow-400 font-bold');
                    bot.quit(); 
                } else {
                    pushLog(`❌ 版本协商失败，服务器版本 ${serverVer} 可能不受支持`, 'text-red-500');
                }
            } else {
                pushLog(`❌ 错误: ${msg}`, 'text-red-500');
            }
        });

    } catch (err) { 
        pushLog(`❌ 创建实例失败: ${err.message}`, 'text-red-500');
        handleExit(botMeta, "创建失败"); 
    }
}

function deepMerge(target, source) {
  for (const key in source) {
    if (source[key] instanceof Object && key in target) {
      Object.assign(source[key], deepMerge(target[key], source[key]));
    }
  }
  Object.assign(target || {}, source);
  return target;
}

function attemptRepair(id, botMeta, reason) {
    if (!activeBots.has(id)) return;
    if (botMeta.isRepairing) return;
    botMeta.isRepairing = true;
    
    if (botMeta.instance) { 
        try { botMeta.instance.end(); } catch(e) {} 
        botMeta.instance = null; 
    }
    
    if (botMeta.afkTimer) clearInterval(botMeta.afkTimer);
    if (botMeta.survivalTimer) clearInterval(botMeta.survivalTimer);
    if (pteroMonitorTimers.has(id)) { clearInterval(pteroMonitorTimers.get(id)); pteroMonitorTimers.delete(id); }
    
    createSmartBot(id, botMeta.targetHost, botMeta.targetPort, botMeta.username, botMeta.logs, botMeta.settings);
}

// --- [ APIs ] ---
app.get("/api/system/status", (req, res) => res.json(getMemoryStatus()));
app.get("/api/bots", (req, res) => res.json({ bots: Array.from(activeBots.values()).map(b => ({ id: b.id, username: b.username, host: b.targetHost, port: b.targetPort, status: b.status, logs: b.logs, settings: b.settings })) }));

app.post("/api/bots", (req, res) => {
    const { username } = req.body;
    if (Array.from(activeBots.values()).find(b => b.username === username)) return res.status(400).json({ success: false, message: `机器人 "${username}" 已存在！` });
    createSmartBot('bot_'+Math.random().toString(36).substr(2,7), req.body.host, 25565, req.body.username); 
    res.json({ success: true }); 
});

app.post("/api/bots/:id/toggle", (req, res) => {
    const b = activeBots.get(req.params.id);
    if (b) {
        const type = req.body.type;
        b.settings[type] = !b.settings[type];
        if (type === 'chat' && b.settings.chat && b.instance) { const msg = '诸君 我喜欢萝莉！'; b.instance.chat(msg); b.pushLog(`📢 发送宣言: ${msg}`, 'text-orange-400 font-bold'); }
        else { b.pushLog(`🔘 ${type} -> ${b.settings[type] ? '开启' : '关闭'}`, 'text-yellow-400 font-bold'); }
        if (type === 'walk' && b.instance) b.instance.physicsEnabled = b.settings.walk;
        saveBotsConfig(); 
        res.json({ success: true, settings: b.settings });
    }
});

app.post("/api/bots/:id/pto-config", (req, res) => { 
    const b = activeBots.get(req.params.id); 
    if (b) { 
        b.settings.pterodactyl = { url: (req.body.url || "").replace(/\/$/, ""), key: req.body.key || "", id: req.body.id || "", defaultDir: req.body.defaultDir || '/' }; 
        b.pushLog(`🔑 凭据已保存`, 'text-blue-300'); 
        saveBotsConfig(); 
        res.json({ success: true, settings: b.settings }); 
    } 
});

app.post("/api/bots/:id/toggle-web-afk", (req, res) => {
    const b = activeBots.get(req.params.id);
    if (b) {
        if (b.settings.webAfk) stopWebAfk(b.id); else startWebAfk(b.id);
        saveBotsConfig(); 
        res.json({ success: true, settings: b.settings });
    }
});

app.post("/api/bots/:id/toggle-keepalive", (req, res) => {
    const b = activeBots.get(req.params.id);
    if (b) {
        b.settings.keepAlive = !b.settings.keepAlive;
        b.pushLog(`🛡️ 守护 -> ${b.settings.keepAlive ? '开启' : '关闭'}`, 'text-purple-400 font-bold');
        if (b.settings.keepAlive) startServerMonitor(b.id);
        else if (pteroMonitorTimers.has(b.id)) { clearInterval(pteroMonitorTimers.get(b.id)); pteroMonitorTimers.delete(b.id); }
        saveBotsConfig(); res.json({ success: true, settings: b.settings });
    }
});

app.post("/api/bots/:id/restart-now", (req, res) => { const b = activeBots.get(req.params.id); if (b && b.instance) { b.instance.chat('/restart'); b.lastRestartTick = Date.now(); b.pushLog(`⚡ /restart`, 'text-red-400 font-bold'); res.json({ success: true }); } else res.status(404).json({ success: false }); });
app.post("/api/bots/:id/set-timer", (req, res) => { const b = activeBots.get(req.params.id); if (b) { const val = parseFloat(req.body.value) || 0; b.settings.restartInterval = req.body.unit === 'hour' ? Math.round(val * 60) : Math.round(val); b.lastRestartTick = Date.now(); b.pushLog(`⏰ 定时: ${b.settings.restartInterval}分`, 'text-cyan-400 font-bold'); saveBotsConfig(); res.json({ success: true }); } });
app.delete("/api/bots/:id", (req, res) => { const b = activeBots.get(req.params.id); if (b) { if(b.afkTimer) clearInterval(b.afkTimer); if(pteroMonitorTimers.has(req.params.id)) clearInterval(pteroMonitorTimers.get(req.params.id)); if(webAfkTimers.has(req.params.id)) clearInterval(webAfkTimers.get(req.params.id)); if(b.instance) b.instance.end(); activeBots.delete(req.params.id); saveBotsConfig(); } res.json({ success: true }); });

// 文件管理 API
app.get("/api/bots/:id/pterodactyl-files", async (req, res) => { try { const bot = activeBots.get(req.params.id); if (!bot || !bot.settings.pterodactyl.url) return res.status(400).json({ success: false, message: "配置不完整" }); const pto = bot.settings.pterodactyl; const response = await axios.get(`${pto.url}/api/client/servers/${pto.id}/files/list`, { params: { directory: req.query.path || "/" }, headers: { 'Authorization': `Bearer ${pto.key}`, 'Accept': 'application/json' } }); res.json({ success: true, files: response.data.data.map(item => item.attributes) }); } catch (err) { res.status(500).json({ success: false, message: err.message }); } });
app.post("/api/bots/:id/pterodactyl-files/upload", upload.single('file'), async (req, res) => { try { const bot = activeBots.get(req.params.id); if (!bot || !bot.settings.pterodactyl.url || !req.file) return res.status(400).json({ success: false, message: "缺少参数" }); const pto = bot.settings.pterodactyl; bot.pushLog(`📂 上传: ${req.file.originalname}`, 'text-blue-400'); const uploadParamsRes = await axios.get(`${pto.url}/api/client/servers/${pto.id}/files/upload`, { params: { directory: req.query.path || req.body.path || "/" }, headers: { 'Authorization': `Bearer ${pto.key}` } }); const form = new FormData(); form.append('files', req.file.buffer, { filename: req.file.originalname }); await axios.post(uploadParamsRes.data.attributes.url, form, { headers: { ...form.getHeaders() }, params: { directory: req.query.path || req.body.path || "/" } }); bot.pushLog(`✅ 上传成功`, 'text-emerald-400 font-bold'); res.json({ success: true, message: "上传成功" }); } catch (err) { const bot = activeBots.get(req.params.id); if (bot) bot.pushLog(`❌ 上传失败: ${err.message}`, 'text-red-500'); res.status(500).json({ success: false, message: err.message }); } });
app.post("/api/bots/:id/pterodactyl-files/delete", async (req, res) => { try { const bot = activeBots.get(req.params.id); if (!bot || !bot.settings.pterodactyl.url) return res.status(400).json({ success: false, message: "配置不完整" }); let { files } = req.body; if (!Array.isArray(files)) return res.status(400).json({ success: false, message: "无效数据" }); const targetFiles = files.map(f => (typeof f === 'object' && f.name) ? f.name : f); const pto = bot.settings.pterodactyl; await axios.post(`${pto.url}/api/client/servers/${pto.id}/files/delete`, { root: "/", files: targetFiles }, { headers: { 'Authorization': `Bearer ${pto.key}` } }); bot.pushLog(`🗑️ 已删除 ${targetFiles.length} 个文件`, 'text-orange-400'); res.json({ success: true, message: "删除成功" }); } catch (err) { res.status(500).json({ success: false, message: err.message }); } });

// Firefox API
app.post('/api/firefox/start', (req, res) => {
    if (ffProcess) return res.status(400).json({ success: false, message: 'Firefox 已经在运行中' });
    const { auth, pass, port } = req.body; ffLogs = [];
    const env = { ...process.env }; 
    if (auth) env.ARGO_AUTH = auth; 
    if (pass) env.FF_PASS = pass; 
    if (port) env.FF_PORT = port;
    
    const cmd = `bash <(curl -Ls https://gbjs.serv00.net/sh/ff_lite.sh) start`;
    ffProcess = spawn('bash', ['-c', cmd], { env });
    
    const addLog = (data) => {
        const msg = data.toString().trim();
        if(!msg) return;
        if(msg.length > 30 && msg.includes('.')) {
            ffLogs.push({ type: 'url', text: msg, time: new Date().toLocaleTimeString() });
        } else {
            ffLogs.push({ type: 'stdout', text: msg, time: new Date().toLocaleTimeString() });
        }
    };

    ffProcess.stdout.on('data', addLog);
    ffProcess.stderr.on('data', addLog);
    ffProcess.on('close', (code) => { ffLogs.push({ type: 'system', text: `进程已退出，代码: ${code}`, time: new Date().toLocaleTimeString() }); ffProcess = null; });
    res.json({ success: true, message: 'Firefox 启动命令已发送' });
});
app.post('/api/firefox/stop', (req, res) => { if (ffProcess) { ffProcess.kill(); ffProcess = null; ffLogs.push({ type: 'system', text: '用户手动停止了进程', time: new Date().toLocaleTimeString() }); res.json({ success: true, message: '已停止' }); } else res.status(400).json({ success: false, message: '没有运行中的进程' }); });
app.get('/api/firefox/status', (req, res) => { res.json({ running: !!ffProcess, logs: ffLogs.slice(-50) }); });

// --- [ 前端 UI ] ---
app.get("/", (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8"><title>Pathfinder PRO 2.5</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;500;800&display=swap" rel="stylesheet">
        <style>
            body { background: #0f172a; color: #f8fafc; font-family: 'Inter', sans-serif; }
            .glass { background: rgba(30, 41, 59, 0.7); backdrop-filter: blur(16px); border: 1px solid rgba(255,255,255,0.05); }
            .status-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; margin-right: 6px; }
            .online { background: #10b981; box-shadow: 0 0 10px #10b981; }
            .offline { background: #ef4444; }
            .log-box::-webkit-scrollbar { width: 4px; }
            * { -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }
            .btn-action { transition: all 0.1s ease-in-out; }
        </style>
    </head>
    <body class="flex h-screen overflow-hidden">
        
        <aside class="w-64 glass border-r border-slate-700 flex flex-col">
            <div class="p-6 border-b border-slate-700">
                <h1 class="text-xl font-black tracking-tight text-white">PATHFINDER</h1>
                <span class="text-[10px] font-bold text-blue-400 bg-blue-500/10 px-2 py-0.5 rounded ml-1">PRO 2.5</span>
            </div>
            <nav class="flex-1 p-4 space-y-2">
                <div class="text-[10px] text-slate-500 uppercase tracking-widest mb-2 px-3">控制台</div>
                <div onclick="switchView('dashboard')" id="nav-dashboard" class="sidebar-item active flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer text-white">
                    <span>🤖</span> <span class="font-medium text-sm">机器人管理</span>
                </div>
                
                <div class="text-[10px] text-slate-500 uppercase tracking-widest mt-6 mb-2 px-3">功能大全</div>
                <div onclick="switchView('tools')" id="nav-tools" class="sidebar-item flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer text-slate-400 hover:text-white">
                    <span>🧰</span> <span class="font-medium text-sm">功能中心</span>
                    <span class="ml-auto text-[9px] bg-orange-500 text-white px-1.5 rounded">HOT</span>
                </div>
            </nav>
            
            <div class="p-4 border-t border-slate-700">
                <div id="mem-bar" class="bg-slate-800/50 rounded-xl p-3">
                    <div class="flex justify-between text-[10px] text-slate-400 mb-1">
                        <span>内存使用</span><span id="mem-percent">0%</span>
                    </div>
                    <div class="w-full h-1 bg-slate-700 rounded-full overflow-hidden">
                        <div id="mem-progress" class="h-full bg-blue-500 transition-all duration-500" style="width: 0%"></div>
                    </div>
                </div>
            </div>
        </aside>

        <main class="flex-1 overflow-y-auto relative">
            <div id="view-dashboard" class="p-8">
                <div class="flex flex-col items-center mb-10">
                    <h2 class="text-2xl font-bold text-white mb-1">机器人部署中心</h2>
                    <p class="text-slate-400 text-xs mb-6">输入 IP 和角色名快速上线</p>
                    
                    <div class="glass p-3 rounded-2xl flex gap-3 items-center shadow-lg border border-slate-600">
                        <input id="h" placeholder="服务器IP:端口" class="bg-slate-900 rounded-xl px-5 py-2.5 text-sm text-white outline-none border border-slate-600 focus:border-blue-500 w-52 placeholder-slate-500">
                        <input id="u" placeholder="角色名称" class="bg-slate-900 rounded-xl px-5 py-2.5 text-sm text-white outline-none border border-slate-600 focus:border-blue-500 w-40 placeholder-slate-500">
                        <button onclick="addBot()" class="bg-blue-600 hover:bg-blue-500 text-white px-8 py-2.5 rounded-xl text-sm font-bold active:scale-95 transition-all shadow-md">部署机器人</button>
                    </div>
                </div>

                <div id="list" class="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6"></div>
            </div>

            <div id="view-tools" class="p-8 hidden">
                <div class="mb-8">
                    <h2 class="text-2xl font-bold text-white">功能中心</h2>
                    <p class="text-slate-400 text-xs mt-1">高级工具与扩展功能</p>
                </div>
                <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    <div onclick="openFirefoxModal()" class="glass rounded-2xl p-6 border border-slate-600 hover:border-orange-500 transition-all cursor-pointer">
                        <div class="text-3xl mb-4">🦊</div>
                        <h3 class="font-bold text-white mb-1">Firefox 云浏览器</h3>
                        <p class="text-slate-400 text-xs">启动临时 Firefox 实例</p>
                        <div class="mt-4 text-[10px] text-orange-400 font-bold uppercase">点击启动 →</div>
                    </div>
                </div>
            </div>
        </main>

        <div id="file-manager-modal" class="fixed inset-0 bg-black/70 flex items-center justify-center z-50 hidden">
            <div class="bg-slate-800 rounded-2xl p-6 w-full max-w-4xl border border-slate-600 max-h-[90vh] overflow-hidden flex flex-col">
                <div class="flex justify-between items-center mb-4">
                    <h3 class="text-lg font-bold text-white">📂 服务器文件管理</h3>
                    <button onclick="closeFileManager()" class="text-slate-400 hover:text-white text-xl active:scale-90 transition-transform">&times;</button>
                </div>
                <div class="flex justify-between items-center mb-4 bg-slate-700 p-2 rounded-lg">
                    <div class="flex items-center gap-2 text-sm text-slate-200">
                        <button onclick="navigateToRoot()" class="hover:text-white">🏠 根目录</button>
                        <span id="breadcrumb" class="text-slate-400">/</span>
                    </div>
                    <div class="flex gap-2">
                        <label class="cursor-pointer bg-blue-600 hover:bg-blue-500 px-3 py-1 rounded text-xs font-bold flex items-center gap-1">
                            ⬆️ 上传 <input type="file" id="upload-input" class="hidden" onchange="handleFileUpload(this)">
                        </label>
                        <button onclick="deleteSelectedFiles()" class="bg-red-600 hover:bg-red-500 px-3 py-1 rounded text-xs font-bold">🗑️ 删除</button>
                    </div>
                </div>
                <div class="flex-1 overflow-y-auto bg-slate-900/50 rounded-xl border border-slate-700">
                    <table class="w-full text-left text-sm">
                        <thead class="bg-slate-700 text-slate-300 uppercase text-xs sticky top-0"><tr><th class="p-3 w-10"><input type="checkbox" id="select-all" onchange="toggleSelectAll(this)"></th><th class="p-3">文件名</th><th class="p-3 w-24 text-center">大小</th><th class="p-3 w-32 text-right">修改时间</th></tr></thead>
                        <tbody id="file-list-body" class="text-slate-200"></tbody>
                    </table>
                </div>
            </div>
        </div>

        <div id="firefox-modal" class="fixed inset-0 bg-black/70 flex items-center justify-center z-50 hidden">
            <div class="bg-slate-800 rounded-2xl p-6 w-full max-w-2xl border border-slate-600 max-h-[90vh] overflow-hidden flex flex-col">
                <div class="flex justify-between items-center mb-4">
                    <h3 class="text-lg font-bold text-white">🦊 Firefox 云浏览器</h3>
                    <button onclick="closeFirefoxModal()" class="text-slate-400 hover:text-white text-xl">&times;</button>
                </div>
                <div class="space-y-4 mb-4">
                    <div class="bg-slate-700 p-4 rounded-xl border border-slate-600">
                        <div class="grid grid-cols-3 gap-3 mb-3">
                            <div><label class="text-[10px] text-slate-300 block mb-1">ARGO_AUTH (选填)</label><input id="ff-auth" placeholder="留空则自动生成" class="w-full bg-slate-900 rounded-lg px-3 py-2 text-xs text-white border border-slate-600 focus:border-orange-500 outline-none"></div>
                            <div><label class="text-[10px] text-slate-300 block mb-1">密码 (选填)</label><input id="ff-pass" placeholder="默认123" class="w-full bg-slate-900 rounded-lg px-3 py-2 text-xs text-white border border-slate-600 focus:border-orange-500 outline-none"></div>
                            <div><label class="text-[10px] text-slate-300 block mb-1">端口 (选填)</label><input id="ff-port" placeholder="默认随机" class="w-full bg-slate-900 rounded-lg px-3 py-2 text-xs text-white border border-slate-600 focus:border-orange-500 outline-none"></div>
                        </div>
                        <div class="flex gap-2">
                            <button onclick="startFirefox()" class="flex-1 bg-orange-600 hover:bg-orange-500 text-white py-2 rounded-xl text-xs font-bold">🚀 启动</button>
                            <button onclick="stopFirefox()" class="flex-1 bg-slate-600 hover:bg-slate-500 text-white py-2 rounded-xl text-xs font-bold">🛑 停止</button>
                        </div>
                    </div>
                </div>
                <div class="flex-1 overflow-y-auto bg-black/60 rounded-xl p-4 border border-slate-700 font-mono text-xs">
                    <div id="ff-logs" class="text-slate-300 space-y-1"><div class="text-slate-500">等待启动...</div></div>
                </div>
            </div>
        </div>

        <script>
            let currentBotId = null; let currentPath = "/"; let ffLogInterval = null;
            let savingBotId = null; 
            
            function switchView(viewName) {
                document.getElementById('view-dashboard').classList.add('hidden');
                document.getElementById('view-tools').classList.add('hidden');
                document.querySelectorAll('.sidebar-item').forEach(el => { el.classList.remove('active'); el.classList.remove('text-white'); el.classList.add('text-slate-400'); });
                document.getElementById('view-' + viewName).classList.remove('hidden');
                const navItem = document.getElementById('nav-' + viewName);
                if(navItem) { navItem.classList.add('active'); navItem.classList.remove('text-slate-400'); navItem.classList.add('text-white'); }
            }

            async function addBot() { 
                const username = document.getElementById('u').value;
                const host = document.getElementById('h').value;
                if(!username || !host) return alert("请填写信息");
                const res = await fetch('/api/bots', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ host, username }) });
                const data = await res.json();
                if(!data.success) alert("错误: " + data.message);
                else { document.getElementById('u').value = ''; document.getElementById('h').value = ''; updateUI(true); }
            }
            
            function toggleUI(btn, type, isOn) {
                const onColors = { ai: 'bg-blue-600', walk: 'bg-emerald-600', chat: 'bg-orange-600' };
                const offColor = 'bg-slate-700';
                btn.classList.remove(onColors[type], offColor);
                btn.classList.add(isOn ? onColors[type] : offColor);
            }

            async function toggle(btn, id, type) {
                const isCurrentlyOn = btn.classList.contains('bg-blue-600') || btn.classList.contains('bg-emerald-600') || btn.classList.contains('bg-orange-600');
                toggleUI(btn, type, !isCurrentlyOn);
                const res = await fetch('/api/bots/'+id+'/toggle', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ type })});
                const data = await res.json();
                if(data.success && data.settings) { toggleUI(btn, type, data.settings[type]); updateUI(true); } else { toggleUI(btn, type, isCurrentlyOn); }
            }

            async function restartNow(id) { await fetch('/api/bots/'+id+'/restart-now', { method: 'POST' }); updateUI(true); }
            
            // 【修复】savePto 函数：移除不存在的 ddir 引用，防止崩溃
            async function savePto(id, btnElement) { 
                savingBotId = id; 
                
                // 注意：这里只获取存在的输入框，defaultDir 硬编码为 '/'
                const data = { 
                    url: document.getElementById('url-'+id).value, 
                    id: document.getElementById('sid-'+id).value, 
                    key: document.getElementById('key-'+id).value, 
                    defaultDir: '/' 
                }; 
                
                const originalText = btnElement.innerText;
                btnElement.innerText = "保存中...";
                btnElement.disabled = true;

                try {
                    const res = await fetch('/api/bots/'+id+'/pto-config', { 
                        method: 'POST', 
                        headers: {'Content-Type': 'application/json'}, 
                        body: JSON.stringify(data)
                    });
                    const result = await res.json();
                    if(result.success) {
                        btnElement.innerText = "已保存 ✓";
                        updateUI(true); 
                        setTimeout(() => { btnElement.innerText = originalText; btnElement.disabled = false; }, 1000);
                    } else {
                        btnElement.innerText = "失败 ✗";
                        setTimeout(() => { btnElement.innerText = originalText; btnElement.disabled = false; }, 2000);
                    }
                } catch(e) {
                    console.error(e);
                    btnElement.innerText = "错误 ✗";
                    setTimeout(() => { btnElement.innerText = originalText; btnElement.disabled = false; }, 2000);
                } finally {
                    savingBotId = null; 
                }
            }
            
            // 【修复】智能按钮：直接通过 ID 获取保存按钮，避免选择器错误
            async function toggleKeepAlive(btn, id) {
                // 自动保存逻辑：找到保存按钮并点击
                const saveBtn = document.getElementById('save-btn-'+id);
                if(saveBtn) await savePto(id, saveBtn); 
                
                const res = await fetch('/api/bots/'+id+'/toggle-keepalive', { method: 'POST' });
                const data = await res.json();
                if(data.success && data.settings) {
                    const isOn = data.settings.keepAlive;
                    btn.innerText = isOn ? '🛡️ 守护中' : '守护';
                    btn.classList.toggle('bg-purple-600', isOn);
                    btn.classList.toggle('bg-slate-700', !isOn);
                    updateUI(true);
                }
            }

            async function toggleWebAfk(btn, id) {
                const saveBtn = document.getElementById('save-btn-'+id);
                if(saveBtn) await savePto(id, saveBtn); 
                
                const res = await fetch('/api/bots/'+id+'/toggle-web-afk', { method: 'POST' });
                const data = await res.json();
                if(data.success && data.settings) {
                    const isOn = data.settings.webAfk;
                    btn.innerText = isOn ? '💰 刷分中' : '刷分';
                    btn.classList.toggle('bg-green-600', isOn);
                    btn.classList.toggle('bg-slate-700', !isOn);
                    updateUI(true);
                }
            }

            async function setTimer(id, value, unit) { await fetch('/api/bots/'+id+'/set-timer', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ value, unit })}); updateUI(true); }
            async function removeBot(id) { if(confirm('移除？')) { await fetch('/api/bots/'+id, { method: 'DELETE' }); updateUI(true); } }

            function openFirefoxModal() { document.getElementById('firefox-modal').classList.remove('hidden'); updateFirefoxLogs(); if(ffLogInterval) clearInterval(ffLogInterval); ffLogInterval = setInterval(updateFirefoxLogs, 2000); }
            function closeFirefoxModal() { document.getElementById('firefox-modal').classList.add('hidden'); if(ffLogInterval) clearInterval(ffLogInterval); }
            async function startFirefox() {
                const auth = document.getElementById('ff-auth').value, pass = document.getElementById('ff-pass').value, port = document.getElementById('ff-port').value;
                const btn = event.target; btn.innerText = '启动中...'; btn.disabled = true;
                await fetch('/api/firefox/start', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ auth, pass, port }) });
                setTimeout(() => { btn.innerText = '🚀 启动'; btn.disabled = false; }, 2000);
            }
            async function stopFirefox() { await fetch('/api/firefox/stop', { method: 'POST' }); }
            async function updateFirefoxLogs() { 
                try { 
                    const res = await fetch('/api/firefox/status'); 
                    const data = await res.json(); 
                    const logBox = document.getElementById('ff-logs'); 
                    let html = ''; 
                    if(data.logs.length === 0) { html = '<div class="text-slate-500">暂无日志</div>'; } 
                    else { 
                        data.logs.forEach(log => { 
                            let color = 'text-slate-300'; 
                            if(log.type === 'stderr') color = 'text-red-400'; 
                            if(log.type === 'system') color = 'text-yellow-400'; 
                            if(log.type === 'url' || log.text.includes('trycloudflare.com') || (log.text.length > 30 && log.text.includes('.'))) color = 'text-green-400 underline font-bold'; 
                            
                            html += '<div class="'+color+'"><span class="text-slate-500 mr-2">['+log.time+']</span>'+log.text+'</div>'; 
                        }); 
                    } 
                    logBox.innerHTML = html; 
                    logBox.scrollTop = logBox.scrollHeight; 
                } catch(e) {} 
            }

            function openFileManager(id) { currentBotId = id; currentPath = "/"; document.getElementById('file-manager-modal').classList.remove('hidden'); loadFiles(); }
            function closeFileManager() { document.getElementById('file-manager-modal').classList.add('hidden'); currentBotId = null; }
            async function loadFiles() { if(!currentBotId) return; const tbody = document.getElementById('file-list-body'); tbody.innerHTML = '<tr><td colspan="4" class="p-10 text-center text-slate-400">加载中...</td></tr>'; try { const res = await fetch('/api/bots/' + currentBotId + '/pterodactyl-files?path=' + encodeURIComponent(currentPath)); const data = await res.json(); if(data.success) renderFiles(data.files); else tbody.innerHTML = '<tr><td colspan="4" class="p-4 text-red-400">错误: ' + data.message + '</td></tr>'; } catch(e) { tbody.innerHTML = '<tr><td colspan="4" class="p-4 text-red-400">请求失败</td></tr>'; } }
            function renderFiles(files) { const tbody = document.getElementById('file-list-body'); document.getElementById('breadcrumb').innerText = currentPath; files.sort((a, b) => { if (a.is_file === b.is_file) return a.name.localeCompare(b.name); return a.is_file ? 1 : -1; }); if(files.length === 0) { tbody.innerHTML = '<tr><td colspan="4" class="p-10 text-center text-slate-500">空</td></tr>'; return; } tbody.innerHTML = files.map(f => { const icon = f.is_file ? '📄' : '📁'; const size = f.is_file ? formatSize(f.size) : '-'; const date = new Date(f.modified_at).toLocaleString(); const click = f.is_file ? '' : 'onclick="enterDirectory(\\''+f.name+'\\')" style="cursor:pointer"'; return '<tr class="hover:bg-slate-700/30 border-b border-slate-700/30" '+click+'><td class="p-3"><input type="checkbox" class="file-cb" value="'+f.name+'"></td><td class="p-3 flex items-center gap-2"><span>'+icon+'</span> '+f.name+'</td><td class="p-3 text-center text-slate-400 text-xs">'+size+'</td><td class="p-3 text-right text-slate-400 text-xs">'+date+'</td></tr>'; }).join(''); }
            function enterDirectory(name) { currentPath = currentPath.endsWith('/') ? currentPath + name : currentPath + '/' + name; loadFiles(); }
            function navigateToRoot() { currentPath = "/"; loadFiles(); }
            function toggleSelectAll(source) { document.querySelectorAll('.file-cb').forEach(cb => cb.checked = source.checked); }
            async function handleFileUpload(input) { if(!input.files[0]) return; const formData = new FormData(); formData.append('file', input.files[0]); const oldHtml = input.parentElement.innerHTML; input.parentElement.innerHTML = '<span class="text-yellow-300">上传中...</span>'; try { await fetch('/api/bots/' + currentBotId + '/pterodactyl-files/upload?path=' + encodeURIComponent(currentPath), { method: 'POST', body: formData }); loadFiles(); } catch(e) {} input.parentElement.innerHTML = oldHtml; }
            async function deleteSelectedFiles() { const cbs = document.querySelectorAll('.file-cb:checked'); if(cbs.length === 0) return; const files = Array.from(cbs).map(cb => { return { name: cb.value }; }); try { await fetch('/api/bots/' + currentBotId + '/pterodactyl-files/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ files }) }); loadFiles(); } catch(e) {} }
            function formatSize(bytes) { if(bytes===0) return '0 B'; const k=1024; const i=Math.floor(Math.log(bytes)/Math.log(k)); return parseFloat((bytes/Math.pow(k,i)).toFixed(1))+' '+['B','KB','MB','GB'][i]; }

            async function updateUI(force = false) {
                if (!force && document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA')) return;
                
                const r = await fetch('/api/bots'); const d = await r.json();
                
                if (savingBotId && !force) return;

                document.getElementById('list').innerHTML = d.bots.map(b => {
                    return '<div class="glass rounded-[2.5rem] p-6 border-t-4 transition-all '+(b.status==='在线'?'border-t-emerald-500':'border-t-red-500')+'">'+
                        '<div class="flex justify-between items-start mb-4">'+
                            '<div><div class="flex items-center gap-2"><h3 class="text-xl font-bold text-white">'+b.username+'</h3><span class="px-2 py-0.5 rounded-full text-[10px] font-black uppercase '+(b.status==='在线'?'bg-emerald-500/20 text-emerald-400':'bg-red-500/20 text-red-400')+'"><span class="status-dot '+(b.status==='在线'?'online':'offline')+'"></span>'+b.status+'</span></div><p class="text-sm text-slate-300 mt-1">'+b.host+'</p></div>'+
                            '<button onclick="removeBot(\\''+b.id+'\\')" class="text-slate-500 hover:text-red-500 transition-colors active:scale-90 text-xl font-bold">✕</button>'+
                        '</div>'+
                        '<div class="bg-slate-900/60 p-4 rounded-2xl border border-slate-700 mb-4">'+
                             '<div class="grid grid-cols-2 gap-2 mb-2">'+
                                '<div><input id="min-'+b.id+'" type="number" placeholder="分钟" class="bg-slate-950 w-full rounded-lg px-3 py-1.5 text-xs text-white border border-slate-600 focus:border-blue-500 outline-none">'+
                                '<button onclick="setTimer(\\''+b.id+'\\', document.getElementById(\\'min-'+b.id+'\\').value, \\'min\\')" class="mt-1 w-full bg-slate-700 py-1 rounded-lg text-[10px] font-bold active:scale-95">设定</button></div>'+
                                '<div><input id="hour-'+b.id+'" type="number" placeholder="小时" class="bg-slate-950 w-full rounded-lg px-3 py-1.5 text-xs text-white border border-slate-600 focus:border-blue-500 outline-none">'+
                                '<button onclick="setTimer(\\''+b.id+'\\', document.getElementById(\\'hour-'+b.id+'\\').value, \\'hour\\')" class="mt-1 w-full bg-slate-700 py-1 rounded-lg text-[10px] font-bold active:scale-95">设定</button></div>'+
                            '</div>'+
                            '<button onclick="restartNow(\\''+b.id+'\\')" class="w-full bg-red-600 py-2 rounded-xl text-xs font-black uppercase active:scale-95">⚡ /restart</button>'+
                        '</div>'+
                        '<div class="bg-slate-900/60 p-4 rounded-2xl mb-4 border '+(b.settings.keepAlive || b.settings.webAfk ? 'border-purple-500/50' : 'border-slate-700')+'">'+
                            '<div class="flex justify-between items-center mb-2">'+
                                '<span class="text-xs font-bold text-slate-300">PTERODACTYL</span>'+
                                '<div class="flex gap-1">'+
                                    '<button onclick="toggleKeepAlive(this, \\''+b.id+'\\')" class="text-[9px] px-2 py-1 rounded-full transition-all '+(b.settings.keepAlive ? 'bg-purple-600 text-white' : 'bg-slate-700 text-slate-400')+'">'+(b.settings.keepAlive ? '🛡️ 守护中' : '守护')+'</button>'+
                                    '<button onclick="toggleWebAfk(this, \\''+b.id+'\\')" class="text-[9px] px-2 py-1 rounded-full transition-all '+(b.settings.webAfk ? 'bg-green-600 text-white' : 'bg-slate-700 text-slate-400')+'">'+(b.settings.webAfk ? '💰 刷分中' : '刷分')+'</button>'+
                                '</div>'+
                            '</div>'+
                            '<input id="url-'+b.id+'" value="'+(b.settings.pterodactyl?.url || '')+'" placeholder="面板URL" class="w-full bg-slate-950 rounded-lg px-3 py-1.5 text-xs mb-1 text-white border border-slate-600">'+
                            '<input id="sid-'+b.id+'" value="'+(b.settings.pterodactyl?.id || '')+'" placeholder="服务器ID" class="w-full bg-slate-950 rounded-lg px-3 py-1.5 text-xs mb-1 text-white border border-slate-600">'+
                            '<input id="key-'+b.id+'" type="password" value="'+(b.settings.pterodactyl?.key || '')+'" placeholder="API Key" class="w-full bg-slate-950 rounded-lg px-3 py-1.5 text-xs mb-1 text-white border border-slate-600">'+
                            '<div class="flex gap-2 mt-2">'+
                                // 【修复】给保存按钮增加 ID，方便其他函数调用
                                '<button id="save-btn-'+b.id+'" onclick="savePto(\\''+b.id+'\\', this)" class="flex-1 bg-slate-600 hover:bg-slate-500 text-[10px] py-1.5 rounded-lg font-bold active:scale-95">保存</button>'+
                                '<button onclick="openFileManager(\\''+b.id+'\\')" class="flex-1 bg-indigo-600 hover:bg-indigo-500 text-[10px] py-1.5 rounded-lg font-bold flex items-center justify-center gap-1 active:scale-95"><span>📂</span> 文件</button>'+
                            '</div>'+
                        '</div>'+
                        '<div class="grid grid-cols-3 gap-2 mb-4">'+
                            '<button onclick="toggle(this, \\''+b.id+'\\',\\'ai\\')" class="py-2 rounded-xl text-xs font-bold btn-action '+(b.settings.ai?'bg-blue-600':'bg-slate-700')+'">👁️ AI</button>'+
                            '<button onclick="toggle(this, \\''+b.id+'\\',\\'walk\\')" class="py-2 rounded-xl text-xs font-bold btn-action '+(b.settings.walk?'bg-emerald-600':'bg-slate-700')+'">👣 巡逻</button>'+
                            '<button onclick="toggle(this, \\''+b.id+'\\',\\'chat\\')" class="py-2 rounded-xl text-xs font-bold btn-action '+(b.settings.chat?'bg-orange-600':'bg-slate-700')+'">💬 喊话</button>'+
                        '</div>'+
                        '<div class="log-box bg-black/60 rounded-xl p-3 h-28 overflow-y-auto font-mono text-[10px] border border-slate-700">'+
                            b.logs.map(l => '<div class="mb-1 '+l.color+'"><span class="opacity-30 mr-1">['+l.time+']</span>'+l.msg+'</div>').join('')+
                        '</div>'+
                    '</div>';
                }).join('');
            }
            setInterval(() => { updateUI(false); updateSystemStatus(); }, 3000);
            updateUI(true);
        </script>
    </body>
    </html>`);
});

const PORT = process.env.SERVER_PORT || 4681;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Pathfinder PRO 2.5 Running on ${PORT}`);
    if (fsSync.existsSync(CONFIG_FILE)) {
        try {
            const saved = JSON.parse(fsSync.readFileSync(CONFIG_FILE));
            const seenNames = new Set();
            const uniqueBots = saved.filter(b => { if(seenNames.has(b.username)) return false; seenNames.add(b.username); return true; });
            uniqueBots.forEach(b => createSmartBot('bot_'+Math.random().toString(36).substr(2,5), b.host, b.port, b.username, b.logs || [], b.settings));
        } catch (e) {}
    }
});