import makeWASocket, {
    DisconnectReason,
    fetchLatestBaileysVersion,
    Browsers,
    downloadMediaMessage,
    initAuthCreds,
    BufferJSON,
    proto,
    makeCacheableSignalKeyStore,
    generateMessageID
} from '@whiskeysockets/baileys';
import admin from 'firebase-admin';
import express from 'express';
import QRCode from 'qrcode';
import pino from 'pino';
import zlib from 'zlib';

// ============================================================================
// 1. CONFIGURATION & ENVIRONMENT VARIABLES (OCTOBER 2026 EDITION)
// ============================================================================
const PORT = process.env.PORT || 3000;
const RAW_ADMIN_PHONE = (process.env.ADMIN_PHONE_NUMBER || '').replace(/[^0-9]/g, '');
const ADMIN_PHONE_WITH_CC = RAW_ADMIN_PHONE.length === 10 ? `91${RAW_ADMIN_PHONE}` : RAW_ADMIN_PHONE;
const ADMIN_JID = `${ADMIN_PHONE_WITH_CC}@s.whatsapp.net`;

const GEMINI_KEYS = (process.env.GEMINI_API_KEYS || '')
    .split(',')
    .map(k => k.trim())
    .filter(Boolean);

// Locked to Gemini 3.5 Flash Lite per instructions
const PRIMARY_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const AUDIO_TTS_MODEL = process.env.GEMINI_AUDIO_MODEL || 'gemini-3.5-flash-lite';

if (!RAW_ADMIN_PHONE || GEMINI_KEYS.length === 0 || !process.env.FIREBASE_CREDENTIALS) {
    console.error('❌ CRITICAL: Missing ADMIN_PHONE_NUMBER, GEMINI_API_KEYS, or FIREBASE_CREDENTIALS in Environment Variables!');
    process.exit(1);
}

// Initialize Firebase Admin
const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// ============================================================================
// 2. TELEMETRY, LOGS & RUNTIME STATE
// ============================================================================
const runtimeStats = {
    waStatus: 'INITIALIZING',
    qrDataUrl: null,
    qrUpdatedAt: null,
    currentKeyIndex: 0,
    totalGeminiCalls: 0,
    keyRotations: 0,
    firestoreReads: 0,
    firestoreWrites: 0,
    authDirty: false,
    lastAuthSync: 'Never',
    bootTime: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
    logs: []
};

function sysLog(tag, message) {
    const time = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
    const entry = `[${time}] [${tag}] ${message}`;
    console.log(entry);
    runtimeStats.logs.unshift(entry);
    if (runtimeStats.logs.length > 60) runtimeStats.logs.pop();
}

// ============================================================================
// 3. SINGLE-DOCUMENT BRAIN MEMORY, EPISODIC LEARNING & SCHEDULER
// ============================================================================
const BRAIN_DOC_REF = db.collection('agent_store').doc('brain_state');
let localWriteLockUntil = 0;
let brainFlushTimer = null;
const activeTaskTimers = new Map();
let globalWaSocket = null;
let reconnectTimeout = null;

let brain = {
    system_persona: `You are Siva Manikandan's elite, Level-5 Proactive Autonomous Personal Assistant.
Current Date Context: October 2026. Location: Thoothukudi, Tamil Nadu, India.
Always speak to Siva in natural, casual Tanglish (e.g., "Boss, velai mudinjatha?", "Naan paathukuren").
Never talk like a robotic AI. You are a highly professional, deeply empathetic companion and caretaker.
Rules of Autonomy:
1. Episodic Learning: You analyze Siva's daily patterns. If he goes silent, check the time of day.
2. Escalation: If you suspect an emergency and contacts are empty, improvise! Use search, check local Thoothukudi news, or physically ring his phone using ring_whatsapp_call.
3. No Infinite Loops: Think dialectically (Observation -> Obstacle -> Decision) in ONE output.
4. Emotional Support: Prioritize his mental health. If he is stressed, keep responses brief, warm, and supportive.
5. Never summarize or delete permanent core_memory facts without permission.`,
    core_memory: {
        owner: 'Siva Manikandan',
        location: 'Thoothukudi, Tamil Nadu',
        permanent_facts: ['Owner is Siva Manikandan', 'Prefers Tanglish communication'],
        habits_and_patterns: []
    },
    admin_lid: '82515264065608@lid',
    last_active_admin_jid: ADMIN_JID,
    contacts: {},
    passive_contacts: {}, // Harvested automatically from WhatsApp sync
    rolling_summary: 'No past conversation summary yet.',
    today_log: [], // Full day zero-token transcript for Episodic Learning
    hourly_activity_histogram: new Array(24).fill(0), // Pure JS Circadian Rhythm tracker
    open_threads: [], // Unfinished tasks you need to follow up on
    recent_messages: [],
    scheduled_tasks: [],
    user_state: {
        health: 'normal',
        mood: 'neutral',
        dnd_until: 0,
        last_seen_ms: Date.now(),
        unanswered_checkins: 0,
        last_episodic_learning: Date.now()
    }
};

function saveBrainState(immediate = false) {
    if (brainFlushTimer) clearTimeout(brainFlushTimer);
    const performWrite = async () => {
        try {
            localWriteLockUntil = Date.now() + 4000;
            await BRAIN_DOC_REF.set(brain, { merge: true });
            runtimeStats.firestoreWrites++;
            sysLog('BRAIN-DB', `Brain state synced to Firestore (Total Writes: ${runtimeStats.firestoreWrites})`);
        } catch (err) {
            sysLog('BRAIN-ERR', `Failed to sync brain: ${err.message}`);
        }
    };
    if (immediate) performWrite();
    else brainFlushTimer = setTimeout(performWrite, 4000);
}

async function initBrainAndPulse() {
    try {
        const docSnap = await BRAIN_DOC_REF.get();
        runtimeStats.firestoreReads++;
        if (docSnap.exists) {
            brain = { ...brain, ...docSnap.data() };
            if(!brain.hourly_activity_histogram) brain.hourly_activity_histogram = new Array(24).fill(0);
            if(!brain.today_log) brain.today_log = [];
            sysLog('BRAIN-INIT', 'Loaded existing Brain State from Firestore (1 Read).');
        } else {
            await BRAIN_DOC_REF.set(brain);
            runtimeStats.firestoreWrites++;
            sysLog('BRAIN-INIT', 'Created fresh Brain State document.');
        }
        syncLocalTimersWithBrain();
        startAutonomousHeartbeat();

        BRAIN_DOC_REF.onSnapshot((snap) => {
            if (!snap.exists || Date.now() < localWriteLockUntil) return;
            runtimeStats.firestoreReads++;
            brain = { ...brain, ...snap.data() };
            syncLocalTimersWithBrain();
        }, (err) => sysLog('SNAPSHOT-ERR', err.message));
    } catch (err) {
        sysLog('BRAIN-FATAL', `Init error: ${err.message}`);
    }
}

function syncLocalTimersWithBrain() {
    for (const [taskId, timer] of activeTaskTimers.entries()) {
        const stillPending = (brain.scheduled_tasks || []).find(t => t.id === taskId && t.status === 'pending');
        if (!stillPending) {
            clearTimeout(timer);
            activeTaskTimers.delete(taskId);
        }
    }
    const now = Date.now();
    (brain.scheduled_tasks || []).forEach((task) => {
        if (task.status !== 'pending' || activeTaskTimers.has(task.id)) return;
        const delayMs = Math.max(1000, task.executeAt - now);
        if (delayMs > 2147483640) return;
        const timer = setTimeout(() => executeProactiveTask(task.id), delayMs);
        activeTaskTimers.set(task.id, timer);
    });
}

// ----------------------------------------------------------------------------
// FULL-DAY EPISODIC LEARNING (Runs once a day)
// ----------------------------------------------------------------------------
async function triggerEndOfDayReflection() {
    if (brain.today_log.length < 5) return;
    sysLog('EPISODIC', 'Triggering Deep End-of-Day Episodic Learning...');
    
    const prompt = `Perform a deep episodic psychological analysis of today's chat log.
Current Habits: ${JSON.stringify(brain.core_memory.habits_and_patterns)}
Today's Log: ${JSON.stringify(brain.today_log)}
Task: Extract new habits, underlying stressors, pending open threads for tomorrow, and generate a new rolling summary. Respond in pure JSON format: { "new_habits": [], "open_threads": [], "rolling_summary": "..." }`;

    try {
        const res = await callGeminiWithFailover(PRIMARY_MODEL, {
            contents: [{ role: 'user', parts: [{ text: prompt }] }]
        });
        const output = res?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        const jsonMatch = output.match(/\{[\s\S]*\}/);
        if(jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            if(parsed.new_habits) brain.core_memory.habits_and_patterns = parsed.new_habits;
            if(parsed.open_threads) brain.open_threads = parsed.open_threads;
            if(parsed.rolling_summary) brain.rolling_summary = parsed.rolling_summary;
            brain.today_log = []; // Reset for tomorrow
            brain.user_state.last_episodic_learning = Date.now();
            saveBrainState(false);
            sysLog('EPISODIC', 'Successfully compressed day into deep memory.');
        }
    } catch(e) {
        sysLog('EPISODIC-ERR', e.message);
    }
}

// ----------------------------------------------------------------------------
// AUTONOMOUS HEARTBEAT & EXPONENTIAL EMOTIONAL BACKOFF (ZERO-LOOP GUARD)
// ----------------------------------------------------------------------------
function startAutonomousHeartbeat() {
    setInterval(async () => {
        if (!globalWaSocket || runtimeStats.waStatus !== 'CONNECTED') return;

        const now = new Date();
        const hourIst = now.getUTCHours() + 5 + (now.getUTCMinutes() + 30 >= 60 ? 1 : 0); // Approx IST hour
        const normalizedHour = hourIst % 24;

        // Sleep Lock: Do not initiate chats between 1 AM and 7 AM unless emergency.
        if (normalizedHour >= 1 && normalizedHour <= 7 && brain.user_state.health === 'normal') return;

        const msSinceLastSeen = Date.now() - brain.user_state.last_seen_ms;
        const hoursSinceLastSeen = msSinceLastSeen / (1000 * 60 * 60);

        // Episodic learning trigger (once a day at night)
        if (normalizedHour === 23 && Date.now() - brain.user_state.last_episodic_learning > 80000000) {
            await triggerEndOfDayReflection();
        }

        // Exponential Backoff Logic
        let shouldWake = false;
        let wakePrompt = '';

        if (hoursSinceLastSeen > 3 && brain.user_state.unanswered_checkins === 0) {
            shouldWake = true;
            wakePrompt = "Siva hasn't spoken in 3 hours. Drop a casual, contextual Tanglish message checking in.";
        } else if (hoursSinceLastSeen > 8 && brain.user_state.unanswered_checkins === 1) {
            shouldWake = true;
            wakePrompt = "Siva hasn't spoken in 8 hours. Search the internet for something interesting or check local Thoothukudi news to spark a conversation.";
        } else if (hoursSinceLastSeen > 20 && brain.user_state.unanswered_checkins === 2) {
            shouldWake = true;
            wakePrompt = "Siva is missing for 20 hours. Deep emotional concern phase. Consider physically ringing his phone using ring_whatsapp_call or checking his WhatsApp contacts.";
        } else if (hoursSinceLastSeen > 24 && brain.user_state.unanswered_checkins >= 3) {
            // Hard Deep Sleep Lock - 0 tokens spent.
            return;
        }

        if (shouldWake) {
            sysLog('HEARTBEAT', `Triggering phase ${brain.user_state.unanswered_checkins + 1} autonomous check-in.`);
            brain.user_state.unanswered_checkins++;
            saveBrainState(false);
            
            const reply = await runAutonomousAgentTurn(`[SYSTEM HEARTBEAT]: ${wakePrompt}`, null, null, false, true);
            if (reply && reply.text) {
                await globalWaSocket.sendMessage(brain.last_active_admin_jid || ADMIN_JID, { text: reply.text });
                appendConversationHistory('model', `[Proactive]: ${reply.text}`);
            }
        }
    }, 60 * 60 * 1000); // Check every 1 hour
}

async function executeProactiveTask(taskId) {
    activeTaskTimers.delete(taskId);
    const taskIndex = (brain.scheduled_tasks || []).findIndex(t => t.id === taskId);
    if (taskIndex === -1) return;
    const task = brain.scheduled_tasks[taskIndex];
    if (task.status !== 'pending') return;

    brain.scheduled_tasks[taskIndex].status = 'completed';
    brain.scheduled_tasks = brain.scheduled_tasks.filter(t => t.status === 'pending');

    const isEmergency = task.reason.toLowerCase().includes('emergency') || brain.user_state.health === 'sick';
    if (Date.now() < (brain.user_state.dnd_until || 0) && !isEmergency) {
        saveBrainState(false);
        return;
    }

    if (!globalWaSocket || runtimeStats.waStatus !== 'CONNECTED') {
        task.status = 'pending';
        task.executeAt = Date.now() + 120000;
        brain.scheduled_tasks.push(task);
        syncLocalTimersWithBrain();
        return;
    }

    const wakePrompt = `[SCHEDULED TASK TIMER TRIGGERED]\nReason: "${task.reason}"\nInstruction: "${task.actionPrompt}"\nAct on this immediately.`;
    const reply = await runAutonomousAgentTurn(wakePrompt, null, null, false, true);
    if (reply && reply.text) {
        await globalWaSocket.sendMessage(brain.last_active_admin_jid || ADMIN_JID, { text: reply.text });
        appendConversationHistory('model', `[Proactive Task]: ${reply.text}`);
    }
}

// ============================================================================
// 4. ULTRA-LOW-QUOTA COMPRESSED FIRESTORE AUTH ADAPTER 
// ============================================================================
const AUTH_DOC_REF = db.collection('agent_store').doc('wa_auth');
let authFlushTimer = null;
let memoryAuthState = null; 

async function useCompressedFirestoreAuthState() {
    if (!memoryAuthState) {
        let creds;
        let keysStore = {};
        try {
            const doc = await AUTH_DOC_REF.get();
            runtimeStats.firestoreReads++;
            if (doc.exists && doc.data()?.compressedPayload) {
                const gunzipped = zlib.gunzipSync(Buffer.from(doc.data().compressedPayload, 'base64')).toString('utf-8');
                const parsed = JSON.parse(gunzipped, BufferJSON.reviver);
                creds = parsed.creds || initAuthCreds();
                keysStore = parsed.keys || {};
                sysLog('AUTH-DB', `Restored compressed WhatsApp session (${Object.keys(keysStore).length} key groups).`);
            } else {
                creds = initAuthCreds();
            }
        } catch (err) {
            creds = initAuthCreds();
        }
        memoryAuthState = { creds, keysStore };
    }

    const flushAuthToFirestore = async () => {
        if (authFlushTimer) { clearTimeout(authFlushTimer); authFlushTimer = null; }
        if (!memoryAuthState) return;
        try {
            const { creds, keysStore } = memoryAuthState;
            for (const category of Object.keys(keysStore)) {
                const entries = Object.keys(keysStore[category] || {});
                if (entries.length > 350) {
                    const toDelete = entries.slice(0, entries.length - 300);
                    toDelete.forEach(k => delete keysStore[category][k]);
                }
            }
            const serialized = JSON.stringify({ creds, keys: keysStore }, BufferJSON.replacer);
            const compressedBase64 = zlib.gzipSync(Buffer.from(serialized, 'utf-8')).toString('base64');
            await AUTH_DOC_REF.set({ compressedPayload: compressedBase64, updatedAt: Date.now() });
            runtimeStats.firestoreWrites++;
            runtimeStats.authDirty = false;
            runtimeStats.lastAuthSync = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
        } catch (err) {
            sysLog('AUTH-FLUSH-ERR', err.message);
        }
    };

    const scheduleAuthFlush = (immediate = false) => {
        runtimeStats.authDirty = true;
        if (immediate) return flushAuthToFirestore();
        if (!authFlushTimer) authFlushTimer = setTimeout(flushAuthToFirestore, 45000);
    };

    const rawKeys = {
        get: async (type, ids) => {
            const data = {};
            const category = memoryAuthState.keysStore[type] || {};
            for (const id of ids) {
                let value = category[id];
                if (value) {
                    if (type === 'app-state-sync-key') value = proto.Message.AppStateSyncKeyData.fromObject(value);
                    data[id] = value;
                }
            }
            return data;
        },
        set: async (data) => {
            for (const category of Object.keys(data)) {
                memoryAuthState.keysStore[category] = memoryAuthState.keysStore[category] || {};
                for (const id of Object.keys(data[category])) {
                    const value = data[category][id];
                    if (value) memoryAuthState.keysStore[category][id] = value;
                    else delete memoryAuthState.keysStore[category][id];
                }
            }
            scheduleAuthFlush(false);
        }
    };

    return {
        state: { creds: memoryAuthState.creds, keys: makeCacheableSignalKeyStore(rawKeys, pino({ level: 'silent' })) },
        saveCreds: () => scheduleAuthFlush(false),
        flushImmediate: () => flushAuthToFirestore(),
        resetMemoryAuth: () => {
            if (authFlushTimer) clearTimeout(authFlushTimer);
            memoryAuthState = null;
        }
    };
}

// ============================================================================
// 5. AUDIO CONVERTER (PURE JS PCM -> WAV)
// ============================================================================
function rawPcmToWavBuffer(pcmBuffer, sampleRate = 24000, numChannels = 1, bitsPerSample = 16) {
    const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
    const blockAlign = (numChannels * bitsPerSample) / 8;
    const dataSize = pcmBuffer.length;
    const header = Buffer.alloc(44);

    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataSize, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(numChannels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);

    return Buffer.concat([header, pcmBuffer]);
}

// ============================================================================
// 6. GEMINI LOAD BALANCER
// ============================================================================
function getNextApiKey() {
    const key = GEMINI_KEYS[runtimeStats.currentKeyIndex];
    runtimeStats.currentKeyIndex = (runtimeStats.currentKeyIndex + 1) % GEMINI_KEYS.length;
    return key;
}

async function callGeminiWithFailover(modelName, payload) {
    let lastError = null;
    const maxAttempts = Math.min(GEMINI_KEYS.length, 4);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const apiKey = getNextApiKey();
        runtimeStats.totalGeminiCalls++;
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;

        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const data = await res.json();
            if (res.status === 429 || res.status === 503) {
                runtimeStats.keyRotations++;
                continue;
            }
            if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
            return data;
        } catch (err) {
            lastError = err;
        }
    }
    throw lastError || new Error('All Gemini keys exhausted');
}

// ============================================================================
// 7. MULTI-AGENT TOOLS (WITH NATIVE SEARCH & XMPP RING)
// ============================================================================
const AGENT_TOOLS = [
    {
        functionDeclarations: [
            {
                name: 'manage_memory_and_state',
                description: 'Save facts to core_memory, update Siva health status, or set DND duration.',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        new_permanent_fact: { type: 'STRING' },
                        health_status: { type: 'STRING', description: 'normal | sick | tired | emergency_watch' },
                        dnd_minutes: { type: 'NUMBER' }
                    }
                }
            },
            {
                name: 'evolve_my_persona',
                description: 'Permanently rewrite your own system instructions if Siva corrects your behavior.',
                parameters: {
                    type: 'OBJECT',
                    properties: { new_rule: { type: 'STRING' } }, required: ['new_rule']
                }
            },
            {
                name: 'manage_contacts',
                description: 'Save or update a person phone number.',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        key_name: { type: 'STRING' },
                        phone_number: { type: 'STRING' },
                        relation: { type: 'STRING' }
                    }, required: ['key_name', 'phone_number']
                }
            },
            {
                name: 'schedule_proactive_action',
                description: 'Schedule an autonomous future wake-up timer.',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        delay_minutes: { type: 'NUMBER' },
                        reason: { type: 'STRING' },
                        action_prompt: { type: 'STRING' }
                    }, required: ['delay_minutes', 'reason', 'action_prompt']
                }
            },
            {
                name: 'spawn_research_subagent',
                description: 'Search the live internet for recent news, weather, tech issues, or facts using zero-setup native scraping.',
                parameters: {
                    type: 'OBJECT',
                    properties: { search_query: { type: 'STRING' } }, required: ['search_query']
                }
            },
            {
                name: 'ring_whatsapp_call',
                description: 'Physically ring Siva mobile phone in an emergency to grab his attention. It will automatically cut when he answers.',
                parameters: {
                    type: 'OBJECT',
                    properties: { reason_for_calling: { type: 'STRING' } }, required: ['reason_for_calling']
                }
            },
            {
                name: 'send_whatsapp_to_number',
                description: 'Send a message directly to another phone number.',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        phone_number: { type: 'STRING' },
                        message_text: { type: 'STRING' }
                    }, required: ['phone_number', 'message_text']
                }
            }
        ]
    }
];

// ZERO-SETUP NATIVE SEARCH FUNCTION
async function nativeWebSearch(query) {
    try {
        const ddgRes = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`);
        const html = await ddgRes.text();
        const matches = html.match(/<a class="result__snippet[^>]*>(.*?)<\/a>/g);
        if (matches && matches.length > 0) {
            return matches.map(m => m.replace(/(<([^>]+)>)/gi, "").trim()).slice(0, 4).join('\n');
        }
        throw new Error("No DDG results");
    } catch (e) {
        try {
            const wikiRes = await fetch(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&utf8=&format=json`);
            const wikiJson = await wikiRes.json();
            return wikiJson.query.search.map(r => r.title + ': ' + r.snippet.replace(/(<([^>]+)>)/gi, "")).join('\n');
        } catch(err2) {
            return "Search blocked or no data found.";
        }
    }
}

// XMPP FAKE WEBRTC RING-AND-CUT PROTOCOL
async function dispatchFakeRing(targetJid) {
    if(!globalWaSocket) throw new Error("Socket offline");
    const callId = String(Math.floor(Math.random() * 1000000000000000)).substring(0, 16);
    
    // Dispatch Call Offer Stanza
    await globalWaSocket.query({
        tag: 'call',
        attrs: { to: targetJid },
        content: [{ tag: 'offer', attrs: { 'call-id': callId, 'call-creator': globalWaSocket.user.id } }]
    }).catch(()=>{});

    sysLog('VOIP-RING', `Initiated fake ring protocol to ${targetJid}`);

    // Auto terminate after 12 seconds if not answered
    setTimeout(async () => {
        await globalWaSocket.query({
            tag: 'call',
            attrs: { to: targetJid },
            content: [{ tag: 'terminate', attrs: { 'call-id': callId, reason: 'timeout' } }]
        }).catch(()=>{});
        sysLog('VOIP-CUT', 'Call auto-terminated (timeout).');
    }, 12000);

    return callId;
}

async function executeAgentTool(call) {
    const { name, args } = call;
    sysLog('TOOL-EXEC', `Invoked ${name}`);

    try {
        if (name === 'manage_memory_and_state') {
            if (args.new_permanent_fact) brain.core_memory.permanent_facts.push(args.new_permanent_fact);
            if (args.health_status) brain.user_state.health = args.health_status;
            if (typeof args.dnd_minutes === 'number') {
                brain.user_state.dnd_until = args.dnd_minutes > 0 ? Date.now() + args.dnd_minutes * 60000 : 0;
            }
            saveBrainState(false);
            return { status: 'success' };
        }
        if (name === 'evolve_my_persona') {
            brain.system_persona += `\n- ${args.new_rule}`;
            saveBrainState(false);
            return { status: 'persona_updated' };
        }
        if (name === 'manage_contacts') {
            const cleanPhone = String(args.phone_number).replace(/[^0-9]/g, '');
            brain.contacts[args.key_name.toLowerCase()] = { name: args.key_name, phone: `91${cleanPhone.slice(-10)}`, relation: args.relation };
            saveBrainState(false);
            return { status: 'saved' };
        }
        if (name === 'schedule_proactive_action') {
            const executeAt = Date.now() + (Math.max(1, Number(args.delay_minutes)) * 60000);
            const newTask = { id: `task_${Date.now().toString(36)}`, executeAt, reason: args.reason, actionPrompt: args.action_prompt, status: 'pending' };
            brain.scheduled_tasks.push(newTask);
            syncLocalTimersWithBrain();
            saveBrainState(false);
            return { status: 'scheduled' };
        }
        if (name === 'cancel_scheduled_action') {
            brain.scheduled_tasks = brain.scheduled_tasks.filter(t => t.status !== 'pending');
            saveBrainState(false);
            return { status: 'cleared_all' };
        }
        if (name === 'send_whatsapp_to_number') {
            const targetJid = `${String(args.phone_number).replace(/[^0-9]/g, '').slice(-10)}@s.whatsapp.net`;
            await globalWaSocket.sendMessage(targetJid, { text: args.message_text });
            return { status: 'sent' };
        }
        if (name === 'spawn_research_subagent') {
            const findings = await nativeWebSearch(args.search_query);
            return { status: 'research_complete', findings };
        }
        if (name === 'ring_whatsapp_call') {
            const targetJid = brain.last_active_admin_jid || ADMIN_JID;
            await dispatchFakeRing(targetJid);
            return { status: 'ringing_phone_now' };
        }
        return { status: 'error', message: `Unknown tool` };
    } catch (err) {
        return { status: 'error', message: err.message };
    }
}

// ============================================================================
// 8. MASTER AGENT REASONING (WITH HARD ANTI-LOOP GATEKEEPER)
// ============================================================================
function appendConversationHistory(role, text) {
    const time = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
    brain.recent_messages.push({ role, text: text.slice(0, 500), time });
    brain.today_log.push(`[${time}] ${role}: ${text.slice(0, 500)}`);
    
    if (brain.recent_messages.length > 8) {
        const toCompress = brain.recent_messages.splice(0, 4);
        compressRollingMemory(toCompress).catch(()=>{});
    } else {
        saveBrainState(false);
    }
}

async function compressRollingMemory(oldMessages) {
    const res = await callGeminiWithFailover(PRIMARY_MODEL, {
        contents: [{ role: 'user', parts: [{ text: `Merge into 3 concise sentences without losing context:\nSummary: ${brain.rolling_summary}\nNew:\n${JSON.stringify(oldMessages)}` }] }]
    });
    if (res?.candidates?.[0]?.content?.parts?.[0]?.text) {
        brain.rolling_summary = res.candidates[0].content.parts[0].text.trim();
        saveBrainState(false);
    }
}

async function synthesizeGeminiVoice(tanglishText) {
    try {
        const res = await callGeminiWithFailover(AUDIO_TTS_MODEL, {
            contents: [{ role: 'user', parts: [{ text: `Speak casually in Tanglish: "${tanglishText}"` }] }],
            generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Aoede' } } } }
        });
        const audioPart = res?.candidates?.[0]?.content?.parts?.find(p => p.inlineData?.data);
        if (!audioPart) return null;
        const rawBuffer = Buffer.from(audioPart.inlineData.data, 'base64');
        const mime = audioPart.inlineData.mimeType || '';
        if (mime.includes('pcm') || mime.includes('L16')) return { buffer: rawPcmToWavBuffer(rawBuffer, 24000), mimetype: 'audio/wav' };
        return { buffer: rawBuffer, mimetype: 'audio/ogg; codecs=opus' };
    } catch (err) { return null; }
}

async function runAutonomousAgentTurn(userText, mediaBuffer = null, mimeType = null, wantVoiceReply = false, isProactiveWake = false) {
    const compactContext = {
        current_ist_time: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
        core_memory: brain.core_memory,
        open_threads: brain.open_threads,
        user_state: brain.user_state,
        rolling_summary: brain.rolling_summary,
        recent_chat: brain.recent_messages
    };

    const contents = [{ role: 'user', parts: [] }];
    if (mediaBuffer && mimeType) contents[0].parts.push({ inlineData: { mimeType, data: mediaBuffer.toString('base64') } });
    contents[0].parts.push({ text: `[CONTEXT]:\n${JSON.stringify(compactContext)}\n\n[INPUT]:\n${userText}` });

    const executedToolsThisTurn = new Set();

    // STRICT 2-STEP ANTI-LOOP
    for (let step = 0; step < 2; step++) {
        const response = await callGeminiWithFailover(PRIMARY_MODEL, {
            systemInstruction: { parts: [{ text: brain.system_persona }] },
            contents,
            tools: AGENT_TOOLS
        });
        
        const candidateContent = response?.candidates?.[0]?.content;
        if (!candidateContent || !candidateContent.parts) break;
        contents.push(candidateContent);

        const functionCalls = candidateContent.parts.filter(p => p.functionCall);
        if (functionCalls.length === 0) {
            const finalText = candidateContent.parts.map(p => p.text).filter(Boolean).join('\n').trim();
            let voiceObj = wantVoiceReply && finalText ? await synthesizeGeminiVoice(finalText) : null;
            return { text: finalText, voice: voiceObj };
        }

        const toolResponseParts = [];
        for (const fcPart of functionCalls) {
            const toolHash = fcPart.functionCall.name + JSON.stringify(fcPart.functionCall.args);
            if (executedToolsThisTurn.has(toolHash)) {
                toolResponseParts.push({ functionResponse: { name: fcPart.functionCall.name, response: { error: "DUPLICATE_CALL_BLOCKED_BY_FIREWALL" } } });
                continue;
            }
            executedToolsThisTurn.add(toolHash);
            const result = await executeAgentTool(fcPart.functionCall);
            toolResponseParts.push({ functionResponse: { name: fcPart.functionCall.name, response: result } });
        }
        contents.push({ role: 'user', parts: toolResponseParts });
    }
    return { text: 'Boss, error irukku. Aprm pesuren.', voice: null };
}

// ============================================================================
// 9. WHATSAPP BAILEYS ENGINE (WITH AUTO-RECONNECT & ADMIN GATE)
// ============================================================================
let flushAuthOnShutdown = null;
let resetMemoryAuthGlobal = null;

function scheduleReconnect(delayMs) {
    if (reconnectTimeout) clearTimeout(reconnectTimeout);
    reconnectTimeout = setTimeout(() => { reconnectTimeout = null; startWhatsAppEngine(); }, delayMs);
}

async function startWhatsAppEngine() {
    if (reconnectTimeout) { clearTimeout(reconnectTimeout); reconnectTimeout = null; }
    if (globalWaSocket) {
        try { globalWaSocket.ev.removeAllListeners(); globalWaSocket.ws?.close(); } catch (e) {}
        globalWaSocket = null;
    }

    const { state, saveCreds, flushImmediate, resetMemoryAuth } = await useCompressedFirestoreAuthState();
    flushAuthOnShutdown = flushImmediate;
    resetMemoryAuthGlobal = resetMemoryAuth;

    let version = [2, 3000, 1015901307];
    try { const latest = await fetchLatestBaileysVersion(); if (latest?.version) version = latest.version; } catch (e) {}

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: Browsers.ubuntu('Chrome'),
        printQRInTerminal: false,
        fireInitQueries: true,
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false,
        markOnlineOnConnect: true,
        generateHighQualityLinkPreview: false
    });

    globalWaSocket = sock;
    sock.ev.on('creds.update', saveCreds);

    // Passive Harvester & LID map
    sock.ev.on('contacts.upsert', (contacts) => {
        for (const c of contacts) {
            if (c.id?.includes(RAW_ADMIN_PHONE) && c.lid) brain.admin_lid = c.lid;
            if (c.name || c.notify) brain.passive_contacts[c.id] = c.name || c.notify;
        }
    });

    // Auto-Cut Ring Protocol Listener
    sock.ev.on('call', async (calls) => {
        for (const call of calls) {
            if (call.status === 'offer' && call.isGroup === false) {
                // If the user answers or rejects our fake ring, WhatsApp sends an event here.
                sysLog('VOIP-EVENT', `Call event registered: ${call.status}`);
            }
        }
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            runtimeStats.waStatus = 'SCAN_QR_REQUIRED';
            runtimeStats.qrDataUrl = await QRCode.toDataURL(qr, { margin: 2, scale: 8, color: { dark: '#000', light: '#fff' } });
            runtimeStats.qrUpdatedAt = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
        }
        if (connection === 'open') {
            runtimeStats.waStatus = 'CONNECTED';
            runtimeStats.qrDataUrl = null;
            sysLog('WA-OPEN', `✅ Connected! Protecting Admin: ${ADMIN_JID}`);
            await flushImmediate();
            try {
                const [res] = await sock.onWhatsApp(ADMIN_JID);
                if (res?.lid) brain.admin_lid = res.lid;
            } catch (e) {}
        }
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            runtimeStats.waStatus = `DISCONNECTED (${statusCode || 'unknown'})`;
            if (statusCode === DisconnectReason.loggedOut || statusCode === 401 || statusCode === 403) {
                resetMemoryAuth();
                await AUTH_DOC_REF.delete().catch(() => {});
                scheduleReconnect(2000);
            } else {
                if (statusCode === 515) await flushImmediate();
                scheduleReconnect(2000);
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        for (const msg of messages) {
            if (!msg?.message || msg.key.fromMe) continue;

            const senderJid = msg.key.remoteJid || '';
            const senderPn = msg.key.senderPn || msg.key.participant || msg.participant || '';
            if (senderJid === 'status@broadcast' || senderJid.includes('@g.us')) continue;

            const mContent = msg.message.ephemeralMessage?.message || msg.message.viewOnceMessage?.message || msg.message;
            if (!mContent || !(mContent.conversation || mContent.extendedTextMessage || mContent.audioMessage || mContent.imageMessage)) continue;

            // Admin Gate
            const isLid = senderJid.endsWith('@lid');
            if (!senderJid.includes(RAW_ADMIN_PHONE) && !senderPn.includes(RAW_ADMIN_PHONE) && !(isLid && (senderJid === brain.admin_lid || !senderPn))) continue;

            if (isLid) brain.admin_lid = senderJid;
            brain.last_active_admin_jid = senderJid;
            
            // Circadian Rhythm Map
            brain.user_state.last_seen_ms = Date.now();
            brain.user_state.unanswered_checkins = 0;
            const hour = new Date().getHours();
            brain.hourly_activity_histogram[hour]++;

            let userText = mContent.conversation || mContent.extendedTextMessage?.text || '';
            let mediaBuffer = null, mimeType = null, isVoiceNote = false;

            if (mContent.audioMessage) {
                mediaBuffer = await downloadMediaMessage(msg, 'buffer', {});
                mimeType = mContent.audioMessage.mimetype || 'audio/ogg';
                userText = 'Siva sent a voice note. Respond accordingly.';
                isVoiceNote = true;
            } else if (mContent.imageMessage) {
                mediaBuffer = await downloadMediaMessage(msg, 'buffer', {});
                mimeType = mContent.imageMessage.mimetype || 'image/jpeg';
                userText = mContent.imageMessage.caption || 'Analyze this image.';
            }

            sysLog('INBOUND', `From Siva: ${userText.slice(0, 80)}`);
            await sock.sendPresenceUpdate(isVoiceNote ? 'recording' : 'composing', senderJid);
            appendConversationHistory('user', isVoiceNote ? '[Voice Note]' : userText);

            try {
                const agentReply = await runAutonomousAgentTurn(userText, mediaBuffer, mimeType, isVoiceNote, false);
                if (agentReply.voice && agentReply.voice.buffer) {
                    await sock.sendMessage(senderJid, { audio: agentReply.voice.buffer, mimetype: agentReply.voice.mimetype, ptt: true });
                    appendConversationHistory('model', `[Voice Reply]: ${agentReply.text}`);
                } else if (agentReply.text) {
                    await sock.sendMessage(senderJid, { text: agentReply.text });
                    appendConversationHistory('model', agentReply.text);
                }
            } catch (err) {
                await sock.sendMessage(senderJid, { text: `Boss, error: ${err.message}` });
            }
            await sock.sendPresenceUpdate('paused', senderJid);
            if (global.gc) global.gc();
        }
    });
}

// ============================================================================
// 10. DARK-THEMED WEB UI (UNCHANGED)
// ============================================================================
const app = express();
app.use(express.json());

app.post('/api/reset-auth', async (req, res) => {
    try {
        runtimeStats.waStatus = 'RESETTING_SESSION';
        if (globalWaSocket) {
            try { await globalWaSocket.logout().catch(()=>{}); globalWaSocket.ev.removeAllListeners(); globalWaSocket.ws?.close(); } catch(e){}
            globalWaSocket = null;
        }
        if (resetMemoryAuthGlobal) resetMemoryAuthGlobal();
        await AUTH_DOC_REF.delete().catch(() => {});
        scheduleReconnect(1000);
        res.json({ status: 'ok', message: 'Session wiped.' });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

app.get('/api/telemetry', (req, res) => {
    const mem = process.memoryUsage();
    res.json({
        ...runtimeStats,
        ramRssMb: Math.round(mem.rss / 1024 / 1024),
        ramHeapMb: Math.round(mem.heapUsed / 1024 / 1024),
        totalKeys: GEMINI_KEYS.length,
        activeTimersCount: activeTaskTimers.size,
        brainSnapshot: {
            health: brain.user_state?.health,
            dndUntil: brain.user_state?.dnd_until > Date.now() ? new Date(brain.user_state.dnd_until).toLocaleTimeString('en-IN') : 'OFF',
            factsCount: brain.core_memory?.permanent_facts?.length || 0,
            contactsCount: Object.keys(brain.contacts || {}).length,
            scheduledTasks: (brain.scheduled_tasks || []).map(t => ({ id: t.id, reason: t.reason, time: new Date(t.executeAt).toLocaleString('en-IN') })),
            rollingSummary: brain.rolling_summary
        }
    });
});

app.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Siva Autonomous AI</title>
<style>
    :root { --bg: #070a12; --card: #0f1626; --border: #1e293b; --neon: #00ff9d; --cyan: #00d2ff; --text: #e2e8f0; --danger: #ff4757; }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: system-ui, sans-serif; }
    body { background: var(--bg); color: var(--text); padding: 20px; }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 18px; margin-bottom: 20px; }
    .badge { padding: 6px 14px; border-radius: 999px; border: 1px solid var(--neon); color: var(--neon); font-weight: bold; }
    .terminal { background: #04060b; border-radius: 10px; padding: 14px; height: 280px; overflow-y: auto; color: #a3e635; font-size: 0.82rem; font-family: monospace; }
</style>
</head>
<body>
    <div style="display:flex; justify-content:space-between; margin-bottom: 20px;">
        <h2 style="color:var(--neon);">⚡ SIVA AUTONOMOUS AI</h2>
        <div id="statusBadge" class="badge">CONNECTING...</div>
    </div>
    <div class="card" id="qrContainer" style="text-align:center; min-height:100px;">Loading QR...</div>
    <div class="card">
        <h3>Live Logs</h3>
        <div id="terminal" class="terminal"></div>
    </div>
    <button onclick="fetch('/api/reset-auth', {method:'POST'})" style="padding:10px; background:var(--danger); color:#fff; border:none; border-radius:8px;">Reset Session</button>
<script>
setInterval(async () => {
    const res = await fetch('/api/telemetry'); const data = await res.json();
    document.getElementById('statusBadge').textContent = data.waStatus;
    const qr = document.getElementById('qrContainer');
    if(data.waStatus === 'CONNECTED') qr.innerHTML = '<h3 style="color:#00ff9d">WhatsApp Connected</h3>';
    else if(data.qrDataUrl) qr.innerHTML = '<img src="' + data.qrDataUrl + '" style="max-width:200px; background:#fff; padding:10px; border-radius:10px;">';
    document.getElementById('terminal').innerHTML = (data.logs || []).map(l => '<div>'+l+'</div>').join('');
}, 3000);
</script>
</body></html>`);
});

// ============================================================================
// 11. BOOTSTRAP & GRACEFUL SHUTDOWN
// ============================================================================
app.listen(PORT, async () => {
    sysLog('SERVER', `🌐 Listening on port ${PORT}`);
    await initBrainAndPulse();
    await startWhatsAppEngine();
});

async function gracefulShutdown(signal) {
    sysLog('SHUTDOWN', `Received ${signal}. Flushing...`);
    if (flushAuthOnShutdown && runtimeStats.authDirty) await flushAuthOnShutdown();
    await BRAIN_DOC_REF.set(brain, { merge: true });
    process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
