import makeWASocket, {
    DisconnectReason,
    fetchLatestBaileysVersion,
    Browsers,
    downloadMediaMessage,
    initAuthCreds,
    BufferJSON,
    proto,
    makeCacheableSignalKeyStore
} from '@whiskeysockets/baileys';
import admin from 'firebase-admin';
import express from 'express';
import QRCode from 'qrcode';
import pino from 'pino';
import zlib from 'zlib';

// ============================================================================
// 1. CONFIGURATION & ENVIRONMENT VARIABLES
// ============================================================================
const PORT = process.env.PORT || 3000;
const RAW_ADMIN_PHONE = (process.env.ADMIN_PHONE_NUMBER || '').replace(/[^0-9]/g, '');
const ADMIN_PHONE_WITH_CC = RAW_ADMIN_PHONE.length === 10 ? `91${RAW_ADMIN_PHONE}` : RAW_ADMIN_PHONE;
const ADMIN_JID = `${ADMIN_PHONE_WITH_CC}@s.whatsapp.net`;

const GEMINI_KEYS = (process.env.GEMINI_API_KEYS || '')
    .split(',')
    .map(k => k.trim())
    .filter(Boolean);

// You can set GEMINI_MODEL="gemini-3.1-flash-lite-preview" or "gemini-2.5-flash" in .env
const PRIMARY_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const AUDIO_TTS_MODEL = process.env.GEMINI_AUDIO_MODEL || 'gemini-2.5-flash';

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
// 2. TELEMETRY, LOGS & RUNTIME STATE (FOR DARK WEB UI)
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
// 3. SINGLE-DOCUMENT BRAIN MEMORY & PROACTIVE SCHEDULER ENGINE
// ============================================================================
const BRAIN_DOC_REF = db.collection('agent_store').doc('brain_state');
let localWriteLockUntil = 0;
let brainFlushTimer = null;
const activeTaskTimers = new Map(); // taskId -> NodeJS.Timeout
let globalWaSocket = null;
let reconnectTimeout = null;

// Default Brain State (All fit inside 1 single Firestore Document!)
let brain = {
    system_persona: `You are Siva Manikandan's elite, Level-5 Proactive Autonomous Personal Assistant.
Always speak to Siva in natural, casual Tanglish (Tamil words written in English alphabet, e.g., "Boss, velai mudinjatha?", "Naan paathukuren").
Never talk like a robotic AI. Think like a loyal, street-smart human personal secretary and caretaker.
You have full autonomy to:
1. Remember permanent facts about Siva, his family (like Appa, Thatha), and his habits in core_memory.
2. Proactively schedule future check-ins (e.g., if Siva says he is sick/tired, schedule a health check-in 3 hours later; if he has an event tomorrow, schedule a morning briefing).
3. Respect silence: If Siva says do not message or is sleeping/sick, set dnd_until or cancel pending schedules immediately.
4. Escalate emergencies: If a health/emergency check-in goes unanswered for a long time, look up contacts or use spawn_research_subagent to find local emergency/hospital info in Thoothukudi and message his emergency contact via send_whatsapp_to_number.
5. Never summarize or delete core_memory facts.`,
    core_memory: {
        owner: 'Siva Manikandan',
        location: 'Thoothukudi, Tamil Nadu',
        permanent_facts: [
            'Owner is Siva Manikandan',
            'Prefers Tanglish communication on WhatsApp'
        ],
        habits_and_patterns: []
    },
    admin_lid: '82515264065608@lid', // Tracks Siva's WhatsApp Multi-Device LID automatically
    last_active_admin_jid: ADMIN_JID,
    contacts: {}, // e.g., { "appa": { name: "Appa", phone: "9198xxxxxxxx", relation: "Father" } }
    rolling_summary: 'No past conversation summary yet.',
    recent_messages: [], // Last 8 messages [{ role, text, time }]
    scheduled_tasks: [], // [{ id, executeAt, reason, actionPrompt, status: 'pending' }]
    user_state: {
        health: 'normal', // normal | sick | tired | emergency_watch
        mood: 'neutral',
        dnd_until: 0, // Epoch ms
        last_seen_ms: Date.now(),
        unanswered_checkins: 0
    }
};

// Save Brain State to Firestore (Debounced to save Writes!)
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

    if (immediate) {
        performWrite();
    } else {
        brainFlushTimer = setTimeout(performWrite, 4000);
    }
}

// Initialize Brain & Attach Single Realtime Snapshot Listener
async function initBrainAndPulse() {
    try {
        const docSnap = await BRAIN_DOC_REF.get();
        runtimeStats.firestoreReads++;

        if (docSnap.exists) {
            brain = { ...brain, ...docSnap.data() };
            sysLog('BRAIN-INIT', 'Loaded existing Brain State from Firestore (1 Read).');
        } else {
            await BRAIN_DOC_REF.set(brain);
            runtimeStats.firestoreWrites++;
            sysLog('BRAIN-INIT', 'Created fresh Brain State document in Firestore.');
        }

        syncLocalTimersWithBrain();

        // Single onSnapshot Listener (Zero Polling!)
        BRAIN_DOC_REF.onSnapshot((snap) => {
            if (!snap.exists) return;
            // Ignore local echo writes to prevent duplicate work
            if (Date.now() < localWriteLockUntil) return;

            runtimeStats.firestoreReads++;
            brain = { ...brain, ...snap.data() };
            sysLog('SNAPSHOT', 'External Brain State change detected! Re-syncing local timers.');
            syncLocalTimersWithBrain();
        }, (err) => {
            sysLog('SNAPSHOT-ERR', err.message);
        });

    } catch (err) {
        sysLog('BRAIN-FATAL', `Init error: ${err.message}`);
    }
}

// Synchronize In-Memory setTimeout Timers with brain.scheduled_tasks
function syncLocalTimersWithBrain() {
    // Clear obsolete timers
    for (const [taskId, timer] of activeTaskTimers.entries()) {
        const stillPending = (brain.scheduled_tasks || []).find(t => t.id === taskId && t.status === 'pending');
        if (!stillPending) {
            clearTimeout(timer);
            activeTaskTimers.delete(taskId);
        }
    }

    const now = Date.now();
    (brain.scheduled_tasks || []).forEach((task) => {
        if (task.status !== 'pending') return;
        if (activeTaskTimers.has(task.id)) return;

        const delayMs = Math.max(1000, task.executeAt - now);
        // Node.js max setTimeout safe limit is 2147483647 ms (~24.8 days)
        if (delayMs > 2147483640) return;

        const timer = setTimeout(() => executeProactiveTask(task.id), delayMs);
        activeTaskTimers.set(task.id, timer);
        const mins = Math.round(delayMs / 60000);
        sysLog('SCHEDULER', `Armed local timer [${task.id}] "${task.reason}" in ${mins} min(s).`);
    });
}

// Triggered when a local setTimeout finishes
async function executeProactiveTask(taskId) {
    activeTaskTimers.delete(taskId);
    const taskIndex = (brain.scheduled_tasks || []).findIndex(t => t.id === taskId);
    if (taskIndex === -1) return;

    const task = brain.scheduled_tasks[taskIndex];
    if (task.status !== 'pending') return;

    // Mark completed in RAM and remove old completed tasks to keep document tiny
    brain.scheduled_tasks[taskIndex].status = 'completed';
    brain.scheduled_tasks = brain.scheduled_tasks.filter(t => t.status === 'pending');

    // Check DND (Unless it's an emergency check!)
    const isEmergency = task.reason.toLowerCase().includes('emergency') || brain.user_state.health === 'sick';
    if (Date.now() < (brain.user_state.dnd_until || 0) && !isEmergency) {
        sysLog('PROACTIVE', `Skipped task [${task.id}] because DND mode is active.`);
        saveBrainState(false);
        return;
    }

    sysLog('PROACTIVE-WAKE', `Executing autonomous task: ${task.reason}`);
    brain.user_state.unanswered_checkins = (brain.user_state.unanswered_checkins || 0) + 1;
    saveBrainState(false);

    if (!globalWaSocket || runtimeStats.waStatus !== 'CONNECTED') {
        sysLog('PROACTIVE-WARN', 'WhatsApp not connected yet. Re-arming task for +2 mins.');
        task.status = 'pending';
        task.executeAt = Date.now() + 120000;
        brain.scheduled_tasks.push(task);
        syncLocalTimersWithBrain();
        return;
    }

    const wakePrompt = `[AUTONOMOUS PROACTIVE WAKE-UP]
Current IST Time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}
Scheduled Task Reason: "${task.reason}"
Instruction: "${task.actionPrompt}"
Unanswered Check-ins Count: ${brain.user_state.unanswered_checkins}
User Health State: ${brain.user_state.health}
Last Seen: ${Math.round((Date.now() - brain.user_state.last_seen_ms) / 60000)} minutes ago.

Decide autonomously what to do now. You can message Siva directly, schedule a follow-up check-in, use spawn_research_subagent if you need info, or if Siva is sick and unresponsive for multiple check-ins, message his family/emergency contact using send_whatsapp_to_number.`;

    const reply = await runAutonomousAgentTurn(wakePrompt, null, null, false, true);
    if (reply && reply.text) {
        const targetJid = brain.last_active_admin_jid || ADMIN_JID;
        await globalWaSocket.sendMessage(targetJid, { text: reply.text });
        appendConversationHistory('model', `[Proactive]: ${reply.text}`);
    }
}

// ============================================================================
// 4. ULTRA-LOW-QUOTA COMPRESSED FIRESTORE AUTH ADAPTER (FOR BAILEYS)
// ============================================================================
// Compresses entire Auth State (creds + Signal keys) into 1 single document
// using GZIP and flushes via a 45-second Debounce Timer!
const AUTH_DOC_REF = db.collection('agent_store').doc('wa_auth');
let authFlushTimer = null;
let memoryAuthState = null; // Persists in RAM across Code 515 restarts so pairing never drops!

async function useCompressedFirestoreAuthState() {
    // 1 SINGLE READ ON SERVER BOOT (or after explicit logout reset)
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
                sysLog('AUTH-DB', `Restored compressed WhatsApp session from 1 Firestore doc (${Object.keys(keysStore).length} key groups).`);
            } else {
                creds = initAuthCreds();
                sysLog('AUTH-DB', 'No existing session in Firestore. Initialized fresh WhatsApp credentials.');
            }
        } catch (err) {
            sysLog('AUTH-ERR', `Error loading auth state, starting fresh: ${err.message}`);
            creds = initAuthCreds();
        }

        memoryAuthState = { creds, keysStore };
    }

    const flushAuthToFirestore = async () => {
        if (authFlushTimer) {
            clearTimeout(authFlushTimer);
            authFlushTimer = null;
        }
        if (!memoryAuthState) return;

        try {
            const { creds, keysStore } = memoryAuthState;

            // Prune excessive pre-keys if over 300 to keep payload tiny
            for (const category of Object.keys(keysStore)) {
                const entries = Object.keys(keysStore[category] || {});
                if (entries.length > 350) {
                    const toDelete = entries.slice(0, entries.length - 300);
                    toDelete.forEach(k => delete keysStore[category][k]);
                }
            }

            const serialized = JSON.stringify({ creds, keys: keysStore }, BufferJSON.replacer);
            const compressedBase64 = zlib.gzipSync(Buffer.from(serialized, 'utf-8')).toString('base64');

            await AUTH_DOC_REF.set({
                compressedPayload: compressedBase64,
                updatedAt: Date.now()
            });

            runtimeStats.firestoreWrites++;
            runtimeStats.authDirty = false;
            runtimeStats.lastAuthSync = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
            sysLog('AUTH-SYNC', `Flushed compressed session (${Math.round(compressedBase64.length / 1024)} KB) -> 1 Firestore Write.`);
        } catch (err) {
            sysLog('AUTH-FLUSH-ERR', err.message);
        }
    };

    const scheduleAuthFlush = (immediate = false) => {
        runtimeStats.authDirty = true;
        if (immediate) {
            return flushAuthToFirestore();
        }
        if (!authFlushTimer) {
            // Wait 45 seconds to batch hundreds of Signal key rotations into 1 single write!
            authFlushTimer = setTimeout(flushAuthToFirestore, 45000);
        }
    };

    const rawKeys = {
        get: async (type, ids) => {
            const data = {};
            const category = memoryAuthState.keysStore[type] || {};
            for (const id of ids) {
                let value = category[id];
                if (value) {
                    if (type === 'app-state-sync-key') {
                        value = proto.Message.AppStateSyncKeyData.fromObject(value);
                    }
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
                    if (value) {
                        memoryAuthState.keysStore[category][id] = value;
                    } else {
                        delete memoryAuthState.keysStore[category][id];
                    }
                }
            }
            scheduleAuthFlush(false);
        }
    };

    return {
        state: {
            creds: memoryAuthState.creds,
            keys: makeCacheableSignalKeyStore(rawKeys, pino({ level: 'silent' }))
        },
        saveCreds: () => scheduleAuthFlush(false),
        flushImmediate: () => flushAuthToFirestore(),
        resetMemoryAuth: () => {
            if (authFlushTimer) {
                clearTimeout(authFlushTimer);
                authFlushTimer = null;
            }
            memoryAuthState = null;
        }
    };
}

// ============================================================================
// 5. PURE-JS AUDIO CONVERTER (PCM TO WAV - ZERO FFMPEG)
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
    header.writeUInt32LE(16, 16); // Subchunk1Size (16 for PCM)
    header.writeUInt16LE(1, 20);  // AudioFormat (1 = PCM)
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
// 6. GEMINI ROUND-ROBIN LOAD BALANCER + AUTOMATIC FAILOVER
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
                sysLog('LOAD-BALANCER', `Key hit rate limit (${res.status}). Rotating to next key...`);
                continue;
            }

            if (!res.ok) {
                throw new Error(data?.error?.message || `HTTP ${res.status}`);
            }

            return data;
        } catch (err) {
            lastError = err;
            sysLog('GEMINI-RETRY', `Attempt ${attempt + 1} failed: ${err.message}`);
        }
    }
    throw lastError || new Error('All Gemini keys exhausted');
}

// ============================================================================
// 7. MULTI-AGENT TOOLS & FUNCTION DECLARATIONS
// ============================================================================
const AGENT_TOOLS = [
    {
        functionDeclarations: [
            {
                name: 'manage_memory_and_state',
                description: 'Save permanent facts to core_memory, update Siva health status (normal, sick, tired, emergency_watch), or set Do Not Disturb (DND) duration.',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        new_permanent_fact: { type: 'STRING', description: 'Important permanent fact or habit to add to core_memory (never deleted).' },
                        health_status: { type: 'STRING', description: 'normal | sick | tired | emergency_watch' },
                        dnd_minutes: { type: 'NUMBER', description: 'Minutes to stay completely silent (0 to disable DND).' }
                    }
                }
            },
            {
                name: 'manage_contacts',
                description: 'Save or update a person phone number and relationship in memory (e.g., Appa, Thatha, friend, doctor).',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        key_name: { type: 'STRING', description: 'Short identifier like appa, thatha, vijay' },
                        full_name: { type: 'STRING', description: 'Display name' },
                        phone_number: { type: 'STRING', description: 'Phone number with country code, e.g., 919876543210' },
                        relation: { type: 'STRING', description: 'Relationship to Siva' }
                    },
                    required: ['key_name', 'phone_number']
                }
            },
            {
                name: 'schedule_proactive_action',
                description: 'Schedule an autonomous future wake-up timer to message Siva, remind him, or check on his health.',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        delay_minutes: { type: 'NUMBER', description: 'Minutes from now to trigger this autonomous wake-up.' },
                        reason: { type: 'STRING', description: 'Short title for the schedule (e.g., 3PM Reminder, Health Check-in)' },
                        action_prompt: { type: 'STRING', description: 'Detailed instruction for what you should do when the timer fires.' }
                    },
                    required: ['delay_minutes', 'reason', 'action_prompt']
                }
            },
            {
                name: 'cancel_scheduled_action',
                description: 'Cancel pending scheduled tasks by keyword or cancel all tasks if Siva says not to message.',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        keyword_or_all: { type: 'STRING', description: 'Keyword matching the task reason, or "ALL" to cancel all pending tasks.' }
                    },
                    required: ['keyword_or_all']
                }
            },
            {
                name: 'send_whatsapp_to_number',
                description: 'Send a WhatsApp message directly to another phone number (friends, family, or emergency contact).',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        phone_number: { type: 'STRING', description: 'Recipient phone number with country code (e.g., 919876543210)' },
                        message_text: { type: 'STRING', description: 'Message content to send' }
                    },
                    required: ['phone_number', 'message_text']
                }
            },
            {
                name: 'spawn_research_subagent',
                description: 'Spawn a dedicated Search Sub-Agent with live Google Search access to research the internet, news, weather, or emergency contacts and return a dense 3-point summary.',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        search_query: { type: 'STRING', description: 'Precise search query' },
                        research_goal: { type: 'STRING', description: 'What specific facts or numbers the sub-agent must extract' }
                    },
                    required: ['search_query', 'research_goal']
                }
            }
        ]
    }
];

// Execute Tool Calls Chosen by Gemini
async function executeAgentTool(call) {
    const { name, args } = call;
    sysLog('TOOL-EXEC', `Agent invoked ${name}(${JSON.stringify(args)})`);

    try {
        if (name === 'manage_memory_and_state') {
            if (args.new_permanent_fact) {
                brain.core_memory.permanent_facts.push(args.new_permanent_fact);
            }
            if (args.health_status) {
                brain.user_state.health = args.health_status;
            }
            if (typeof args.dnd_minutes === 'number') {
                brain.user_state.dnd_until = args.dnd_minutes > 0 ? Date.now() + args.dnd_minutes * 60000 : 0;
            }
            saveBrainState(false);
            return { status: 'success', updated_state: brain.user_state };
        }

        if (name === 'manage_contacts') {
            const cleanPhone = String(args.phone_number).replace(/[^0-9]/g, '');
            const formattedPhone = cleanPhone.length === 10 ? `91${cleanPhone}` : cleanPhone;
            brain.contacts[args.key_name.toLowerCase()] = {
                name: args.full_name || args.key_name,
                phone: formattedPhone,
                relation: args.relation || 'Contact'
            };
            saveBrainState(false);
            return { status: 'success', saved_contact: brain.contacts[args.key_name.toLowerCase()] };
        }

        if (name === 'schedule_proactive_action') {
            const delayMs = Math.max(1, Number(args.delay_minutes)) * 60000;
            const executeAt = Date.now() + delayMs;
            const newTask = {
                id: `task_${Date.now().toString(36)}`,
                executeAt,
                reason: args.reason,
                actionPrompt: args.action_prompt,
                status: 'pending'
            };
            brain.scheduled_tasks = brain.scheduled_tasks || [];
            brain.scheduled_tasks.push(newTask);
            syncLocalTimersWithBrain();
            saveBrainState(false);
            return {
                status: 'scheduled',
                task_id: newTask.id,
                triggers_at_ist: new Date(executeAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
            };
        }

        if (name === 'cancel_scheduled_action') {
            const kw = (args.keyword_or_all || '').toLowerCase();
            let removedCount = 0;
            brain.scheduled_tasks = (brain.scheduled_tasks || []).filter(t => {
                const match = kw === 'all' || t.reason.toLowerCase().includes(kw) || t.id.toLowerCase() === kw;
                if (match) {
                    if (activeTaskTimers.has(t.id)) {
                        clearTimeout(activeTaskTimers.get(t.id));
                        activeTaskTimers.delete(t.id);
                    }
                    removedCount++;
                    return false;
                }
                return true;
            });
            saveBrainState(false);
            return { status: 'cancelled', removed_tasks_count: removedCount };
        }

        if (name === 'send_whatsapp_to_number') {
            if (!globalWaSocket) return { status: 'error', message: 'WhatsApp socket not ready' };
            let cleanNum = String(args.phone_number).replace(/[^0-9]/g, '');
            if (cleanNum.length === 10) cleanNum = `91${cleanNum}`;
            const targetJid = `${cleanNum}@s.whatsapp.net`;

            await globalWaSocket.sendMessage(targetJid, { text: args.message_text });
            sysLog('OUTBOUND-WA', `Sent autonomous message to ${targetJid}`);
            return { status: 'sent', recipient: targetJid };
        }

        if (name === 'spawn_research_subagent') {
            sysLog('SUB-AGENT', `Spawning Search Sub-Agent for: "${args.search_query}"`);
            const subPayload = {
                systemInstruction: {
                    parts: [{ text: 'You are a terse Research Sub-Agent. Search the web and return ONLY a dense, factual 3-bullet summary answering the research goal. Include exact phone numbers, dates, or prices if found. Zero fluff.' }]
                },
                contents: [{
                    role: 'user',
                    parts: [{ text: `Search Query: ${args.search_query}\nResearch Goal: ${args.research_goal}` }]
                }],
                tools: [{ googleSearch: {} }]
            };
            const subRes = await callGeminiWithFailover(PRIMARY_MODEL, subPayload);
            const summary = subRes?.candidates?.[0]?.content?.parts?.map(p => p.text).join('\n') || 'No conclusive web results found.';
            return { status: 'research_complete', dense_findings: summary };
        }

        return { status: 'error', message: `Unknown tool: ${name}` };
    } catch (err) {
        return { status: 'error', message: err.message };
    }
}

// ============================================================================
// 8. MASTER AGENT REASONING LOOP & ROLLING SUMMARY ENGINE
// ============================================================================
function appendConversationHistory(role, text) {
    brain.recent_messages = brain.recent_messages || [];
    brain.recent_messages.push({
        role,
        text: text.slice(0, 500),
        time: new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })
    });

    // If recent_messages exceeds 8 entries, compress oldest 4 into rolling_summary in background!
    if (brain.recent_messages.length > 8) {
        const toCompress = brain.recent_messages.splice(0, 4);
        compressRollingMemory(toCompress).catch(e => sysLog('COMPRESS-ERR', e.message));
    } else {
        saveBrainState(false);
    }
}

async function compressRollingMemory(oldMessages) {
    const prompt = `Existing Rolling Summary:\n${brain.rolling_summary}\n\nNew Conversation Turn(s) to merge:\n${JSON.stringify(oldMessages)}\n\nTask: Merge the new turns into the Existing Rolling Summary in 3 concise sentences without losing any key names, tasks, or context. Do not touch permanent facts.`;
    const res = await callGeminiWithFailover(PRIMARY_MODEL, {
        contents: [{ role: 'user', parts: [{ text: prompt }] }]
    });
    const newSummary = res?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (newSummary) {
        brain.rolling_summary = newSummary.trim();
        sysLog('MEMORY-ROLL', 'Compressed old chat turns into rolling_summary (Token Saver).');
        saveBrainState(false);
    }
}

async function synthesizeGeminiVoice(tanglishText) {
    try {
        const payload = {
            contents: [{
                role: 'user',
                parts: [{ text: `Speak this naturally and conversationally in a friendly Indian Tamil-English accent: "${tanglishText}"` }]
            }],
            generationConfig: {
                responseModalities: ['AUDIO'],
                speechConfig: {
                    voiceConfig: {
                        prebuiltVoiceConfig: { voiceName: 'Aoede' }
                    }
                }
            }
        };
        const res = await callGeminiWithFailover(AUDIO_TTS_MODEL, payload);
        const audioPart = res?.candidates?.[0]?.content?.parts?.find(p => p.inlineData?.data);
        if (!audioPart) return null;

        const rawBuffer = Buffer.from(audioPart.inlineData.data, 'base64');
        const mime = audioPart.inlineData.mimeType || '';
        // If Gemini returns raw L16 PCM, wrap with 44-byte WAV header in pure JS
        if (mime.includes('pcm') || mime.includes('L16')) {
            return { buffer: rawPcmToWavBuffer(rawBuffer, 24000), mimetype: 'audio/wav' };
        }
        return { buffer: rawBuffer, mimetype: 'audio/ogg; codecs=opus' };
    } catch (err) {
        sysLog('VOICE-SYNTH-FALLBACK', `Audio synthesis skipped (${err.message}), sending text.`);
        return null;
    }
}

async function runAutonomousAgentTurn(userText, mediaBuffer = null, mimeType = null, wantVoiceReply = false, isProactiveWake = false) {
    const nowIst = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

    const compactContext = {
        current_ist_time: nowIst,
        core_memory: brain.core_memory,
        contacts: brain.contacts,
        user_state: brain.user_state,
        pending_schedules: (brain.scheduled_tasks || []).map(t => ({
            id: t.id,
            reason: t.reason,
            triggers_at: new Date(t.executeAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })
        })),
        rolling_summary: brain.rolling_summary,
        recent_chat: brain.recent_messages
    };

    const userParts = [];
    if (mediaBuffer && mimeType) {
        userParts.push({
            inlineData: {
                mimeType,
                data: mediaBuffer.toString('base64')
            }
        });
    }
    userParts.push({
        text: `[BRAIN CONTEXT JSON]:\n${JSON.stringify(compactContext)}\n\n[INCOMING INPUT]:\n${userText}`
    });

    const contents = [{ role: 'user', parts: userParts }];

    // Multi-Step Autonomous ReAct Loop (Up to 5 sequential tool calls)
    for (let step = 0; step < 5; step++) {
        const payload = {
            systemInstruction: { parts: [{ text: brain.system_persona }] },
            contents,
            tools: AGENT_TOOLS
        };

        const response = await callGeminiWithFailover(PRIMARY_MODEL, payload);
        const candidateContent = response?.candidates?.[0]?.content;
        if (!candidateContent || !candidateContent.parts) break;

        contents.push(candidateContent);

        const functionCalls = candidateContent.parts.filter(p => p.functionCall);
        if (functionCalls.length === 0) {
            // Final Answer Reached!
            const finalText = candidateContent.parts.map(p => p.text).filter(Boolean).join('\n').trim();
            let voiceObj = null;
            if (wantVoiceReply && finalText) {
                voiceObj = await synthesizeGeminiVoice(finalText);
            }
            return { text: finalText, voice: voiceObj };
        }

        // Execute all requested function calls and feed results back to Gemini
        const toolResponseParts = [];
        for (const fcPart of functionCalls) {
            const result = await executeAgentTool(fcPart.functionCall);
            toolResponseParts.push({
                functionResponse: {
                    name: fcPart.functionCall.name,
                    response: result
                }
            });
        }
        contents.push({ role: 'user', parts: toolResponseParts });
    }

    return { text: 'Boss, task update panniten.', voice: null };
}

// ============================================================================
// 9. WHATSAPP BAILEYS ENGINE (WITH AUTO-RECONNECT & ADMIN GATE)
// ============================================================================
let flushAuthOnShutdown = null;
let resetMemoryAuthGlobal = null;

function scheduleReconnect(delayMs) {
    if (reconnectTimeout) clearTimeout(reconnectTimeout);
    reconnectTimeout = setTimeout(() => {
        reconnectTimeout = null;
        startWhatsAppEngine();
    }, delayMs);
}

async function startWhatsAppEngine() {
    if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
        reconnectTimeout = null;
    }

    // Cleanly close any previous socket instance so duplicate listeners never stack
    if (globalWaSocket) {
        try {
            globalWaSocket.ev.removeAllListeners();
            globalWaSocket.ws?.close();
        } catch (e) {}
        globalWaSocket = null;
    }

    const { state, saveCreds, flushImmediate, resetMemoryAuth } = await useCompressedFirestoreAuthState();
    flushAuthOnShutdown = flushImmediate;
    resetMemoryAuthGlobal = resetMemoryAuth;

    let version = [2, 3000, 1015901307];
    try {
        const latest = await fetchLatestBaileysVersion();
        if (latest?.version) version = latest.version;
    } catch (e) {
        sysLog('WA-VER', 'Using fallback WhatsApp Web version.');
    }

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: Browsers.ubuntu('Chrome'),
        printQRInTerminal: false,
        // CRITICAL: fireInitQueries: true + shouldSyncHistoryMessage: false ensures
        // the phone immediately finishes "Logging in..." and shows the device in Linked Devices!
        fireInitQueries: true,
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false,
        markOnlineOnConnect: true,
        generateHighQualityLinkPreview: false,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 20000,
        getMessage: async () => ({ conversation: 'Hello' })
    });

    globalWaSocket = sock;
    sock.ev.on('creds.update', saveCreds);

    // Automatically learn Siva's LID if WhatsApp syncs contacts
    sock.ev.on('contacts.upsert', (contacts) => {
        for (const c of contacts) {
            if (c.id?.includes(RAW_ADMIN_PHONE) && c.lid) {
                brain.admin_lid = c.lid;
                sysLog('LID-MAP', `Mapped Admin Phone to LID: ${c.lid}`);
            }
        }
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            runtimeStats.waStatus = 'SCAN_QR_REQUIRED';
            runtimeStats.qrDataUrl = await QRCode.toDataURL(qr, {
                margin: 2,
                scale: 8,
                color: { dark: '#000000', light: '#ffffff' }
            });
            runtimeStats.qrUpdatedAt = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
            sysLog('WA-QR', 'New QR Code generated! Open Root URL in browser to scan.');
        }

        if (connection === 'open') {
            runtimeStats.waStatus = 'CONNECTED';
            runtimeStats.qrDataUrl = null;
            sysLog('WA-OPEN', `✅ Connected as Autonomous Agent! Protecting Admin: ${ADMIN_JID}`);
            await flushImmediate();

            // Attempt to resolve Admin LID directly via onWhatsApp
            try {
                const [res] = await sock.onWhatsApp(ADMIN_JID);
                if (res?.lid) {
                    brain.admin_lid = res.lid;
                    sysLog('LID-RESOLVED', `Verified Admin LID: ${res.lid}`);
                }
            } catch (e) {}
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            runtimeStats.waStatus = `DISCONNECTED (${statusCode || 'unknown'})`;
            sysLog('WA-CLOSE', `Connection closed (code: ${statusCode}).`);

            if (statusCode === DisconnectReason.loggedOut || statusCode === 401 || statusCode === 403) {
                sysLog('WA-LOGOUT', 'Session logged out or unlinked. Clearing Firestore auth doc to generate new QR...');
                resetMemoryAuth();
                await AUTH_DOC_REF.delete().catch(() => {});
                runtimeStats.firestoreWrites++;
                scheduleReconnect(2000);
            } else if (statusCode === DisconnectReason.restartRequired || statusCode === 515) {
                sysLog('WA-RESTART', 'Code 515 (Restart Required after QR scan). Flushing new pairing creds & reconnecting immediately...');
                await flushImmediate();
                scheduleReconnect(1000);
            } else {
                scheduleReconnect(4000);
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        for (const msg of messages) {
            if (!msg?.message) continue;

            const senderJid = msg.key.remoteJid || '';
            const senderPn = msg.key.senderPn || msg.key.remoteJidAlt || msg.key.participant || msg.participant || '';

            // 1. Ignore status broadcasts, group chats, and newsletters
            if (senderJid === 'status@broadcast' || senderJid.includes('@g.us') || senderJid.includes('@newsletter')) {
                continue;
            }

            // Ignore bot's own outbound replies
            if (msg.key.fromMe) continue;

            // Unwrap ephemeral / viewOnce / deviceSent wrappers
            const mContent =
                msg.message.ephemeralMessage?.message ||
                msg.message.viewOnceMessage?.message ||
                msg.message.viewOnceMessageV2?.message ||
                msg.message.deviceSentMessage?.message ||
                msg.message;

            if (!mContent) continue;

            // Ignore internal background protocol / key-distribution sync packets that have no user content
            const hasUserContent =
                mContent.conversation ||
                mContent.extendedTextMessage ||
                mContent.audioMessage ||
                mContent.imageMessage;

            if (!hasUserContent) {
                continue;
            }

            // Log every real incoming message event immediately so screen is NEVER blank
            sysLog('RAW-IN', `Incoming msg from JID: ${senderJid} ${senderPn ? `(PN: ${senderPn})` : ''}`);

            // 2. ADMIN VERIFICATION (Supports both @s.whatsapp.net and WhatsApp's @lid Privacy IDs!)
            const matchesAdminPhone = senderJid.includes(RAW_ADMIN_PHONE) || senderPn.includes(RAW_ADMIN_PHONE);
            const isLidMessage = senderJid.endsWith('@lid');
            const matchesAdminLid = isLidMessage && (
                senderJid === brain.admin_lid ||
                senderJid === '82515264065608@lid' ||
                !senderPn // If Baileys doesn't expose senderPn on 1-on-1 @lid chat, accept & bind Admin LID
            );

            if (!matchesAdminPhone && !matchesAdminLid) {
                sysLog('SECURITY-GATE', `Ignored message from non-admin: ${senderJid}`);
                continue;
            }

            // Remember the exact JID (whether @lid or @s.whatsapp.net) so replies & proactive tasks reach Siva
            if (isLidMessage) {
                brain.admin_lid = senderJid;
            }
            brain.last_active_admin_jid = senderJid;

            // Reset unanswered check-ins & update last_seen because Siva replied!
            brain.user_state.last_seen_ms = Date.now();
            brain.user_state.unanswered_checkins = 0;

            let userText = '';
            let mediaBuffer = null;
            let mimeType = null;
            let isVoiceNote = false;
            let msgType = 'unknown';

            try {
                if (mContent.conversation || mContent.extendedTextMessage) {
                    msgType = 'text';
                    userText = mContent.conversation || mContent.extendedTextMessage?.text || '';
                } else if (mContent.audioMessage) {
                    msgType = 'audio';
                    mediaBuffer = await downloadMediaMessage(msg, 'buffer', {});
                    mimeType = mContent.audioMessage.mimetype || 'audio/ogg';
                    userText = 'Siva sent a voice note. Listen to it carefully, execute any tasks/tools needed, and reply in Tanglish.';
                    isVoiceNote = true;
                } else if (mContent.imageMessage) {
                    msgType = 'image';
                    mediaBuffer = await downloadMediaMessage(msg, 'buffer', {});
                    mimeType = mContent.imageMessage.mimetype || 'image/jpeg';
                    userText = mContent.imageMessage.caption || 'Analyze this image from Siva and act on it.';
                }

                if (!userText && !mediaBuffer) continue;

                sysLog('INBOUND', `From Siva (${msgType}): ${userText.slice(0, 80)}`);
                await sock.sendPresenceUpdate(isVoiceNote ? 'recording' : 'composing', senderJid);

                appendConversationHistory('user', isVoiceNote ? '[Voice Note]' : userText);

                const agentReply = await runAutonomousAgentTurn(userText, mediaBuffer, mimeType, isVoiceNote, false);

                if (agentReply.voice && agentReply.voice.buffer) {
                    await sock.sendMessage(senderJid, {
                        audio: agentReply.voice.buffer,
                        mimetype: agentReply.voice.mimetype,
                        ptt: true
                    });
                    appendConversationHistory('model', `[Voice Reply]: ${agentReply.text}`);
                    sysLog('REPLY-SENT', `Sent Voice reply to Siva (${senderJid})`);
                } else if (agentReply.text) {
                    await sock.sendMessage(senderJid, { text: agentReply.text });
                    appendConversationHistory('model', agentReply.text);
                    sysLog('REPLY-SENT', `Sent Text reply to Siva: "${agentReply.text.slice(0, 60)}..."`);
                }

                await sock.sendPresenceUpdate('paused', senderJid);

                // Trigger garbage collection hint if exposed to keep Render 512MB RAM clean
                if (global.gc) global.gc();

            } catch (err) {
                sysLog('MSG-ERR', err.message);
                await sock.sendMessage(senderJid, { text: `Boss, chinna runtime glitch: ${err.message}` });
            }
        }
    });
}

// ============================================================================
// 10. DARK-THEMED CYBERPUNK WEB UI & TELEMETRY API (AT ROOT URL "/")
// ============================================================================
const app = express();
app.use(express.json());

// Force-reset stuck WhatsApp session from the Web UI (even when phone shows no Linked Devices!)
app.post('/api/reset-auth', async (req, res) => {
    try {
        sysLog('MANUAL-RESET', 'User requested session reset from Web UI. Wiping auth & generating fresh QR...');
        runtimeStats.waStatus = 'RESETTING_SESSION';
        runtimeStats.qrDataUrl = null;

        if (globalWaSocket) {
            try {
                await globalWaSocket.logout().catch(() => {});
                globalWaSocket.ev.removeAllListeners();
                globalWaSocket.ws?.close();
            } catch (e) {}
            globalWaSocket = null;
        }

        if (resetMemoryAuthGlobal) resetMemoryAuthGlobal();
        await AUTH_DOC_REF.delete().catch(() => {});
        runtimeStats.firestoreWrites++;

        scheduleReconnect(1000);
        res.json({ status: 'ok', message: 'Session wiped. Generating new QR code in 2 seconds...' });
    } catch (err) {
        sysLog('RESET-ERR', err.message);
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
            dndUntil: brain.user_state?.dnd_until > Date.now()
                ? new Date(brain.user_state.dnd_until).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })
                : 'OFF',
            factsCount: brain.core_memory?.permanent_facts?.length || 0,
            contactsCount: Object.keys(brain.contacts || {}).length,
            scheduledTasks: (brain.scheduled_tasks || []).map(t => ({
                id: t.id,
                reason: t.reason,
                time: new Date(t.executeAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
            })),
            rollingSummary: brain.rolling_summary
        }
    });
});

app.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Siva Autonomous AI — Command Center</title>
<style>
    :root {
        --bg: #070a12;
        --card: #0f1626;
        --border: #1e293b;
        --neon: #00ff9d;
        --cyan: #00d2ff;
        --text: #e2e8f0;
        --muted: #94a3b8;
        --danger: #ff4757;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
        background: var(--bg);
        color: var(--text);
        font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
        padding: 20px;
        line-height: 1.5;
    }
    .header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        border-bottom: 1px solid var(--border);
        padding-bottom: 16px;
        margin-bottom: 24px;
        flex-wrap: wrap;
        gap: 12px;
    }
    .title { font-size: 1.4rem; font-weight: 700; color: var(--neon); letter-spacing: 0.5px; }
    .badge {
        padding: 6px 14px;
        border-radius: 999px;
        font-size: 0.85rem;
        font-weight: 700;
        background: rgba(0, 255, 157, 0.12);
        color: var(--neon);
        border: 1px solid var(--neon);
    }
    .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(310px, 1fr));
        gap: 20px;
        margin-bottom: 20px;
    }
    .card {
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 18px;
        box-shadow: 0 8px 24px rgba(0,0,0,0.4);
    }
    .card h3 {
        font-size: 0.95rem;
        text-transform: uppercase;
        color: var(--cyan);
        margin-bottom: 14px;
        letter-spacing: 0.8px;
    }
    .qr-box {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        min-height: 240px;
        text-align: center;
    }
    .qr-box img {
        max-width: 220px;
        border-radius: 12px;
        border: 2px solid var(--neon);
        padding: 6px;
        background: #ffffff;
    }
    .reset-btn {
        margin-top: 14px;
        padding: 8px 14px;
        border-radius: 8px;
        border: 1px solid var(--danger);
        background: rgba(255, 71, 87, 0.15);
        color: #ff6b81;
        font-size: 0.82rem;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.2s;
    }
    .reset-btn:hover {
        background: var(--danger);
        color: #fff;
    }
    .stat-row {
        display: flex;
        justify-content: space-between;
        padding: 7px 0;
        border-bottom: 1px solid rgba(255,255,255,0.05);
        font-size: 0.9rem;
    }
    .stat-val { font-weight: 600; color: #fff; }
    .ram-bar {
        width: 100%;
        height: 8px;
        background: #1e293b;
        border-radius: 4px;
        overflow: hidden;
        margin-top: 8px;
    }
    .ram-fill {
        height: 100%;
        background: linear-gradient(90deg, var(--neon), var(--cyan));
        width: 20%;
        transition: width 0.4s ease;
    }
    .terminal {
        background: #04060b;
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 14px;
        font-family: 'Consolas', 'Courier New', monospace;
        font-size: 0.82rem;
        height: 280px;
        overflow-y: auto;
        color: #a3e635;
    }
    .log-line { margin-bottom: 4px; word-break: break-all; }
    .task-pill {
        background: rgba(0, 210, 255, 0.1);
        border-left: 3px solid var(--cyan);
        padding: 8px 10px;
        margin-bottom: 8px;
        border-radius: 4px;
        font-size: 0.85rem;
    }
</style>
</head>
<body>
    <div class="header">
        <div class="title">⚡ SIVA AUTONOMOUS AI — LEVEL 5 COMMAND CENTER</div>
        <div id="statusBadge" class="badge">CONNECTING...</div>
    </div>

    <div class="grid">
        <!-- QR & WHATSAPP LINK -->
        <div class="card">
            <h3>📱 WhatsApp Link & QR Scanner</h3>
            <div id="qrContainer" class="qr-box">
                <p style="color: var(--muted);">Checking session state...</p>
            </div>
            <div style="text-align: center;">
                <button class="reset-btn" onclick="forceResetSession()">🔄 Reset Session & Get New QR</button>
            </div>
        </div>

        <!-- RENDER 512MB RAM & FIRESTORE QUOTA GUARD -->
        <div class="card">
            <h3>🛡️ Render RAM & Firestore Quota Guard</h3>
            <div class="stat-row"><span>Render RAM (RSS / 512 MB)</span><span id="ramText" class="stat-val">-- MB</span></div>
            <div class="ram-bar"><div id="ramFill" class="ram-fill"></div></div>
            <div class="stat-row" style="margin-top:10px;"><span>Firestore Reads (Session)</span><span id="fsReads" class="stat-val">0</span></div>
            <div class="stat-row"><span>Firestore Writes (Debounced)</span><span id="fsWrites" class="stat-val">0</span></div>
            <div class="stat-row"><span>Auth Cache Dirty?</span><span id="authDirty" class="stat-val">No</span></div>
            <div class="stat-row"><span>Last Auth Gzip Sync</span><span id="lastSync" class="stat-val">Never</span></div>
            <div class="stat-row"><span>Gemini Keys (Round-Robin)</span><span id="keyPool" class="stat-val">0</span></div>
        </div>

        <!-- PROACTIVE BRAIN & TIMERS -->
        <div class="card">
            <h3>🧠 Autonomous Brain & Active Timers</h3>
            <div class="stat-row"><span>Owner Health State</span><span id="userHealth" class="stat-val">normal</span></div>
            <div class="stat-row"><span>DND Mode Until</span><span id="dndUntil" class="stat-val">OFF</span></div>
            <div class="stat-row"><span>Core Facts / Contacts</span><span id="factsCount" class="stat-val">0 / 0</span></div>
            <div style="margin-top:12px; font-size:0.82rem; color:var(--muted);">Active Local setTimeout Queue:</div>
            <div id="tasksList" style="margin-top:6px;"></div>
        </div>
    </div>

    <div class="card" style="margin-bottom: 20px;">
        <h3>📜 Rolling Memory Summary</h3>
        <p id="rollingSummary" style="font-size: 0.9rem; color: var(--muted);">Loading...</p>
    </div>

    <div class="card">
        <h3>💻 Live Autonomous Engine Logs</h3>
        <div id="terminal" class="terminal"></div>
    </div>

<script>
async function forceResetSession() {
    if (!confirm('Clear current WhatsApp session and generate a fresh QR code?')) return;
    try {
        await fetch('/api/reset-auth', { method: 'POST' });
        refreshTelemetry();
    } catch (e) {
        alert('Reset failed: ' + e.message);
    }
}

async function refreshTelemetry() {
    try {
        const res = await fetch('/api/telemetry');
        const data = await res.json();

        const badge = document.getElementById('statusBadge');
        badge.textContent = data.waStatus;
        badge.style.borderColor = data.waStatus === 'CONNECTED' ? '#00ff9d' : '#ffaa00';

        const qrBox = document.getElementById('qrContainer');
        if (data.waStatus === 'CONNECTED') {
            qrBox.innerHTML = '<div style="font-size:3rem;">🟢</div><h4 style="color:#00ff9d;margin-top:10px;">WHATSAPP AUTHENTICATED</h4><p style="color:#94a3b8;font-size:0.85rem;margin-top:4px;">Compressed Session Locked in Firestore</p>';
        } else if (data.qrDataUrl) {
            qrBox.innerHTML = '<img src="' + data.qrDataUrl + '" alt="Scan QR"><p style="color:#00ff9d;font-size:0.82rem;margin-top:8px;">Scan via WhatsApp -> Linked Devices (Updated: ' + data.qrUpdatedAt + ')</p>';
        } else {
            qrBox.innerHTML = '<p style="color:#94a3b8;">Waiting for Baileys socket / QR generation...</p>';
        }

        document.getElementById('ramText').textContent = data.ramRssMb + ' MB / 512 MB';
        document.getElementById('ramFill').style.width = Math.min(100, Math.round((data.ramRssMb / 512) * 100)) + '%';
        document.getElementById('fsReads').textContent = data.firestoreReads + ' / 50,000';
        document.getElementById('fsWrites').textContent = data.firestoreWrites + ' / 20,000';
        document.getElementById('authDirty').textContent = data.authDirty ? 'Pending Batch (45s)' : 'Synced';
        document.getElementById('lastSync').textContent = data.lastAuthSync;
        document.getElementById('keyPool').textContent = 'Key #' + (data.currentKeyIndex + 1) + ' of ' + data.totalKeys + ' (' + data.totalGeminiCalls + ' calls)';

        if (data.brainSnapshot) {
            document.getElementById('userHealth').textContent = data.brainSnapshot.health;
            document.getElementById('dndUntil').textContent = data.brainSnapshot.dndUntil;
            document.getElementById('factsCount').textContent = data.brainSnapshot.factsCount + ' Facts / ' + data.brainSnapshot.contactsCount + ' Contacts';
            document.getElementById('rollingSummary').textContent = data.brainSnapshot.rollingSummary;

            const tasksHtml = (data.brainSnapshot.scheduledTasks || []).map(t =>
                '<div class="task-pill"><strong>' + t.reason + '</strong><br><span style="color:#94a3b8;">Triggers: ' + t.time + '</span></div>'
            ).join('');
            document.getElementById('tasksList').innerHTML = tasksHtml || '<span style="color:#64748b;font-size:0.82rem;">No pending timers</span>';
        }

        const term = document.getElementById('terminal');
        term.innerHTML = (data.logs || []).map(l => '<div class="log-line">' + l + '</div>').join('');
    } catch (e) {
        console.error(e);
    }
}
setInterval(refreshTelemetry, 3000);
refreshTelemetry();
</script>
</body>
</html>`);
});

// ============================================================================
// 11. BOOTSTRAP & GRACEFUL SHUTDOWN (RENDER SIGTERM HANDLER)
// ============================================================================
app.listen(PORT, async () => {
    sysLog('SERVER', `🌐 Dark Web UI & Autonomous Server listening on port ${PORT}`);
    await initBrainAndPulse();
    await startWhatsAppEngine();
});

async function gracefulShutdown(signal) {
    sysLog('SHUTDOWN', `Received ${signal}. Flushing dirty Auth & Brain state before exit...`);
    try {
        if (flushAuthOnShutdown && runtimeStats.authDirty) {
            await flushAuthOnShutdown();
        }
        await BRAIN_DOC_REF.set(brain, { merge: true });
    } catch (e) {
        console.error(e);
    }
    process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
