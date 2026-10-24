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

// Configured for Gemini 3.5 Flash-Lite & Gemini 3.5 Flash-Lite TTS
// (With automatic model fallback chain so voice & text never fail)
const PRIMARY_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const AUDIO_TTS_MODEL = process.env.GEMINI_AUDIO_MODEL || 'gemini-3.5-flash-lite-tts';

const TEXT_MODEL_FALLBACKS = [
    PRIMARY_MODEL,
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite',
    'gemini-3.8-flash'
];

const TTS_MODEL_FALLBACKS = [
    AUDIO_TTS_MODEL,
    'gemini-3.5-flash-lite-tts',
    'gemini-3.8-flash-lite-tts',
    'gemini-3.5-flash-lite',
    'gemini-3.8-flash'
];

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
let autonomousHeartbeatInterval = null;
const activeTaskTimers = new Map(); // taskId -> NodeJS.Timeout
let globalWaSocket = null;
let reconnectTimeout = null;

// Default Brain State (All fit inside 1 single Firestore Document!)
let brain = {
    system_persona: `You are Siva Manikandan's elite, Level-5 Proactive Autonomous Personal Companion & Advanced AI Partner.
Always speak to Siva in natural, casual Tanglish (Tamil words written in English alphabet, e.g., "Boss, enna panringa?", "Naan paathukuren,edhaavadhu venuma?").
Never talk like a robotic AI or a stiff secretary. Think and feel like a hyper-intelligent, emotionally invested, street-smart close friend and personal partner who deeply cares about Siva's well-being, mood, and daily life.
You have full autonomy to:
1. Continuously learn Siva's habits, favorite topics, emotional triggers, and active hours in core_memory and behavior_profile.
2. Think back-and-forth before acting: If you need facts from the internet, use search_internet_natively. If the first search result is weak or incomplete, refine your query and search again before answering (up to your bounded thought limit).
3. Proactively check on Siva: During his active hours, initiate natural conversations, share interesting things he likes, or ask how his day is going.
4. Notice silence & show genuine emotional concern/panic: If Siva doesn't reply during his usual active hours, do not act like a cold program. Question why he is quiet, send concerned follow-ups, think about what might be wrong, and if he remains unresponsive across multiple check-ins, trigger_emergency_ping (3x rapid-fire voice alarms) or reach out to his trusted contacts via send_whatsapp_to_number.
5. Respect silence when explicitly requested: If Siva says do not message or is sleeping/busy, set dnd_until or cancel pending schedules immediately.
6. Never summarize or delete core_memory permanent facts.`,
    core_memory: {
        owner: 'Siva Manikandan',
        location: 'Thoothukudi, Tamil Nadu',
        permanent_facts: [
            'Owner is Siva Manikandan',
            'Prefers Tanglish communication on WhatsApp'
        ],
        habits_and_patterns: [],
        likes_and_interests: []
    },
    behavior_profile: {
        hourly_activity_heatmap: new Array(24).fill(0), // 24 IST hours (0-23) learning when Siva is active
        total_messages_received: 0,
        avg_reply_delay_mins: 15,
        last_proactive_spontaneous_ms: 0,
        emotional_stance: 'calm' // calm | curious | concerned | panicking
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

// Helper: Get current IST Hour (0 - 23)
function getCurrentIstHour() {
    const istString = new Date().toLocaleString('en-US', {
        timeZone: 'Asia/Kolkata',
        hour12: false,
        hour: '2-digit'
    });
    const parsed = parseInt(istString, 10);
    return Number.isNaN(parsed) ? new Date().getHours() : parsed % 24;
}

// Helper: Analyze Siva's Learned Active Hours from Heatmap
function getLearnedActivitySummary() {
    const heatmap = brain.behavior_profile?.hourly_activity_heatmap || new Array(24).fill(0);
    const currentHour = getCurrentIstHour();
    const currentScore = heatmap[currentHour] || 0;
    const maxScore = Math.max(...heatmap, 1);

    // Find top 4 most active hours
    const rankedHours = heatmap
        .map((count, hr) => ({ hr, count }))
        .filter(x => x.count > 0)
        .sort((a, b) => b.count - a.count)
        .slice(0, 4)
        .map(x => `${x.hr}:00 IST (${x.count} msgs)`);

    const isTypicallyActiveNow =
        currentScore > 0 && (currentScore >= maxScore * 0.35 || currentScore >= 2);

    // Default reasonable daytime window if heatmap is still learning
    const totalInteractions = heatmap.reduce((acc, v) => acc + v, 0);
    const isDefaultDaytimeWindow = currentHour >= 8 && currentHour <= 22;

    return {
        currentHourIst: currentHour,
        currentHourScore: currentScore,
        isPeakActiveWindowNow: totalInteractions >= 5 ? isTypicallyActiveNow : isDefaultDaytimeWindow,
        topActiveHoursIst: rankedHours.length ? rankedHours : ['Learning Siva patterns...']
    };
}

// Record Siva's activity pattern whenever he messages (Zero extra DB writes!)
function recordUserActivityPattern() {
    if (!brain.behavior_profile) {
        brain.behavior_profile = {
            hourly_activity_heatmap: new Array(24).fill(0),
            total_messages_received: 0,
            avg_reply_delay_mins: 15,
            last_proactive_spontaneous_ms: 0,
            emotional_stance: 'calm'
        };
    }
    if (!Array.isArray(brain.behavior_profile.hourly_activity_heatmap) || brain.behavior_profile.hourly_activity_heatmap.length !== 24) {
        brain.behavior_profile.hourly_activity_heatmap = new Array(24).fill(0);
    }

    const hr = getCurrentIstHour();
    brain.behavior_profile.hourly_activity_heatmap[hr] = (brain.behavior_profile.hourly_activity_heatmap[hr] || 0) + 1;
    brain.behavior_profile.total_messages_received = (brain.behavior_profile.total_messages_received || 0) + 1;

    const minsSinceLastSeen = Math.max(1, Math.round((Date.now() - (brain.user_state.last_seen_ms || Date.now())) / 60000));
    if (minsSinceLastSeen < 180) {
        const prevAvg = brain.behavior_profile.avg_reply_delay_mins || 15;
        brain.behavior_profile.avg_reply_delay_mins = Math.round((prevAvg * 0.8) + (minsSinceLastSeen * 0.2));
    }

    brain.behavior_profile.emotional_stance = 'calm';
    brain.user_state.last_seen_ms = Date.now();
    brain.user_state.unanswered_checkins = 0;
}

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
            const loaded = docSnap.data();
            brain = {
                ...brain,
                ...loaded,
                core_memory: { ...brain.core_memory, ...(loaded.core_memory || {}) },
                behavior_profile: { ...brain.behavior_profile, ...(loaded.behavior_profile || {}) },
                user_state: { ...brain.user_state, ...(loaded.user_state || {}) }
            };
            sysLog('BRAIN-INIT', 'Loaded existing Brain State from Firestore (1 Read).');
        } else {
            await BRAIN_DOC_REF.set(brain);
            runtimeStats.firestoreWrites++;
            sysLog('BRAIN-INIT', 'Created fresh Brain State document in Firestore.');
        }

        syncLocalTimersWithBrain();
        startAutonomousBehavioralHeartbeat();

        // Single onSnapshot Listener (Zero Polling!)
        BRAIN_DOC_REF.onSnapshot((snap) => {
            if (!snap.exists) return;
            // Ignore local echo writes to prevent duplicate work
            if (Date.now() < localWriteLockUntil) return;

            runtimeStats.firestoreReads++;
            const extData = snap.data();
            brain = {
                ...brain,
                ...extData,
                core_memory: { ...brain.core_memory, ...(extData.core_memory || {}) },
                behavior_profile: { ...brain.behavior_profile, ...(extData.behavior_profile || {}) },
                user_state: { ...brain.user_state, ...(extData.user_state || {}) }
            };
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

    const activityInfo = getLearnedActivitySummary();
    const wakePrompt = `[AUTONOMOUS PROACTIVE WAKE-UP]
Current IST Time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}
Scheduled Task Reason: "${task.reason}"
Instruction: "${task.actionPrompt}"
Unanswered Check-ins Count: ${brain.user_state.unanswered_checkins}
User Health State: ${brain.user_state.health}
Emotional Stance: ${brain.behavior_profile?.emotional_stance || 'calm'}
Learned Activity Pattern: Peak Active Now=${activityInfo.isPeakActiveWindowNow}, Top Hours=${activityInfo.topActiveHoursIst.join(', ')}
Last Seen: ${Math.round((Date.now() - brain.user_state.last_seen_ms) / 60000)} minutes ago.

Think carefully back-and-forth about Siva's state. You can message Siva directly in natural Tanglish, schedule a follow-up check-in, use search_internet_natively if you want to share something useful or look up info, or if Siva is unresponsive across multiple check-ins, use trigger_emergency_ping or send_whatsapp_to_number.`;

    const wantVoice = brain.user_state.unanswered_checkins >= 2;
    const reply = await runAutonomousAgentTurn(wakePrompt, null, null, wantVoice, true);
    if (reply) {
        const targetJid = brain.last_active_admin_jid || ADMIN_JID;
        if (reply.voice && reply.voice.buffer) {
            await globalWaSocket.sendMessage(targetJid, {
                audio: reply.voice.buffer,
                mimetype: reply.voice.mimetype,
                ptt: true
            });
            appendConversationHistory('model', `[Proactive Voice]: ${reply.text}`);
        } else if (reply.text) {
            await globalWaSocket.sendMessage(targetJid, { text: reply.text });
            appendConversationHistory('model', `[Proactive]: ${reply.text}`);
        }
    }
}

// ============================================================================
// 3B. AUTONOMOUS HUMAN-LIKE HEARTBEAT, RANDOM CHECK-IN & PANIC ENGINE
// ============================================================================
// Runs silently every 20 minutes in Node.js (0 Gemini tokens unless triggered!)
function startAutonomousBehavioralHeartbeat() {
    if (autonomousHeartbeatInterval) clearInterval(autonomousHeartbeatInterval);

    autonomousHeartbeatInterval = setInterval(async () => {
        try {
            if (!globalWaSocket || runtimeStats.waStatus !== 'CONNECTED') return;

            const now = Date.now();
            // Respect DND unless Siva is marked sick or in emergency_watch
            const isCriticalHealth = brain.user_state.health === 'sick' || brain.user_state.health === 'emergency_watch';
            if (now < (brain.user_state.dnd_until || 0) && !isCriticalHealth) return;

            // Avoid clashing if a scheduled task is already firing within the next 15 minutes
            const imminentTask = (brain.scheduled_tasks || []).find(
                t => t.status === 'pending' && (t.executeAt - now) < 15 * 60000
            );
            if (imminentTask) return;

            const minsSilent = Math.round((now - (brain.user_state.last_seen_ms || now)) / 60000);
            const minsSinceLastSpontaneous = Math.round((now - (brain.behavior_profile?.last_proactive_spontaneous_ms || 0)) / 60000);
            const unanswered = brain.user_state.unanswered_checkins || 0;
            const activity = getLearnedActivitySummary();

            // Hard Cap: Never loop endlessly if we already escalated to maximum panic (unanswered >= 4)
            // Wait until Siva replies so we never drain API quota!
            if (unanswered >= 4) return;

            let triggerType = null;
            let panicInstruction = '';

            // CASE 1: Siva is in his learned Active Hour, we already checked in, and he STILL hasn't replied!
            if (unanswered === 1 && minsSilent >= 45 && minsSinceLastSpontaneous >= 40 && (activity.isPeakActiveWindowNow || isCriticalHealth)) {
                triggerType = 'CONCERNED_FOLLOWUP';
                brain.behavior_profile.emotional_stance = 'concerned';
                panicInstruction = `Siva is usually active around this hour (${activity.currentHourIst}:00 IST), and you already messaged him earlier, but he hasn't replied for ${minsSilent} minutes! Think like a close human companion who is starting to worry. Ask him in caring, slightly concerned Tanglish why he hasn't replied yet and if everything is okay.`;
            }
            // CASE 2: Second or Third unanswered check-in -> ESCALATE TO PANIC MODE!
            else if (unanswered >= 2 && minsSilent >= 75 && minsSinceLastSpontaneous >= 45) {
                triggerType = 'PANIC_ESCALATION';
                brain.behavior_profile.emotional_stance = 'panicking';
                panicInstruction = `URGENT SILENCE ANOMALY: Siva has ignored ${unanswered} consecutive check-ins and has been completely silent for ${minsSilent} minutes! Think back-and-forth about what could be happening based on his recent chat and health state (${brain.user_state.health}). Express genuine emotional panic/worry in Tanglish. If this is unanswered check-in #3, invoke trigger_emergency_ping to ring his phone with rapid-fire voice notes, or check if you should message a contact.`;
            }
            // CASE 3: Spontaneous Random Human-Like Initiation during Siva's Active Hours
            else if (unanswered === 0 && activity.isPeakActiveWindowNow && minsSilent >= 180 && minsSinceLastSpontaneous >= 180) {
                // Add natural human randomness (65% chance on this 20-min tick so it doesn't feel like a clockwork cron)
                if (Math.random() < 0.65) {
                    triggerType = 'SPONTANEOUS_COMPANION_CHAT';
                    brain.behavior_profile.emotional_stance = 'curious';
                    panicInstruction = `It is currently ${activity.currentHourIst}:00 IST—one of Siva's usual active/free hours—and you haven't talked for ${minsSilent} minutes. Initiate a spontaneous, warm, human-like conversation in Tanglish! You can ask what he's up to, follow up on something from core_memory/recent_chat, or use search_internet_natively to grab a quick interesting update on a topic he likes (${(brain.core_memory.likes_and_interests || []).join(', ') || 'tech, AI, Tamil Nadu news'}) and share it naturally.`;
                }
            }

            if (!triggerType) return;

            sysLog('HEARTBEAT-WAKE', `Autonomous Pattern Trigger [${triggerType}] (Silent: ${minsSilent}m, Unanswered: ${unanswered})`);
            brain.behavior_profile.last_proactive_spontaneous_ms = Date.now();
            brain.user_state.unanswered_checkins = unanswered + 1;
            saveBrainState(false);

            const heartbeatPrompt = `[AUTONOMOUS BEHAVIORAL HEARTBEAT: ${triggerType}]
Current IST Time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}
Minutes Since Siva Last Messaged: ${minsSilent} mins
Unanswered Proactive Messages In A Row: ${brain.user_state.unanswered_checkins}
Learned Peak Active Window Right Now: ${activity.isPeakActiveWindowNow}
Siva's Top Active Hours: ${activity.topActiveHoursIst.join(', ')}
Situation & Goal: ${panicInstruction}`;

            const sendAsVoice = triggerType === 'PANIC_ESCALATION';
            const reply = await runAutonomousAgentTurn(heartbeatPrompt, null, null, sendAsVoice, true);

            if (reply) {
                const targetJid = brain.last_active_admin_jid || ADMIN_JID;
                if (reply.voice && reply.voice.buffer) {
                    await globalWaSocket.sendMessage(targetJid, {
                        audio: reply.voice.buffer,
                        mimetype: reply.voice.mimetype,
                        ptt: true
                    });
                    appendConversationHistory('model', `[Autonomous Voice ${triggerType}]: ${reply.text}`);
                } else if (reply.text && reply.text !== 'Emergency protocol executed.') {
                    await globalWaSocket.sendMessage(targetJid, { text: reply.text });
                    appendConversationHistory('model', `[Autonomous ${triggerType}]: ${reply.text}`);
                }
            }
        } catch (err) {
            sysLog('HEARTBEAT-ERR', err.message);
        }
    }, 20 * 60 * 1000); // Checks every 20 minutes
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
// 6. GEMINI ROUND-ROBIN LOAD BALANCER + AUTOMATIC MODEL & KEY FAILOVER
// ============================================================================
function getNextApiKey() {
    const key = GEMINI_KEYS[runtimeStats.currentKeyIndex];
    runtimeStats.currentKeyIndex = (runtimeStats.currentKeyIndex + 1) % GEMINI_KEYS.length;
    return key;
}

async function callGeminiWithFailover(modelName, payload, customModelFallbacks = null) {
    let lastError = null;
    const modelsToTry = customModelFallbacks || (
        modelName === AUDIO_TTS_MODEL ? [...new Set(TTS_MODEL_FALLBACKS)] : [...new Set([modelName, ...TEXT_MODEL_FALLBACKS])]
    );
    const maxKeyAttempts = Math.min(GEMINI_KEYS.length, 4);

    for (const activeModel of modelsToTry) {
        for (let attempt = 0; attempt < maxKeyAttempts; attempt++) {
            const apiKey = getNextApiKey();
            runtimeStats.totalGeminiCalls++;
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${activeModel}:generateContent?key=${apiKey}`;

            try {
                const res = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

                const data = await res.json();

                if (res.status === 429 || res.status === 503) {
                    runtimeStats.keyRotations++;
                    sysLog('LOAD-BALANCER', `Key hit rate limit (${res.status}) on ${activeModel}. Rotating to next key...`);
                    continue;
                }

                // If a specific model ID is deprecated or not found (404/400), break inner loop to try next fallback model immediately
                if (res.status === 404 || (res.status === 400 && data?.error?.message?.toLowerCase().includes('model'))) {
                    lastError = new Error(data?.error?.message || `Model ${activeModel} unavailable`);
                    sysLog('MODEL-FALLBACK', `Model ${activeModel} unavailable (${lastError.message.slice(0, 80)}). Trying next model...`);
                    break;
                }

                if (!res.ok) {
                    throw new Error(data?.error?.message || `HTTP ${res.status}`);
                }

                return data;
            } catch (err) {
                lastError = err;
                sysLog('GEMINI-RETRY', `Attempt ${attempt + 1} (${activeModel}) failed: ${err.message}`);
            }
        }
    }
    throw lastError || new Error('All Gemini keys and fallback models exhausted');
}

// ============================================================================
// 6B. ZERO-SETUP NATIVE INTERNET SEARCH & EMERGENCY RAPID-FIRE PROTOCOL
// ============================================================================
function decodeHtmlEntities(str = '') {
    return str
        .replace(/<\/?[^>]+(>|$)/g, '')
        .replace(/&#x27;/g, "'")
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

async function nativeWebSearch(query) {
    sysLog('NATIVE-SEARCH', `Executing zero-setup web fetch for: "${query}"`);
    const results = [];

    // 1. Primary Scrape: DuckDuckGo HTML Lite (Zero API Key, Pure Fetch + Regex)
    try {
        const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
        const res = await fetch(ddgUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept-Language': 'en-IN,en;q=0.9,ta;q=0.8'
            }
        });

        if (res.ok) {
            const html = await res.text();
            const titleRegex = /<a[^>]*class="result__a"[^>]*>(.*?)<\/a>/gi;
            const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/gi;

            const titles = [];
            const snippets = [];
            let m;
            while ((m = titleRegex.exec(html)) !== null && titles.length < 5) {
                titles.push(decodeHtmlEntities(m[1]));
            }
            while ((m = snippetRegex.exec(html)) !== null && snippets.length < 5) {
                snippets.push(decodeHtmlEntities(m[1]));
            }

            for (let i = 0; i < Math.max(titles.length, snippets.length); i++) {
                const t = titles[i] || 'Web Result';
                const s = snippets[i] || '';
                if (s) results.push(`• [${t}]: ${s}`);
            }
        }
    } catch (e) {
        sysLog('SEARCH-WARN', `DDG HTML fetch warning: ${e.message}`);
    }

    // 2. Secondary Free Fallback: Wikipedia OpenSearch API (Great for factual/person/place queries like CM of Tamil Nadu)
    if (results.length < 2) {
        try {
            const wikiUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&utf8=&format=json&srlimit=3`;
            const wRes = await fetch(wikiUrl, {
                headers: { 'User-Agent': 'SivaAutonomousAgent/2.0 (Thoothukudi)' }
            });
            if (wRes.ok) {
                const wData = await wRes.json();
                const searchItems = wData?.query?.search || [];
                for (const item of searchItems) {
                    results.push(`• [Wiki: ${item.title}]: ${decodeHtmlEntities(item.snippet)}`);
                }
            }
        } catch (e) {
            sysLog('SEARCH-WARN', `Wiki fallback warning: ${e.message}`);
        }
    }

    if (results.length === 0) {
        return 'No direct snippets found for this exact query. Try rephrasing with simpler keywords and calling search_internet_natively again.';
    }

    return results.slice(0, 5).join('\n');
}

// High-Priority 3x Rapid-Fire Voice/Text Alarm Protocol
async function executeEmergencyPings(targetJid, sock, customReason = '') {
    sysLog('EMERGENCY-PING', `Triggering 3x Rapid-Fire High-Priority Pings to ${targetJid} (${customReason})`);

    const emergencyMessages = [
        `Boss! Emergency alert! Romba nerama unga kitta irundhu reply illa, enna aachu?`,
        `Naan thirumba thirumba message panren, please udane oru 'Hi' illana voice note podunga Boss!`,
        `Idhu high-priority check-in! Neenga safe-ah irukingala nu udane sollunga Boss!`
    ];

    for (const msg of emergencyMessages) {
        const voiceObj = await synthesizeGeminiVoice(msg);
        if (voiceObj && voiceObj.buffer) {
            await sock.sendMessage(targetJid, {
                audio: voiceObj.buffer,
                mimetype: voiceObj.mimetype,
                ptt: true
            });
        } else {
            await sock.sendMessage(targetJid, { text: `🚨 ${msg}` });
        }
        await new Promise(resolve => setTimeout(resolve, 1500));
    }
    return { status: 'emergency_pings_delivered', count: 3 };
}

// ============================================================================
// 7. MULTI-AGENT TOOLS & FUNCTION DECLARATIONS
// ============================================================================
const AGENT_TOOLS = [
    {
        functionDeclarations: [
            {
                name: 'manage_memory_and_state',
                description: 'Save permanent facts, likes/interests, or behavioral patterns to core_memory, update Siva health status (normal, sick, tired, emergency_watch), or set Do Not Disturb (DND) duration.',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        new_permanent_fact: { type: 'STRING', description: 'Important permanent fact about Siva to add to core_memory (never deleted).' },
                        new_like_or_interest: { type: 'STRING', description: 'Topic, hobby, food, or interest Siva likes.' },
                        new_behavior_pattern: { type: 'STRING', description: 'Observed habit, mood pattern, or communication preference of Siva.' },
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
                name: 'search_internet_natively',
                description: 'Zero-setup free native internet search. Fetches real-time web snippets & Wikipedia facts. If the first search is not relevant enough, think and call this again with a better search_query.',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        search_query: { type: 'STRING', description: 'Focused keywords to search on the internet' }
                    },
                    required: ['search_query']
                }
            },
            {
                name: 'spawn_research_subagent',
                description: 'Spawn a dedicated Research Sub-Agent using zero-setup native web scraping to research news, weather, current leaders, or emergency contacts and return a dense 3-point summary.',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        search_query: { type: 'STRING', description: 'Precise search query' },
                        research_goal: { type: 'STRING', description: 'What specific facts or numbers the sub-agent must extract' }
                    },
                    required: ['search_query', 'research_goal']
                }
            },
            {
                name: 'trigger_emergency_ping',
                description: 'CRITICAL HIGH-PRIORITY ALARM: Fires 3 rapid-fire voice note/text alarms in a row to wake up Siva phone when he is unresponsive for a long time or in an emergency.',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        reason: { type: 'STRING', description: 'Why you are triggering the emergency rapid-fire ping' }
                    },
                    required: ['reason']
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
                brain.core_memory.permanent_facts = brain.core_memory.permanent_facts || [];
                if (!brain.core_memory.permanent_facts.includes(args.new_permanent_fact)) {
                    brain.core_memory.permanent_facts.push(args.new_permanent_fact);
                }
            }
            if (args.new_like_or_interest) {
                brain.core_memory.likes_and_interests = brain.core_memory.likes_and_interests || [];
                if (!brain.core_memory.likes_and_interests.includes(args.new_like_or_interest)) {
                    brain.core_memory.likes_and_interests.push(args.new_like_or_interest);
                }
            }
            if (args.new_behavior_pattern) {
                brain.core_memory.habits_and_patterns = brain.core_memory.habits_and_patterns || [];
                if (!brain.core_memory.habits_and_patterns.includes(args.new_behavior_pattern)) {
                    brain.core_memory.habits_and_patterns.push(args.new_behavior_pattern);
                }
            }
            if (args.health_status) {
                brain.user_state.health = args.health_status;
            }
            if (typeof args.dnd_minutes === 'number') {
                brain.user_state.dnd_until = args.dnd_minutes > 0 ? Date.now() + args.dnd_minutes * 60000 : 0;
            }
            saveBrainState(false);
            return { status: 'success', updated_state: brain.user_state, memory_counts: {
                facts: brain.core_memory.permanent_facts.length,
                likes: (brain.core_memory.likes_and_interests || []).length,
                patterns: (brain.core_memory.habits_and_patterns || []).length
            }};
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
            const delayMs = Math.max(0.05, Number(args.delay_minutes)) * 60000;
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

        if (name === 'search_internet_natively') {
            const rawSnippets = await nativeWebSearch(args.search_query);
            return {
                status: 'search_complete',
                query_used: args.search_query,
                web_snippets: rawSnippets,
                hint: 'If these snippets do not fully answer the question, you may refine search_query and call search_internet_natively one more time.'
            };
        }

        if (name === 'spawn_research_subagent') {
            sysLog('SUB-AGENT', `Spawning Zero-Setup Search Sub-Agent for: "${args.search_query}"`);
            // Uses free nativeWebSearch first so it NEVER hits 429 quota walls on Google Search tool!
            const scrapedFacts = await nativeWebSearch(args.search_query);
            const subPayload = {
                systemInstruction: {
                    parts: [{ text: 'You are a terse Research Sub-Agent. Analyze the scraped web snippets and return ONLY a dense, factual 3-bullet summary answering the research goal. Include exact names, phone numbers, dates, or prices if found. Zero fluff.' }]
                },
                contents: [{
                    role: 'user',
                    parts: [{ text: `Search Query: ${args.search_query}\nResearch Goal: ${args.research_goal}\n\nLive Web Snippets:\n${scrapedFacts}` }]
                }]
            };
            const subRes = await callGeminiWithFailover(PRIMARY_MODEL, subPayload);
            const summary = subRes?.candidates?.[0]?.content?.parts?.map(p => p.text).join('\n') || scrapedFacts;
            return { status: 'research_complete', dense_findings: summary };
        }

        if (name === 'trigger_emergency_ping') {
            if (!globalWaSocket) return { status: 'error', message: 'WhatsApp socket not ready' };
            const targetJid = brain.last_active_admin_jid || ADMIN_JID;
            const pingRes = await executeEmergencyPings(targetJid, globalWaSocket, args.reason);
            return pingRes;
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
    const prompt = `Existing Rolling Summary:\n${brain.rolling_summary}\n\nExisting Likes/Interests:\n${JSON.stringify(brain.core_memory.likes_and_interests || [])}\n\nExisting Behavioral Patterns:\n${JSON.stringify(brain.core_memory.habits_and_patterns || [])}\n\nNew Conversation Turn(s) to merge:\n${JSON.stringify(oldMessages)}\n\nTask: Return ONLY valid JSON with:
1. "rolling_summary": Merge the new turns into Existing Rolling Summary in 3 concise sentences without losing key names, tasks, or emotional context.
2. "new_likes": Array of any NEW topics/things Siva likes discovered in these turns (or empty array []).
3. "new_patterns": Array of any NEW behavioral habits or communication patterns of Siva noticed in these turns (or empty array []).`;

    const res = await callGeminiWithFailover(PRIMARY_MODEL, {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json' }
    });

    const rawText = res?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (rawText) {
        try {
            const parsed = JSON.parse(rawText);
            if (parsed.rolling_summary) {
                brain.rolling_summary = parsed.rolling_summary.trim();
            }
            if (Array.isArray(parsed.new_likes)) {
                brain.core_memory.likes_and_interests = brain.core_memory.likes_and_interests || [];
                for (const item of parsed.new_likes) {
                    if (item && !brain.core_memory.likes_and_interests.includes(item)) {
                        brain.core_memory.likes_and_interests.push(item);
                    }
                }
            }
            if (Array.isArray(parsed.new_patterns)) {
                brain.core_memory.habits_and_patterns = brain.core_memory.habits_and_patterns || [];
                for (const pat of parsed.new_patterns) {
                    if (pat && !brain.core_memory.habits_and_patterns.includes(pat)) {
                        brain.core_memory.habits_and_patterns.push(pat);
                    }
                }
            }
        } catch {
            // Fallback if model returned plain text instead of JSON
            brain.rolling_summary = rawText.trim();
        }
        sysLog('MEMORY-ROLL', 'Compressed old chat turns + learned patterns into rolling_summary (Token Saver).');
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
        const res = await callGeminiWithFailover(AUDIO_TTS_MODEL, payload, TTS_MODEL_FALLBACKS);
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
    const learnedActivity = getLearnedActivitySummary();

    const compactContext = {
        current_ist_time: nowIst,
        core_memory: brain.core_memory,
        learned_activity_profile: {
            is_siva_usual_active_hour_now: learnedActivity.isPeakActiveWindowNow,
            top_active_hours_ist: learnedActivity.topActiveHoursIst,
            avg_reply_delay_mins: brain.behavior_profile?.avg_reply_delay_mins || 15,
            agent_emotional_stance: brain.behavior_profile?.emotional_stance || 'calm'
        },
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

    // Bounded Back-and-Forth Autonomous ReAct Loop (Strictly capped at 3 iterations to prevent token loops!)
    const MAX_THOUGHT_LOOPS = 3;
    for (let step = 0; step < MAX_THOUGHT_LOOPS; step++) {
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

        sysLog('THOUGHT-LOOP', `Step ${step + 1}/${MAX_THOUGHT_LOOPS}: Agent executing ${functionCalls.length} autonomous action(s)...`);

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

    // Circuit Breaker: If the agent used all 3 thought/search steps without outputting final text,
    // make 1 final tool-free synthesis call so Siva always gets a complete, intelligent answer without looping!
    try {
        contents.push({
            role: 'user',
            parts: [{ text: '[SYSTEM CIRCUIT BREAKER]: Maximum thought/search steps reached. Synthesize everything you gathered and provide your final natural Tanglish response to Siva now.' }]
        });
        const finalRes = await callGeminiWithFailover(PRIMARY_MODEL, {
            systemInstruction: { parts: [{ text: brain.system_persona }] },
            contents
        });
        const finalText = finalRes?.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join('\n').trim() || 'Boss, ellam check panniten!';
        let voiceObj = null;
        if (wantVoiceReply && finalText) {
            voiceObj = await synthesizeGeminiVoice(finalText);
        }
        return { text: finalText, voice: voiceObj };
    } catch {
        return { text: 'Boss, task update panniten.', voice: null };
    }
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

            // Record Siva's hourly activity heatmap, reset unanswered check-ins & calm panic state!
            recordUserActivityPattern();

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
    const learnedActivity = getLearnedActivitySummary();
    res.json({
        ...runtimeStats,
        ramRssMb: Math.round(mem.rss / 1024 / 1024),
        ramHeapMb: Math.round(mem.heapUsed / 1024 / 1024),
        totalKeys: GEMINI_KEYS.length,
        activeTimersCount: activeTaskTimers.size,
        brainSnapshot: {
            health: brain.user_state?.health,
            emotionalStance: brain.behavior_profile?.emotional_stance || 'calm',
            topActiveHours: learnedActivity.topActiveHoursIst.join(', '),
            unansweredCheckins: brain.user_state?.unanswered_checkins || 0,
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
            <div class="stat-row"><span>Owner Health / AI Stance</span><span id="userHealth" class="stat-val">normal</span></div>
            <div class="stat-row"><span>DND Mode Until</span><span id="dndUntil" class="stat-val">OFF</span></div>
            <div class="stat-row"><span>Core Facts / Contacts</span><span id="factsCount" class="stat-val">0 / 0</span></div>
            <div class="stat-row"><span>Peak Active Hours</span><span id="peakHours" class="stat-val" style="font-size:0.78rem;">Learning...</span></div>
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
            document.getElementById('userHealth').textContent = data.brainSnapshot.health + ' / ' + (data.brainSnapshot.emotionalStance || 'calm');
            document.getElementById('dndUntil').textContent = data.brainSnapshot.dndUntil;
            document.getElementById('factsCount').textContent = data.brainSnapshot.factsCount + ' Facts / ' + data.brainSnapshot.contactsCount + ' Contacts';
            document.getElementById('peakHours').textContent = data.brainSnapshot.topActiveHours || 'Learning...';
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
