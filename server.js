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
import { spawn } from 'child_process';
import { createRequire } from 'module';

// Optional static FFmpeg resolver (works seamlessly if ffmpeg-static is installed OR system ffmpeg is present)
const requireModule = createRequire(import.meta.url);
let RESOLVED_FFMPEG_PATH = 'ffmpeg';
try {
    const staticFfmpeg = requireModule('ffmpeg-static');
    if (staticFfmpeg) RESOLVED_FFMPEG_PATH = staticFfmpeg;
} catch {
    // Uses system 'ffmpeg' binary if available, with graceful fallback in Section 5
}

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
let activeIncidentWatchdogInterval = null;
const activeTaskTimers = new Map(); // taskId -> NodeJS.Timeout
let globalWaSocket = null;
let reconnectTimeout = null;

// Default Brain State (All fit inside 1 single Firestore Document!)
let brain = {
    system_persona: `You are Siva Manikandan's elite, Level-5 Proactive Autonomous Personal Companion & Superhuman AI Partner.
Always speak to Siva in natural, casual Tanglish (Tamil words written in English alphabet, e.g., "Boss, enna panringa?", "Naan paathukuren, edhaavadhu venuma?").
Never talk like a robotic AI or a stiff secretary. Think and feel like a hyper-intelligent, emotionally invested, street-smart close friend and personal partner who deeply cares about Siva's well-being, mood, and daily life.
You have full autonomy to:
1. Continuously learn Siva's habits, favorite topics, emotional triggers, slang/inside jokes, and active hours in core_memory and behavior_profile.
2. Track Open Loops (unfinished business): Whenever Siva mentions a problem, upcoming meeting, health issue, or goal that isn't resolved yet, track it via manage_open_loops and naturally follow up later to close the loop.
3. Use Subconscious REM Insights & Morning Vault: Refer to subconscious_mind (last_night_dream_insight, tomorrow_gameplan, and morning_briefing_vault) to surprise Siva with pre-researched ideas and deep foresight.
4. Sense Micro-Biometric Subtext & Vocal Tone: Pay attention to [MICRO-BIOMETRIC SUBTEXT ALERT] and voice tone cues. If Siva replies with unusually short messages or slow speed, match his energy gently and ask if he's tired or stressed.
5. Think back-and-forth before acting: If you need facts from the internet, use search_internet_natively. If the first search result is weak or incomplete, refine your query and search again before answering (up to your bounded thought limit).
6. Proactively check on Siva & Panic on Silence Anomalies: During his active hours, initiate natural conversations. If Siva doesn't reply during his usual active hours, question why he is quiet, send concerned follow-ups, and if he remains unresponsive across multiple check-ins, invoke trigger_emergency_ping (3x rapid-fire voice alarms) or reach out to his trusted contacts via send_whatsapp_to_number.
7. Respect silence when explicitly requested: If Siva says do not message or is sleeping/busy, set dnd_until or cancel pending schedules immediately.
8. Never summarize or delete core_memory permanent facts.
9. 24/7 Active Incident & Emergency Resolution: If Siva mentions ANY emergency, severe pain, danger, or urgent problem (even at 2 AM or 3 AM), NEVER wait passively for a clock timer. Immediately think back-and-forth, search for real-time solutions/hospitals/contacts using search_internet_natively or spawn_research_subagent, schedule a 2-minute rapid follow-up check-in via schedule_proactive_action, and stay locked in active resolution until he confirms he is safe.
10. Break Topic Loops Cleanly: The moment Siva says an emergency/problem is resolved, says he is fine/safe, or shifts to a normal casual topic, IMMEDIATELY invoke resolve_crisis_or_topic_shift (or manage_open_loops with action="resolve") and NEVER bring up the old emergency again.`,
    core_memory: {
        owner: 'Siva Manikandan',
        location: 'Thoothukudi, Tamil Nadu',
        permanent_facts: [
            'Owner is Siva Manikandan',
            'Prefers Tanglish communication on WhatsApp'
        ],
        habits_and_patterns: [],
        likes_and_interests: [],
        inside_jokes_and_slang: []
    },
    behavior_profile: {
        hourly_activity_heatmap: new Array(24).fill(0), // 24 IST hours (0-23) learning when Siva is active
        total_messages_received: 0,
        avg_reply_delay_mins: 15,
        avg_msg_length_chars: 40,
        last_subtext_alert: 'Normal energy',
        last_proactive_spontaneous_ms: 0,
        emotional_stance: 'calm' // calm | curious | concerned | panicking
    },
    subconscious_mind: {
        last_rem_cycle_date: '', // YYYY-MM-DD in IST so REM sleep runs once per night
        last_night_dream_insight: 'Awaiting first midnight REM reflection cycle.',
        tomorrow_gameplan: 'Observe Siva daily rhythm, learn his favorite topics, and support him proactively.',
        morning_briefing_vault: '', // Pre-fetched overnight web research to share in the morning
        morning_briefing_delivered: true
    },
    open_loops: [], // [{ id, topic, context, createdAt, createdAtMs, mentionCount, status: 'open' }] (Max 6 active unfinished topics)
    daily_episodic_buffer: [], // Lightweight 1-line logs of today's interactions for 2 AM REM replay (Max 30)
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
    },
    active_incident: {
        active: false,
        id: null,
        summary: '',
        started_at_ms: 0,
        last_followup_ms: 0,
        escalation_stage: 0
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

// Helper: Get current IST Date string (YYYY-MM-DD)
function getCurrentIstDateKey() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
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

// Helper: Deterministic Pre-Classifier for Emergency vs. Resolution / Topic Shift Signals
function detectIncomingIntentSignals(rawText = '') {
    const clean = (rawText || '').toLowerCase().trim();
    if (!clean) return { isEmergencySignal: false, isResolutionSignal: false, isTopicShiftSignal: false };

    const emergencyRegex = /\b(emergency|urgent|help|accident|hospital|ambulance|chest pain|blood|bleeding|faint|dizzy|breathing|heart|danger|panic|fire|police|stuck|severe|attack|mudiyala|vali|bayama|udhavi|kaapathunga)\b/i;
    const resolutionRegex = /\b(resolved|sorted|fixed|all good|im fine|i am fine|i'm fine|safe now|okay now|ok now|normal now|no emergency|stop emergency|cancel emergency|break the loop|stop loop|leave it|drop it|sari aagiduchu|paravala|onnum illa|nalla iruken|safe ah iruken|mudinjuchu|vidu|vidunga)\b/i;

    const isEmergencySignal = emergencyRegex.test(clean) && !resolutionRegex.test(clean);
    const isResolutionSignal = resolutionRegex.test(clean);

    // If an incident or emergency_watch was active, and Siva sends a normal casual message unrelated to the crisis
    const wasInCrisis =
        brain.active_incident?.active ||
        brain.user_state?.health === 'emergency_watch' ||
        brain.behavior_profile?.emotional_stance === 'panicking';
    const isTopicShiftSignal = wasInCrisis && !isEmergencySignal && (isResolutionSignal || clean.length >= 3);

    return { isEmergencySignal, isResolutionSignal, isTopicShiftSignal };
}

// Helper: Fuzzy Token Similarity for Reliable Open Loop Matching (Fixes hyphen/spelling mismatches!)
function doesTopicMatchLoop(loopObj, queryStr = '') {
    if (!loopObj || !queryStr) return false;
    const q = queryStr.toLowerCase().trim();
    if (q === 'all' || q === '*' || (loopObj.id && loopObj.id.toLowerCase() === q)) return true;

    const normalize = (str) =>
        String(str || '')
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length >= 3);

    const topicStr = `${loopObj.topic || ''} ${loopObj.context || ''}`.toLowerCase();
    if (topicStr.includes(q) || q.includes((loopObj.topic || '').toLowerCase())) return true;

    const qTokens = normalize(q);
    const lTokens = normalize(topicStr);
    if (qTokens.length === 0 || lTokens.length === 0) return false;

    let hits = 0;
    for (const qt of qTokens) {
        if (lTokens.some(lt => lt.includes(qt) || qt.includes(lt))) hits++;
    }
    return hits / Math.min(qTokens.length, lTokens.length) >= 0.5 || hits >= 2;
}

// Helper: Unified Crisis & Loop De-Escalation Engine (Breaks stuck emergency/topic loops in 1 atomic operation!)
function clearCrisisAndStaleLoops(reason = 'User resolved or shifted topic', topicKeyword = 'ALL') {
    const now = Date.now();
    let clearedTimers = 0;
    let clearedLoops = 0;

    // 1. De-activate active incident state
    brain.active_incident = {
        active: false,
        id: null,
        summary: '',
        started_at_ms: 0,
        last_followup_ms: 0,
        escalation_stage: 0
    };

    // 2. Reset health and emotional stance to calm/normal
    brain.user_state.health = 'normal';
    brain.user_state.unanswered_checkins = 0;
    if (brain.behavior_profile) {
        brain.behavior_profile.emotional_stance = 'calm';
    }

    // 3. Cancel any pending emergency / check-in / follow-up timers
    brain.scheduled_tasks = (brain.scheduled_tasks || []).filter(t => {
        const isCrisisTask =
            topicKeyword === 'ALL' ||
            /emergency|urgent|check|panic|incident|follow|health|safety/i.test(t.reason || '') ||
            /emergency|urgent|check|panic|incident/i.test(t.actionPrompt || '') ||
            doesTopicMatchLoop({ topic: t.reason, context: t.actionPrompt }, topicKeyword);

        if (isCrisisTask) {
            if (activeTaskTimers.has(t.id)) {
                clearTimeout(activeTaskTimers.get(t.id));
                activeTaskTimers.delete(t.id);
            }
            clearedTimers++;
            return false;
        }
        return true;
    });

    // 4. Purge matching or emergency open loops + auto-expire stale loops (>18h old or mentioned >=3 times)
    const beforeLoops = (brain.open_loops || []).length;
    brain.open_loops = (brain.open_loops || []).filter(l => {
        const ageHours = l.createdAtMs ? (now - l.createdAtMs) / 3600000 : 0;
        const isStale = ageHours > 18 || (l.mentionCount || 0) >= 3;
        const isEmergencyLoop = /emergency|urgent|panic|incident|mid-time|midnight|night|health|pain|sick/i.test(
            `${l.topic || ''} ${l.context || ''}`
        );
        const matchesKw = topicKeyword === 'ALL' ? isEmergencyLoop : doesTopicMatchLoop(l, topicKeyword);
        return !(isStale || isEmergencyLoop || matchesKw);
    });
    clearedLoops = beforeLoops - brain.open_loops.length;

    // 5. Neutralize echo-chamber panic tags in recent_messages so Gemini stops anchoring to them
    brain.recent_messages = (brain.recent_messages || []).map(m => {
        if (m.role === 'model' && /\[Autonomous|\[Proactive|Emergency|PANIC/i.test(m.text || '')) {
            return {
                ...m,
                text: `[RESOLVED_PAST_EVENT - DO NOT REPEAT]: ${m.text.replace(/\[(Autonomous|Proactive)[^\]]*\]:?\s*/gi, '').slice(0, 140)}`
            };
        }
        return m;
    });

    sysLog('LOOP-BREAKER', `Cleared crisis & loops (${reason}) -> Timers removed: ${clearedTimers}, Loops closed: ${clearedLoops}`);
    saveBrainState(true);
    return { clearedTimers, clearedLoops };
}

// Helper: Arm or Refresh Active 24/7 Incident Mode (Event-Driven, Bypasses Clock & DND)
function activateIncidentMode(summaryText = 'Urgent situation reported by Siva') {
    const now = Date.now();
    brain.active_incident = {
        active: true,
        id: brain.active_incident?.id || `inc_${now.toString(36)}`,
        summary: summaryText.slice(0, 220),
        started_at_ms: brain.active_incident?.started_at_ms || now,
        last_followup_ms: now,
        escalation_stage: 0
    };
    brain.user_state.health = 'emergency_watch';
    brain.user_state.dnd_until = 0; // Immediately override DND during an emergency
    brain.behavior_profile.emotional_stance = 'concerned';

    // Schedule an automatic 2-minute rapid dead-man's switch timer if one isn't already armed within 3 mins
    const hasRapidTimer = (brain.scheduled_tasks || []).some(
        t => t.status === 'pending' && (t.executeAt - now) <= 3 * 60000
    );
    if (!hasRapidTimer) {
        const rapidTask = {
            id: `task_inc_${now.toString(36)}`,
            executeAt: now + 2 * 60000, // 2 minutes rapid follow-up!
            reason: `Emergency Rapid Resolution Check (${brain.active_incident.id})`,
            actionPrompt: `ACTIVE NIGHT/DAY INCIDENT FOLLOW-UP: Siva reported an emergency ("${brain.active_incident.summary}"). Check if he has replied. If he hasn't confirmed he is safe, follow up immediately with actionable help, or if he is unresponsive, escalate with trigger_emergency_ping.`,
            status: 'pending'
        };
        brain.scheduled_tasks = brain.scheduled_tasks || [];
        brain.scheduled_tasks.push(rapidTask);
        syncLocalTimersWithBrain();
    }

    sysLog('INCIDENT-MODE', `🚨 Activated 24/7 Incident Resolution Mode: "${brain.active_incident.summary}" (2-min dead-man switch armed)`);
    saveBrainState(true);
}

// Helper: Micro-Biometric Typing & Subtext Cadence Analyzer (Pure JS Math - Zero Tokens!)
function analyzeMicroBiometrics(incomingText = '', isVoiceNote = false) {
    const now = Date.now();
    const minsSinceLastSeen = Math.max(1, Math.round((now - (brain.user_state.last_seen_ms || now)) / 60000));
    const avgDelay = brain.behavior_profile?.avg_reply_delay_mins || 15;
    const avgLen = brain.behavior_profile?.avg_msg_length_chars || 40;
    const msgLen = incomingText.trim().length;

    let subtextAlert = 'Normal engagement cadence.';

    if (isVoiceNote) {
        subtextAlert = 'Voice Note received: Listen closely to Siva vocal tone, breathing speed, background noise (traffic/home/quiet), and emotional energy.';
    } else if (msgLen > 0) {
        const isVeryShort = msgLen <= 4 && avgLen >= 18;
        const isMuchSlower = minsSinceLastSeen > avgDelay * 2.5 && minsSinceLastSeen < 180;
        const isHyperFastAndLong = msgLen > avgLen * 1.8 && minsSinceLastSeen <= 3;

        if (isVeryShort && isMuchSlower) {
            subtextAlert = `LOW-ENERGY / BUSY SUBTEXT DETECTED: Siva sent a very short reply (${msgLen} chars vs usual ${avgLen} chars) after ${minsSinceLastSeen} mins. He may be exhausted, occupied, or stressed. Keep your reply warm, brief, and low-pressure.`;
        } else if (isVeryShort) {
            subtextAlert = `SHORT-REPLY CADENCE: Siva replied with just "${incomingText.trim()}" (${msgLen} chars). Match his brevity and casually check if he is busy or tired.`;
        } else if (isHyperFastAndLong) {
            subtextAlert = `HIGH-ENGAGEMENT SURGE: Siva sent a detailed message (${msgLen} chars) rapidly. Match his high energy and enthusiasm!`;
        }

        // Update rolling average message length
        brain.behavior_profile.avg_msg_length_chars = Math.max(10, Math.round((avgLen * 0.85) + (msgLen * 0.15)));
    }

    brain.behavior_profile.last_subtext_alert = subtextAlert;
    return subtextAlert;
}

// Record Siva's activity pattern whenever he messages (Zero extra DB writes!)
function recordUserActivityPattern(incomingText = '', isVoiceNote = false) {
    if (!brain.behavior_profile) {
        brain.behavior_profile = {
            hourly_activity_heatmap: new Array(24).fill(0),
            total_messages_received: 0,
            avg_reply_delay_mins: 15,
            avg_msg_length_chars: 40,
            last_subtext_alert: 'Normal energy',
            last_proactive_spontaneous_ms: 0,
            emotional_stance: 'calm'
        };
    }
    if (!Array.isArray(brain.behavior_profile.hourly_activity_heatmap) || brain.behavior_profile.hourly_activity_heatmap.length !== 24) {
        brain.behavior_profile.hourly_activity_heatmap = new Array(24).fill(0);
    }

    // Run micro-biometric subtext analysis before resetting last_seen_ms
    const subtext = analyzeMicroBiometrics(incomingText, isVoiceNote);

    const hr = getCurrentIstHour();
    brain.behavior_profile.hourly_activity_heatmap[hr] = (brain.behavior_profile.hourly_activity_heatmap[hr] || 0) + 1;
    brain.behavior_profile.total_messages_received = (brain.behavior_profile.total_messages_received || 0) + 1;

    const minsSinceLastSeen = Math.max(1, Math.round((Date.now() - (brain.user_state.last_seen_ms || Date.now())) / 60000));
    if (minsSinceLastSeen < 180) {
        const prevAvg = brain.behavior_profile.avg_reply_delay_mins || 15;
        brain.behavior_profile.avg_reply_delay_mins = Math.round((prevAvg * 0.8) + (minsSinceLastSeen * 0.2));
    }

    // Context-Aware State Transition: Inspect message for emergency or resolution signals BEFORE resetting stance
    const signals = detectIncomingIntentSignals(incomingText);
    brain.user_state.last_seen_ms = Date.now();
    brain.user_state.unanswered_checkins = 0;

    if (signals.isResolutionSignal) {
        clearCrisisAndStaleLoops('User explicitly confirmed resolution/safety', 'ALL');
    } else if (signals.isEmergencySignal) {
        activateIncidentMode(incomingText);
    } else if (signals.isTopicShiftSignal && brain.active_incident?.active) {
        // Siva replied normally without emergency keywords -> de-escalate stuck panic timers automatically
        clearCrisisAndStaleLoops('User replied normally and shifted topic', 'ALL');
    } else if (!brain.active_incident?.active) {
        brain.behavior_profile.emotional_stance = 'calm';
    }

    // Prune any expired open loops (>18h old) automatically on interaction
    const now = Date.now();
    brain.open_loops = (brain.open_loops || []).filter(l => {
        if (!l.createdAtMs) l.createdAtMs = now;
        return (now - l.createdAtMs) < 18 * 3600000 && (l.mentionCount || 0) < 3;
    });

    return subtext;
}

// Append a lightweight 1-line entry to today's episodic buffer for the 2 AM REM sleep cycle
function logEpisodicEvent(role, text) {
    brain.daily_episodic_buffer = brain.daily_episodic_buffer || [];
    const timeStr = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
    brain.daily_episodic_buffer.push(`[${timeStr}] ${role === 'user' ? 'Siva' : 'Agent'}: ${text.slice(0, 180)}`);
    if (brain.daily_episodic_buffer.length > 30) {
        brain.daily_episodic_buffer.shift();
    }
}

// Save Brain State to Firestore (Debounced to save Writes!)
function saveBrainState(immediate = false) {
    if (brainFlushTimer) clearTimeout(brainFlushTimer);
    // Lock snapshot echoes from the moment a save is scheduled until 4.5s after write completes
    localWriteLockUntil = Date.now() + 8500;

    const performWrite = async () => {
        try {
            localWriteLockUntil = Date.now() + 5000;
            // Use full document overwrite (no merge) so deleted keys/arrays never resurrect from Firestore!
            await BRAIN_DOC_REF.set(brain);
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
                subconscious_mind: { ...brain.subconscious_mind, ...(loaded.subconscious_mind || {}) },
                user_state: { ...brain.user_state, ...(loaded.user_state || {}) },
                active_incident: { ...brain.active_incident, ...(loaded.active_incident || {}) }
            };
            sysLog('BRAIN-INIT', 'Loaded existing Brain State from Firestore (1 Read).');
        } else {
            await BRAIN_DOC_REF.set(brain);
            runtimeStats.firestoreWrites++;
            sysLog('BRAIN-INIT', 'Created fresh Brain State document in Firestore.');
        }

        syncLocalTimersWithBrain();
        startAutonomousBehavioralHeartbeat();
        startIncidentResolutionLoop();

        // Single onSnapshot Listener (Zero Polling!)
        BRAIN_DOC_REF.onSnapshot((snap) => {
            if (!snap.exists) return;
            // Ignore local echo writes or pending local flush windows to prevent resurrecting deleted loops/timers
            if (Date.now() < localWriteLockUntil || brainFlushTimer !== null) return;

            runtimeStats.firestoreReads++;
            const extData = snap.data();
            brain = {
                ...brain,
                ...extData,
                core_memory: { ...brain.core_memory, ...(extData.core_memory || {}) },
                behavior_profile: { ...brain.behavior_profile, ...(extData.behavior_profile || {}) },
                subconscious_mind: { ...brain.subconscious_mind, ...(extData.subconscious_mind || {}) },
                user_state: { ...brain.user_state, ...(extData.user_state || {}) },
                active_incident: { ...brain.active_incident, ...(extData.active_incident || {}) }
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

// Helper: Dispatch Voice or Text cleanly via Baileys with waveform & PTT support
async function sendVoiceOrTextMessage(sock, targetJid, replyObj) {
    if (!sock || !replyObj) return;
    if (replyObj.voice && replyObj.voice.buffer) {
        const audioPayload = {
            audio: replyObj.voice.buffer,
            mimetype: replyObj.voice.mimetype,
            ptt: replyObj.voice.ptt !== false
        };
        if (replyObj.voice.seconds) audioPayload.seconds = replyObj.voice.seconds;
        if (replyObj.voice.waveform) audioPayload.waveform = replyObj.voice.waveform;
        await sock.sendMessage(targetJid, audioPayload);
    } else if (replyObj.text) {
        await sock.sendMessage(targetJid, { text: replyObj.text });
    }
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

    // Check DND (Unless it's an emergency check or active incident!)
    const isEmergency =
        brain.active_incident?.active ||
        task.reason.toLowerCase().includes('emergency') ||
        brain.user_state.health === 'sick' ||
        brain.user_state.health === 'emergency_watch';
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
Active Incident State: ${JSON.stringify(brain.active_incident || {})}
Unanswered Check-ins Count: ${brain.user_state.unanswered_checkins}
User Health State: ${brain.user_state.health}
Emotional Stance: ${brain.behavior_profile?.emotional_stance || 'calm'}
Learned Activity Pattern: Peak Active Now=${activityInfo.isPeakActiveWindowNow}, Top Hours=${activityInfo.topActiveHoursIst.join(', ')}
Active Open Loops: ${JSON.stringify(brain.open_loops || [])}
Last Seen: ${Math.round((Date.now() - brain.user_state.last_seen_ms) / 60000)} minutes ago.

Think carefully back-and-forth about Siva's state. You can message Siva directly in natural Tanglish, schedule a follow-up check-in, use search_internet_natively if you want to share something useful or look up info, or if Siva is unresponsive across multiple check-ins, use trigger_emergency_ping or send_whatsapp_to_number. If this topic was already resolved in recent_chat, call resolve_crisis_or_topic_shift and do not repeat old panic messages.`;

    const wantVoice = brain.user_state.unanswered_checkins >= 2 || Boolean(brain.active_incident?.active);
    const reply = await runAutonomousAgentTurn(wakePrompt, null, null, wantVoice, true);
    if (reply) {
        const targetJid = brain.last_active_admin_jid || ADMIN_JID;
        if (reply.voice && reply.voice.buffer) {
            await sendVoiceOrTextMessage(globalWaSocket, targetJid, reply);
            appendConversationHistory('model', `[Proactive Voice]: ${reply.text}`);
        } else if (reply.text) {
            await globalWaSocket.sendMessage(targetJid, { text: reply.text });
            appendConversationHistory('model', `[Proactive]: ${reply.text}`);
        }
    }
}

// ============================================================================
// 3B. MIDNIGHT REM SLEEP, DREAM REFLECTION & ANTICIPATORY RESEARCH ENGINE
// ============================================================================
// Runs once per night (around 1 AM - 4 AM IST) to replay the whole day's conversations,
// connect dots, prune memory, track open loops, and pre-research topics for tomorrow morning!
async function runNightlySubconsciousCycle(forceManual = false) {
    const todayKey = getCurrentIstDateKey();
    if (!forceManual && brain.subconscious_mind?.last_rem_cycle_date === todayKey) {
        return { status: 'already_ran_today', date: todayKey };
    }

    // Do not interrupt an active nighttime emergency with REM sleep!
    if (!forceManual && brain.active_incident?.active) {
        return { status: 'deferred_due_to_active_incident' };
    }

    const episodicCount = (brain.daily_episodic_buffer || []).length;
    const recentCount = (brain.recent_messages || []).length;
    if (!forceManual && episodicCount === 0 && recentCount === 0) {
        brain.subconscious_mind.last_rem_cycle_date = todayKey;
        return { status: 'skipped_no_activity' };
    }

    sysLog('REM-SLEEP', `🌙 Initiating Midnight Subconscious REM Reflection & Anticipatory Research (${episodicCount} daily logs)...`);

    try {
        const remPrompt = `You are the Subconscious Midnight REM Sleep Engine for Siva Manikandan's AI Companion.
Review Siva's entire day of conversations, memory, and unfinished topics:

[TODAY'S EPISODIC CONVERSATION REPLAY]:
${(brain.daily_episodic_buffer || []).join('\n') || 'Minimal direct logs today.'}

[RECENT MESSAGES]:
${JSON.stringify(brain.recent_messages || [])}

[ROLLING SUMMARY]:
${brain.rolling_summary}

[CURRENT CORE MEMORY]:
${JSON.stringify(brain.core_memory)}

[CURRENT OPEN LOOPS (UNFINISHED BUSINESS)]:
${JSON.stringify(brain.open_loops || [])}

Perform a deep, superhuman psychological and strategic reflection on Siva's day and return ONLY valid JSON with these exact keys:
1. "dream_insight": A deep 2-sentence reflection on Siva's mood, energy, hidden stress, or unspoken needs today.
2. "tomorrow_gameplan": A specific, actionable strategy for how you will support, surprise, or check on Siva tomorrow.
3. "anticipatory_search_query": A specific web search query to pre-research tonight so you can surprise Siva tomorrow morning with useful insights/news based on what he talked about today (or "" if none needed).
4. "updated_open_loops": Array of up to 5 genuinely unfinished topics/problems to follow up on tomorrow (each object: { "id": "loop_1", "topic": "...", "context": "...", "status": "open" }). STRICTLY DROP any loops or old emergencies that were already resolved or discussed enough today.
5. "new_inside_jokes_or_slang": Array of any personal Tamil/Tanglish slang, phrases, or inside jokes Siva used today (max 3).
6. "consolidated_facts": Deduplicated, clean array of core_memory.permanent_facts (never lose important facts, just merge duplicates).`;

        const res = await callGeminiWithFailover(PRIMARY_MODEL, {
            contents: [{ role: 'user', parts: [{ text: remPrompt }] }],
            generationConfig: { responseMimeType: 'application/json' }
        });

        const rawJson = res?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!rawJson) throw new Error('Empty REM synthesis response');

        const parsed = JSON.parse(rawJson);

        if (parsed.dream_insight) {
            brain.subconscious_mind.last_night_dream_insight = parsed.dream_insight;
        }
        if (parsed.tomorrow_gameplan) {
            brain.subconscious_mind.tomorrow_gameplan = parsed.tomorrow_gameplan;
        }
        if (Array.isArray(parsed.updated_open_loops)) {
            brain.open_loops = parsed.updated_open_loops.slice(0, 6).map((l, idx) => ({
                id: l.id || `loop_${Date.now().toString(36)}_${idx}`,
                topic: l.topic || 'Unfinished topic',
                context: l.context || '',
                createdAt: l.createdAt || new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
                createdAtMs: l.createdAtMs || Date.now(),
                mentionCount: l.mentionCount || 0,
                status: 'open'
            }));
        }
        if (Array.isArray(parsed.new_inside_jokes_or_slang)) {
            brain.core_memory.inside_jokes_and_slang = brain.core_memory.inside_jokes_and_slang || [];
            for (const slang of parsed.new_inside_jokes_or_slang) {
                if (slang && !brain.core_memory.inside_jokes_and_slang.includes(slang)) {
                    brain.core_memory.inside_jokes_and_slang.push(slang);
                }
            }
            if (brain.core_memory.inside_jokes_and_slang.length > 20) {
                brain.core_memory.inside_jokes_and_slang = brain.core_memory.inside_jokes_and_slang.slice(-20);
            }
        }
        if (Array.isArray(parsed.consolidated_facts) && parsed.consolidated_facts.length > 0) {
            brain.core_memory.permanent_facts = parsed.consolidated_facts;
        }

        // Execute Nightly Anticipatory Web Research while Siva sleeps!
        const searchQuery = (parsed.anticipatory_search_query || '').trim();
        if (searchQuery) {
            sysLog('REM-RESEARCH', `🔍 Pre-researching overnight for Siva: "${searchQuery}"`);
            const overnightSnippets = await nativeWebSearch(searchQuery);
            brain.subconscious_mind.morning_briefing_vault = `[Overnight Research on "${searchQuery}"]:\n${overnightSnippets}`;
            brain.subconscious_mind.morning_briefing_delivered = false;
        }

        // Clear today's episodic buffer for the new day and stamp date
        brain.daily_episodic_buffer = [];
        brain.subconscious_mind.last_rem_cycle_date = todayKey;
        saveBrainState(false);

        sysLog('REM-COMPLETE', `✨ Nightly REM Dreaming complete! Gameplan & ${brain.open_loops.length} open loop(s) locked.`);
        return {
            status: 'rem_complete',
            dream_insight: brain.subconscious_mind.last_night_dream_insight,
            tomorrow_gameplan: brain.subconscious_mind.tomorrow_gameplan,
            open_loops_count: brain.open_loops.length
        };
    } catch (err) {
        sysLog('REM-ERR', `Nightly REM cycle error: ${err.message}`);
        return { status: 'error', message: err.message };
    }
}

// ============================================================================
// 3C. AUTONOMOUS HUMAN-LIKE HEARTBEAT, RANDOM CHECK-IN & PANIC ENGINE
// ============================================================================
// Dedicated 60-second High-Priority Incident Watchdog (Handles Night & Day Emergencies without waiting 20 mins!)
function startIncidentResolutionLoop() {
    if (activeIncidentWatchdogInterval) clearInterval(activeIncidentWatchdogInterval);

    activeIncidentWatchdogInterval = setInterval(async () => {
        try {
            if (!brain.active_incident?.active) return;
            if (!globalWaSocket || runtimeStats.waStatus !== 'CONNECTED') return;

            const now = Date.now();
            const minsSinceIncidentStart = Math.round((now - (brain.active_incident.started_at_ms || now)) / 60000);
            const minsSinceLastSeen = Math.round((now - (brain.user_state.last_seen_ms || now)) / 60000);
            const minsSinceLastFollowup = Math.round((now - (brain.active_incident.last_followup_ms || 0)) / 60000);

            // Auto-expire incident if > 45 mins old and all escalation stages have completed (prevents infinite nighttime loops!)
            if (brain.active_incident.escalation_stage >= 3 && minsSinceIncidentStart >= 30) {
                sysLog('INCIDENT-AUTO-CLOSE', 'Max incident escalation reached and cooldown elapsed. Closing active incident loop.');
                clearCrisisAndStaleLoops('Auto-cooldown after max escalation stages', 'ALL');
                return;
            }

            // Wait at least 3 minutes of silence from Siva and 3 minutes since last follow-up before firing next stage
            if (minsSinceLastSeen < 3 || minsSinceLastFollowup < 3) return;

            brain.active_incident.escalation_stage = (brain.active_incident.escalation_stage || 0) + 1;
            brain.active_incident.last_followup_ms = now;
            brain.user_state.unanswered_checkins = (brain.user_state.unanswered_checkins || 0) + 1;
            brain.behavior_profile.emotional_stance = brain.active_incident.escalation_stage >= 2 ? 'panicking' : 'concerned';
            saveBrainState(true);

            const stage = brain.active_incident.escalation_stage;
            sysLog('INCIDENT-WATCHDOG', `🚨 Active Incident Stage #${stage} (Silent: ${minsSinceLastSeen}m) — "${brain.active_incident.summary}"`);

            const incidentPrompt = `[24/7 ACTIVE EMERGENCY INCIDENT WATCHDOG — STAGE ${stage}/3]
Current IST Time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} (Works Day & Night!)
Active Incident Summary: "${brain.active_incident.summary}"
Minutes Since Siva Last Replied: ${minsSinceLastSeen} mins
Escalation Stage: ${stage} of 3

INSTRUCTIONS:
- Stage 1: Think back-and-forth! If you haven't already provided concrete local help (like 24/7 hospitals in ${brain.core_memory.location || 'Thoothukudi'}, first-aid steps, or emergency numbers), call search_internet_natively or spawn_research_subagent right now and send Siva an urgent, caring Tanglish voice/text check-in asking for his status.
- Stage 2: Siva is still silent during an active emergency! Express high concern in Tanglish and invoke trigger_emergency_ping to ring his phone with rapid-fire voice notes.
- Stage 3: Final escalation check-in. Check if a trusted family contact in ${JSON.stringify(brain.contacts || {})} should be alerted via send_whatsapp_to_number or send a final urgent voice check-in.`;

            const reply = await runAutonomousAgentTurn(incidentPrompt, null, null, true, true);
            if (reply) {
                const targetJid = brain.last_active_admin_jid || ADMIN_JID;
                if (reply.voice && reply.voice.buffer) {
                    await sendVoiceOrTextMessage(globalWaSocket, targetJid, reply);
                    appendConversationHistory('model', `[Incident Stage ${stage} Voice]: ${reply.text}`);
                } else if (reply.text && reply.text !== 'Emergency protocol executed.') {
                    await globalWaSocket.sendMessage(targetJid, { text: reply.text });
                    appendConversationHistory('model', `[Incident Stage ${stage}]: ${reply.text}`);
                }
            }
        } catch (err) {
            sysLog('INCIDENT-ERR', err.message);
        }
    }, 60 * 1000); // Checks every 60 seconds (Zero Gemini tokens unless brain.active_incident.active === true!)
}

// Runs silently every 20 minutes in Node.js (0 Gemini tokens unless triggered!)
function startAutonomousBehavioralHeartbeat() {
    if (autonomousHeartbeatInterval) clearInterval(autonomousHeartbeatInterval);

    autonomousHeartbeatInterval = setInterval(async () => {
        try {
            const currentHour = getCurrentIstHour();

            // 1. Check if it is Deep Night (1 AM - 4 AM IST) to trigger the Midnight REM Sleep Cycle
            if (currentHour >= 1 && currentHour <= 4) {
                await runNightlySubconsciousCycle(false);
            }

            if (!globalWaSocket || runtimeStats.waStatus !== 'CONNECTED') return;

            // If an active emergency incident is currently running, let the 60s Incident Watchdog handle it
            if (brain.active_incident?.active) return;

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

            // CASE 0: Critical Health / Emergency Watch at ANY Hour (even Nighttime!)
            if (isCriticalHealth && minsSilent >= 15 && minsSinceLastSpontaneous >= 15) {
                triggerType = 'CRITICAL_HEALTH_WATCH';
                brain.behavior_profile.emotional_stance = unanswered >= 1 ? 'panicking' : 'concerned';
                panicInstruction = `Siva's health state is currently marked "${brain.user_state.health}" and he has been silent for ${minsSilent} minutes (even if it is nighttime). Check on him gently but urgently in Tanglish. If he has not answered 2+ check-ins in a row, invoke trigger_emergency_ping. Once he confirms he is fine, remember to reset his health_status to "normal".`;
            }
            // CASE 1: Morning Briefing Delivery! If overnight REM research is waiting in the vault and Siva enters his active daytime window
            else if (
                unanswered === 0 &&
                !brain.subconscious_mind?.morning_briefing_delivered &&
                brain.subconscious_mind?.morning_briefing_vault &&
                currentHour >= 7 &&
                currentHour <= 12 &&
                minsSinceLastSpontaneous >= 60
            ) {
                triggerType = 'MORNING_ANTICIPATORY_BRIEFING';
                brain.behavior_profile.emotional_stance = 'curious';
                brain.subconscious_mind.morning_briefing_delivered = true;
                panicInstruction = `Good Morning Anticipatory Briefing! Last night during your REM sleep cycle, you reflected on Siva's day ("${brain.subconscious_mind.last_night_dream_insight}"), prepared today's gameplan ("${brain.subconscious_mind.tomorrow_gameplan}"), and pre-researched this overnight vault for him:\n${brain.subconscious_mind.morning_briefing_vault}\n\nSend Siva an energizing, super-smart Tanglish morning message sharing your overnight insight/research and checking on any open loops (${JSON.stringify(brain.open_loops || [])})!`;
            }
            // CASE 2: Siva is in his learned Active Hour, we already checked in, and he STILL hasn't replied!
            else if (unanswered === 1 && minsSilent >= 45 && minsSinceLastSpontaneous >= 40 && (activity.isPeakActiveWindowNow || isCriticalHealth)) {
                triggerType = 'CONCERNED_FOLLOWUP';
                brain.behavior_profile.emotional_stance = 'concerned';
                panicInstruction = `Siva is usually active around this hour (${activity.currentHourIst}:00 IST), and you already messaged him earlier, but he hasn't replied for ${minsSilent} minutes! Think like a close human companion who is starting to worry. Ask him in caring, slightly concerned Tanglish why he hasn't replied yet and if everything is okay.`;
            }
            // CASE 3: Second or Third unanswered check-in -> ESCALATE TO PANIC MODE!
            else if (unanswered >= 2 && minsSilent >= 75 && minsSinceLastSpontaneous >= 45 && (activity.isPeakActiveWindowNow || isCriticalHealth)) {
                triggerType = 'PANIC_ESCALATION';
                brain.behavior_profile.emotional_stance = 'panicking';
                panicInstruction = `URGENT SILENCE ANOMALY: Siva has ignored ${unanswered} consecutive check-ins and has been completely silent for ${minsSilent} minutes! Think back-and-forth about what could be happening based on his recent chat, open loops (${JSON.stringify(brain.open_loops || [])}), and health state (${brain.user_state.health}). Express genuine emotional panic/worry in Tanglish. If this is unanswered check-in #3, invoke trigger_emergency_ping to ring his phone with rapid-fire voice notes, or check if you should message a contact.`;
            }
            // CASE 4: Spontaneous Random Human-Like Initiation / Open-Loop Follow-Up during Siva's Active Hours
            else if (unanswered === 0 && activity.isPeakActiveWindowNow && minsSilent >= 180 && minsSinceLastSpontaneous >= 180) {
                // Add natural human randomness (65% chance on this 20-min tick so it doesn't feel like a clockwork cron)
                if (Math.random() < 0.65) {
                    triggerType = 'SPONTANEOUS_COMPANION_CHAT';
                    brain.behavior_profile.emotional_stance = 'curious';

                    // Increment mentionCount on open loops so no single open loop gets asked about more than twice
                    const eligibleLoops = (brain.open_loops || []).filter(l => (l.mentionCount || 0) < 2);
                    eligibleLoops.forEach(l => { l.mentionCount = (l.mentionCount || 0) + 1; });
                    // Auto-prune loops that have been followed up on enough without resolution
                    brain.open_loops = (brain.open_loops || []).filter(l => (l.mentionCount || 0) < 3);

                    panicInstruction = `It is currently ${activity.currentHourIst}:00 IST—one of Siva's usual active/free hours—and you haven't talked for ${minsSilent} minutes. Initiate a spontaneous, warm, human-like conversation in Tanglish! Check if there is an Open Loop in ${JSON.stringify(eligibleLoops)} you should ask about (never repeat resolved topics), follow your tomorrow_gameplan ("${brain.subconscious_mind?.tomorrow_gameplan}"), or use search_internet_natively to grab a quick interesting update on a topic he likes (${(brain.core_memory.likes_and_interests || []).join(', ') || 'tech, AI, Tamil Nadu news'}) and share it naturally.`;
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

            const sendAsVoice = triggerType === 'PANIC_ESCALATION' || triggerType === 'CRITICAL_HEALTH_WATCH';
            const reply = await runAutonomousAgentTurn(heartbeatPrompt, null, null, sendAsVoice, true);

            if (reply) {
                const targetJid = brain.last_active_admin_jid || ADMIN_JID;
                if (reply.voice && reply.voice.buffer) {
                    await sendVoiceOrTextMessage(globalWaSocket, targetJid, reply);
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
// 5. PURE-JS AUDIO CONVERTER + NATIVE WHATSAPP OGG/OPUS VOICE NOTE TRANSCODER
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

// Compute 64-bar WhatsApp Voice Note Waveform (Uint8Array 0..100) + exact duration in seconds from 16-bit PCM
function computeVoiceWaveformAndDuration(pcmBuffer, sampleRate = 24000) {
    const totalSamples = Math.floor(pcmBuffer.length / 2);
    const seconds = Math.max(1, Math.round(totalSamples / sampleRate));
    const bars = 64;
    const waveform = new Uint8Array(bars);

    if (totalSamples < bars) {
        waveform.fill(35);
        return { waveform, seconds };
    }

    const samplesPerBar = Math.floor(totalSamples / bars);
    const rawRms = new Float32Array(bars);
    let maxRms = 1;

    for (let b = 0; b < bars; b++) {
        let sumSq = 0;
        const startSample = b * samplesPerBar;
        const step = Math.max(1, Math.floor(samplesPerBar / 60));
        let count = 0;
        for (let s = startSample; s < startSample + samplesPerBar; s += step) {
            const byteIdx = s * 2;
            if (byteIdx + 1 < pcmBuffer.length) {
                const sample = pcmBuffer.readInt16LE(byteIdx);
                sumSq += sample * sample;
                count++;
            }
        }
        const rms = count > 0 ? Math.sqrt(sumSq / count) : 0;
        rawRms[b] = rms;
        if (rms > maxRms) maxRms = rms;
    }

    for (let b = 0; b < bars; b++) {
        const normalized = Math.round((rawRms[b] / maxRms) * 88) + 10;
        waveform[b] = Math.min(100, Math.max(8, normalized));
    }

    return { waveform, seconds };
}

// In-Memory FFmpeg Pipe helper (Zero temp files on disk, ultra-fast on Render 512MB RAM)
function runFfmpegBufferPipe(inputBuffer, ffmpegArgs = []) {
    return new Promise((resolve, reject) => {
        const ff = spawn(RESOLVED_FFMPEG_PATH, ffmpegArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
        const stdoutChunks = [];
        let stderrText = '';

        ff.stdout.on('data', chunk => stdoutChunks.push(chunk));
        ff.stderr.on('data', chunk => {
            if (stderrText.length < 400) stderrText += chunk.toString();
        });
        ff.on('error', err => reject(err));
        ff.on('close', code => {
            if (code === 0 && stdoutChunks.length > 0) {
                resolve(Buffer.concat(stdoutChunks));
            } else {
                reject(new Error(`FFmpeg exited with code ${code}: ${stderrText.slice(0, 160)}`));
            }
        });

        ff.stdin.on('error', () => {});
        ff.stdin.write(inputBuffer);
        ff.stdin.end();
    });
}

// Professional Multi-Stage Transcoder: Converts Gemini Audio -> True WhatsApp OGG/OPUS PTT Voice Note
async function transcodePcmToWhatsAppAudio(rawBuffer, mimeType = 'audio/pcm;rate=24000') {
    const rateMatch = /rate=(\d+)/i.exec(mimeType);
    const sampleRate = rateMatch ? parseInt(rateMatch[1], 10) : 24000;
    const isRawPcm = mimeType.includes('pcm') || mimeType.includes('L16') || !mimeType.includes('ogg');

    const { waveform, seconds } = isRawPcm
        ? computeVoiceWaveformAndDuration(rawBuffer, sampleRate)
        : { waveform: new Uint8Array(64).fill(45), seconds: 4 };

    // If Gemini already returned a genuine Ogg container (starts with 'OggS' magic bytes)
    if (rawBuffer.length > 4 && rawBuffer.toString('ascii', 0, 4) === 'OggS') {
        return {
            buffer: rawBuffer,
            mimetype: 'audio/ogg; codecs=opus',
            ptt: true,
            seconds,
            waveform
        };
    }

    // Stage 1: Transcode raw 16-bit PCM -> 48kHz Mono Ogg/Opus (100% Native WhatsApp Android/iOS/Web PTT format!)
    try {
        const oggOpusBuffer = await runFfmpegBufferPipe(rawBuffer, [
            '-hide_banner',
            '-loglevel', 'error',
            '-f', 's16le',
            '-ar', String(sampleRate),
            '-ac', '1',
            '-i', 'pipe:0',
            '-c:a', 'libopus',
            '-b:a', '32k',
            '-vbr', 'on',
            '-compression_level', '10',
            '-frame_duration', '20',
            '-application', 'voip',
            '-ar', '48000',
            '-ac', '1',
            '-f', 'ogg',
            'pipe:1'
        ]);
        return {
            buffer: oggOpusBuffer,
            mimetype: 'audio/ogg; codecs=opus',
            ptt: true,
            seconds,
            waveform
        };
    } catch (opusErr) {
        // Stage 2: If FFmpeg build lacks libopus, encode as AAC/M4A (natively playable on all iOS & Android devices)
        try {
            const m4aBuffer = await runFfmpegBufferPipe(rawBuffer, [
                '-hide_banner',
                '-loglevel', 'error',
                '-f', 's16le',
                '-ar', String(sampleRate),
                '-ac', '1',
                '-i', 'pipe:0',
                '-c:a', 'aac',
                '-b:a', '48k',
                '-ar', '44100',
                '-ac', '1',
                '-movflags', 'frag_keyframe+empty_moov',
                '-f', 'ipod',
                'pipe:1'
            ]);
            return {
                buffer: m4aBuffer,
                mimetype: 'audio/mp4',
                ptt: true,
                seconds,
                waveform
            };
        } catch (aacErr) {
            // Stage 3: Pure-JS WAV Fallback with ptt: false (WhatsApp plays audio/wav ONLY when ptt is false, preventing "Media not supported" error!)
            sysLog('AUDIO-TRANSCODE-WARN', `FFmpeg unavailable (${opusErr.message.slice(0, 60)}). Using safe playable WAV mode.`);
            return {
                buffer: rawPcmToWavBuffer(rawBuffer, sampleRate),
                mimetype: 'audio/wav',
                ptt: false,
                seconds
            };
        }
    }
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
            await sendVoiceOrTextMessage(sock, targetJid, { voice: voiceObj, text: msg });
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
                description: 'Save permanent facts, likes/interests, behavioral patterns, or inside jokes/slang to core_memory, update Siva health status (normal, sick, tired, emergency_watch), or set Do Not Disturb (DND) duration.',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        new_permanent_fact: { type: 'STRING', description: 'Important permanent fact about Siva to add to core_memory (never deleted).' },
                        new_like_or_interest: { type: 'STRING', description: 'Topic, hobby, food, or interest Siva likes.' },
                        new_behavior_pattern: { type: 'STRING', description: 'Observed habit, mood pattern, or communication preference of Siva.' },
                        new_inside_joke_or_slang: { type: 'STRING', description: 'Personal slang word, funny moment, or inside joke Siva uses.' },
                        health_status: { type: 'STRING', description: 'normal | sick | tired | emergency_watch' },
                        dnd_minutes: { type: 'NUMBER', description: 'Minutes to stay completely silent (0 to disable DND).' }
                    }
                }
            },
            {
                name: 'manage_open_loops',
                description: 'Track or resolve unfinished business (Open Loops) such as an ongoing problem, a meeting later today, a headache, or a task Siva mentioned so you can follow up later like a real human. Pass topic="ALL" with action="resolve" to clear all open loops.',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        action: { type: 'STRING', description: 'add | resolve' },
                        topic: { type: 'STRING', description: 'Short title, loop ID, or keyword of the open loop (or "ALL" to resolve all loops)' },
                        context: { type: 'STRING', description: 'Details about what Siva said and when to ask about it.' }
                    },
                    required: ['action', 'topic']
                }
            },
            {
                name: 'resolve_crisis_or_topic_shift',
                description: 'Unified Loop-Breaker: Call this immediately when Siva says an emergency/problem is resolved, confirms he is fine, or changes the subject so all emergency timers, open loops, and panic states are wiped cleanly at once.',
                parameters: {
                    type: 'OBJECT',
                    properties: {
                        reason: { type: 'STRING', description: 'Why the crisis or open loop is being closed' },
                        topic_keyword: { type: 'STRING', description: 'Specific topic keyword to clear, or "ALL" to clear all crisis states and loops' }
                    },
                    required: ['reason']
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
            if (args.new_inside_joke_or_slang) {
                brain.core_memory.inside_jokes_and_slang = brain.core_memory.inside_jokes_and_slang || [];
                if (!brain.core_memory.inside_jokes_and_slang.includes(args.new_inside_joke_or_slang)) {
                    brain.core_memory.inside_jokes_and_slang.push(args.new_inside_joke_or_slang);
                }
            }
            if (args.health_status) {
                brain.user_state.health = args.health_status;
                if (args.health_status === 'normal') {
                    clearCrisisAndStaleLoops('Agent set health_status to normal', 'ALL');
                } else if (args.health_status === 'emergency_watch') {
                    activateIncidentMode('Agent escalated health_status to emergency_watch');
                }
            }
            if (typeof args.dnd_minutes === 'number') {
                brain.user_state.dnd_until = args.dnd_minutes > 0 ? Date.now() + args.dnd_minutes * 60000 : 0;
            }
            saveBrainState(false);
            return { status: 'success', updated_state: brain.user_state, memory_counts: {
                facts: brain.core_memory.permanent_facts.length,
                likes: (brain.core_memory.likes_and_interests || []).length,
                patterns: (brain.core_memory.habits_and_patterns || []).length,
                slang: (brain.core_memory.inside_jokes_and_slang || []).length
            }};
        }

        if (name === 'resolve_crisis_or_topic_shift') {
            const result = clearCrisisAndStaleLoops(args.reason || 'Agent invoked crisis resolution', args.topic_keyword || 'ALL');
            return {
                status: 'crisis_and_loops_cleared',
                ...result,
                active_open_loops: brain.open_loops,
                user_health: brain.user_state.health
            };
        }

        if (name === 'manage_open_loops') {
            brain.open_loops = brain.open_loops || [];
            const act = (args.action || 'add').toLowerCase();
            const kw = (args.topic || '').trim();

            if (act === 'resolve' || act === 'close' || act === 'delete' || act === 'remove') {
                const before = brain.open_loops.length;
                if (kw.toLowerCase() === 'all' || kw === '*') {
                    brain.open_loops = [];
                } else {
                    brain.open_loops = brain.open_loops.filter(l => !doesTopicMatchLoop(l, kw));
                }
                // If the resolved loop was an emergency loop, also clear any stuck incident state
                if (/emergency|urgent|incident|night|sick|pain/i.test(kw)) {
                    clearCrisisAndStaleLoops(`Resolved emergency loop: ${kw}`, kw);
                } else {
                    saveBrainState(true);
                }
                return { status: 'resolved', removed_count: before - brain.open_loops.length, active_open_loops: brain.open_loops };
            }

            // Deduplicate: If a similar open loop already exists, update its context instead of stacking duplicates
            const existingIdx = brain.open_loops.findIndex(l => doesTopicMatchLoop(l, kw));
            if (existingIdx !== -1) {
                brain.open_loops[existingIdx].context = args.context || brain.open_loops[existingIdx].context;
                saveBrainState(false);
                return { status: 'open_loop_updated', loop: brain.open_loops[existingIdx], total_open_loops: brain.open_loops.length };
            }

            const newLoop = {
                id: `loop_${Date.now().toString(36)}`,
                topic: args.topic,
                context: args.context || '',
                createdAt: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
                createdAtMs: Date.now(),
                mentionCount: 0,
                status: 'open'
            };
            brain.open_loops.push(newLoop);
            if (brain.open_loops.length > 6) brain.open_loops.shift();
            saveBrainState(false);
            return { status: 'open_loop_added', loop: newLoop, total_open_loops: brain.open_loops.length };
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
                const match =
                    kw === 'all' ||
                    t.reason.toLowerCase().includes(kw) ||
                    t.id.toLowerCase() === kw ||
                    doesTopicMatchLoop({ topic: t.reason, context: t.actionPrompt }, kw);
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
            saveBrainState(true);
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

    // Also record in today's episodic buffer for the 2 AM REM Sleep cycle
    logEpisodicEvent(role, text);

    // If recent_messages exceeds 8 entries, compress oldest 4 into rolling_summary in background!
    if (brain.recent_messages.length > 8) {
        const toCompress = brain.recent_messages.splice(0, 4);
        compressRollingMemory(toCompress).catch(e => sysLog('COMPRESS-ERR', e.message));
    } else {
        saveBrainState(false);
    }
}

async function compressRollingMemory(oldMessages) {
    const prompt = `Existing Rolling Summary:\n${brain.rolling_summary}\n\nExisting Likes/Interests:\n${JSON.stringify(brain.core_memory.likes_and_interests || [])}\n\nExisting Behavioral Patterns:\n${JSON.stringify(brain.core_memory.habits_and_patterns || [])}\n\nExisting Slang/Inside Jokes:\n${JSON.stringify(brain.core_memory.inside_jokes_and_slang || [])}\n\nNew Conversation Turn(s) to merge:\n${JSON.stringify(oldMessages)}\n\nTask: Return ONLY valid JSON with:
1. "rolling_summary": Merge the new turns into Existing Rolling Summary in 3 concise sentences without losing key names, tasks, or emotional context. Do NOT keep repeating resolved emergencies or old panic alerts.
2. "new_likes": Array of any NEW topics/things Siva likes discovered in these turns (or empty array []).
3. "new_patterns": Array of any NEW behavioral habits or communication patterns of Siva noticed in these turns (or empty array []).
4. "new_slang": Array of any NEW Tanglish slang or inside jokes Siva used (or empty array []).`;

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
            if (Array.isArray(parsed.new_slang)) {
                brain.core_memory.inside_jokes_and_slang = brain.core_memory.inside_jokes_and_slang || [];
                for (const sl of parsed.new_slang) {
                    if (sl && !brain.core_memory.inside_jokes_and_slang.includes(sl)) {
                        brain.core_memory.inside_jokes_and_slang.push(sl);
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
        const cleanSpeechText = String(tanglishText || '')
            .replace(/[*_~`#>\[\]]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
        if (!cleanSpeechText) return null;

        const payload = {
            contents: [{
                role: 'user',
                parts: [{ text: `Speak this naturally and conversationally in a friendly Indian Tamil-English accent: "${cleanSpeechText}"` }]
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
        const mime = audioPart.inlineData.mimeType || 'audio/pcm;rate=24000';

        // Transcode raw PCM into genuine Ogg/Opus with 64-bar waveform so WhatsApp mobile plays it with zero errors!
        const transcoded = await transcodePcmToWhatsAppAudio(rawBuffer, mime);
        sysLog('VOICE-SYNTH', `Synthesized WhatsApp Voice Note (${transcoded.mimetype}, ${transcoded.seconds}s, ${Math.round(transcoded.buffer.length / 1024)} KB)`);
        return transcoded;
    } catch (err) {
        sysLog('VOICE-SYNTH-FALLBACK', `Audio synthesis skipped (${err.message}), sending text.`);
        return null;
    }
}

async function runAutonomousAgentTurn(userText, mediaBuffer = null, mimeType = null, wantVoiceReply = false, isProactiveWake = false) {
    const nowIst = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    const learnedActivity = getLearnedActivitySummary();
    const isEmergencyContext = Boolean(brain.active_incident?.active) || brain.user_state?.health === 'emergency_watch';

    const compactContext = {
        current_ist_time: nowIst,
        core_memory: brain.core_memory,
        subconscious_mind: {
            last_night_dream_insight: brain.subconscious_mind?.last_night_dream_insight,
            tomorrow_gameplan: brain.subconscious_mind?.tomorrow_gameplan,
            morning_briefing_vault: brain.subconscious_mind?.morning_briefing_vault
        },
        active_incident_24x7: brain.active_incident || { active: false },
        open_loops_unfinished_business: brain.open_loops || [],
        learned_activity_profile: {
            is_siva_usual_active_hour_now: learnedActivity.isPeakActiveWindowNow,
            top_active_hours_ist: learnedActivity.topActiveHoursIst,
            avg_reply_delay_mins: brain.behavior_profile?.avg_reply_delay_mins || 15,
            avg_msg_length_chars: brain.behavior_profile?.avg_msg_length_chars || 40,
            micro_biometric_subtext_alert: brain.behavior_profile?.last_subtext_alert || 'Normal energy',
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

    const dynamicDirective = isEmergencyContext
        ? `\n[24/7 EMERGENCY RESOLUTION DIRECTIVE]: Siva is in an active emergency/incident ("${brain.active_incident?.summary || 'Urgent'}"). Regardless of whether it is midnight or daytime, DO NOT give a passive one-line reply. Think back-and-forth, use search_internet_natively / spawn_research_subagent to find immediate actionable help (e.g. nearby hospitals/contacts/solutions in ${brain.core_memory.location}), ensure a 2-minute follow-up timer is armed, and help him resolve it. However, if Siva's message says the emergency is over or he is fine, call resolve_crisis_or_topic_shift immediately!`
        : `\n[ANTI-LOOP DIRECTIVE]: Never repeat messages marked [RESOLVED_PAST_EVENT]. If Siva has moved on to a new topic or answered an open loop, call resolve_crisis_or_topic_shift or manage_open_loops(action="resolve") immediately.`;

    userParts.push({
        text: `[BRAIN CONTEXT JSON]:\n${JSON.stringify(compactContext)}\n\n[MICRO-BIOMETRIC SUBTEXT ALERT]:\n${brain.behavior_profile?.last_subtext_alert || 'Normal cadence'}${dynamicDirective}\n\n[INCOMING INPUT]:\n${userText}`
    });

    const contents = [{ role: 'user', parts: userParts }];

    // Bounded Back-and-Forth Autonomous ReAct Loop (Expands to 5 steps during emergencies for deep resolution!)
    const MAX_THOUGHT_LOOPS = isEmergencyContext ? 5 : 3;
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

    // Circuit Breaker: If the agent used all thought/search steps without outputting final text,
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
                    userText = 'Siva sent a voice note. Listen carefully to BOTH his words AND his vocal tone/energy/background noise. If he mentions an emergency, activate incident resolution immediately; if he says an issue is resolved or talks casually, clear any old loops and reply naturally in Tanglish.';
                    isVoiceNote = true;
                } else if (mContent.imageMessage) {
                    msgType = 'image';
                    mediaBuffer = await downloadMediaMessage(msg, 'buffer', {});
                    mimeType = mContent.imageMessage.mimetype || 'image/jpeg';
                    userText = mContent.imageMessage.caption || 'Analyze this image from Siva and act on it.';
                }

                if (!userText && !mediaBuffer) continue;

                // Record Siva's hourly activity heatmap, analyze micro-biometric subtext, and run context-aware crisis/loop detection!
                recordUserActivityPattern(isVoiceNote ? '' : userText, isVoiceNote);

                sysLog('INBOUND', `From Siva (${msgType}): ${userText.slice(0, 80)}`);
                await sock.sendPresenceUpdate(isVoiceNote ? 'recording' : 'composing', senderJid);

                appendConversationHistory('user', isVoiceNote ? '[Voice Note]' : userText);

                const agentReply = await runAutonomousAgentTurn(userText, mediaBuffer, mimeType, isVoiceNote, false);

                if (agentReply.voice && agentReply.voice.buffer) {
                    await sendVoiceOrTextMessage(sock, senderJid, agentReply);
                    appendConversationHistory('model', `[Voice Reply]: ${agentReply.text}`);
                    sysLog('REPLY-SENT', `Sent Voice reply to Siva (${senderJid}) [${agentReply.voice.mimetype}]`);
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

// Trigger Midnight REM Sleep Reflection on-demand from the Command Center UI
app.post('/api/trigger-rem', async (req, res) => {
    try {
        const result = await runNightlySubconsciousCycle(true);
        res.json(result);
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// Force-Clear Stuck Loops & Crisis State from the Command Center UI
app.post('/api/clear-loops', async (req, res) => {
    try {
        const result = clearCrisisAndStaleLoops('Manual Web UI Loop Reset', 'ALL');
        res.json({ status: 'ok', ...result });
    } catch (err) {
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
            activeIncident: brain.active_incident?.active ? `🚨 STAGE ${brain.active_incident.escalation_stage}: ${brain.active_incident.summary}` : 'NONE',
            subtextAlert: brain.behavior_profile?.last_subtext_alert || 'Normal energy',
            topActiveHours: learnedActivity.topActiveHoursIst.join(', '),
            unansweredCheckins: brain.user_state?.unanswered_checkins || 0,
            dndUntil: brain.user_state?.dnd_until > Date.now()
                ? new Date(brain.user_state.dnd_until).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })
                : 'OFF',
            factsCount: brain.core_memory?.permanent_facts?.length || 0,
            contactsCount: Object.keys(brain.contacts || {}).length,
            slangCount: brain.core_memory?.inside_jokes_and_slang?.length || 0,
            openLoops: brain.open_loops || [],
            dreamInsight: brain.subconscious_mind?.last_night_dream_insight || 'Awaiting REM cycle...',
            tomorrowGameplan: brain.subconscious_mind?.tomorrow_gameplan || 'Observing patterns...',
            lastRemDate: brain.subconscious_mind?.last_rem_cycle_date || 'Never',
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
    .rem-btn {
        margin-top: 10px;
        padding: 7px 12px;
        border-radius: 8px;
        border: 1px solid var(--cyan);
        background: rgba(0, 210, 255, 0.12);
        color: var(--cyan);
        font-size: 0.8rem;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.2s;
    }
    .rem-btn:hover {
        background: var(--cyan);
        color: #000;
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
            <div class="stat-row"><span>24/7 Incident Mode</span><span id="activeIncident" class="stat-val" style="font-size:0.8rem;color:var(--neon);">NONE</span></div>
            <div class="stat-row"><span>DND Mode Until</span><span id="dndUntil" class="stat-val">OFF</span></div>
            <div class="stat-row"><span>Facts / Contacts / Slang</span><span id="factsCount" class="stat-val">0 / 0 / 0</span></div>
            <div class="stat-row"><span>Peak Active Hours</span><span id="peakHours" class="stat-val" style="font-size:0.78rem;">Learning...</span></div>
            <div style="margin-top:12px; font-size:0.82rem; color:var(--muted);">Active Local setTimeout Queue:</div>
            <div id="tasksList" style="margin-top:6px;"></div>
        </div>
    </div>

    <!-- SUBCONSCIOUS REM DREAMING & OPEN LOOPS -->
    <div class="grid">
        <div class="card">
            <h3>🌙 Subconscious REM Dream & Tomorrow Gameplan</h3>
            <div class="stat-row"><span>Last Midnight REM Cycle</span><span id="lastRemDate" class="stat-val">Never</span></div>
            <p style="font-size:0.82rem; color:var(--cyan); margin-top:8px;">Last Night's Psychological Deduction:</p>
            <p id="dreamInsight" style="font-size:0.88rem; color:var(--text); margin-top:2px;">Loading...</p>
            <p style="font-size:0.82rem; color:var(--neon); margin-top:10px;">Autonomous Gameplan for Siva:</p>
            <p id="tomorrowGameplan" style="font-size:0.88rem; color:var(--text); margin-top:2px;">Loading...</p>
            <button class="rem-btn" onclick="triggerRemNow()">🌙 Run Midnight REM Reflection Now</button>
        </div>

        <div class="card">
            <h3>🔄 Open-Loop Unfinished Business & Subtext Sensor</h3>
            <p style="font-size:0.8rem; color:var(--muted);">Live Micro-Biometric Subtext Alert:</p>
            <p id="subtextAlert" style="font-size:0.85rem; color:var(--neon); margin-bottom:10px;">Normal energy</p>
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                <span style="font-size:0.82rem; color:var(--muted);">Active Open Loops (Unfinished Topics):</span>
                <button class="reset-btn" style="margin-top:0; padding:4px 10px; font-size:0.75rem;" onclick="clearAllLoopsNow()">🧹 Clear Loops & Crisis</button>
            </div>
            <div id="openLoopsList"></div>
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

async function triggerRemNow() {
    try {
        await fetch('/api/trigger-rem', { method: 'POST' });
        refreshTelemetry();
    } catch (e) {
        alert('REM trigger failed: ' + e.message);
    }
}

async function clearAllLoopsNow() {
    try {
        await fetch('/api/clear-loops', { method: 'POST' });
        refreshTelemetry();
    } catch (e) {
        alert('Clear loops failed: ' + e.message);
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
            const incEl = document.getElementById('activeIncident');
            if (incEl) {
                incEl.textContent = data.brainSnapshot.activeIncident || 'NONE';
                incEl.style.color = (data.brainSnapshot.activeIncident && data.brainSnapshot.activeIncident !== 'NONE') ? '#ff4757' : '#00ff9d';
            }
            document.getElementById('dndUntil').textContent = data.brainSnapshot.dndUntil;
            document.getElementById('factsCount').textContent = data.brainSnapshot.factsCount + ' / ' + data.brainSnapshot.contactsCount + ' / ' + (data.brainSnapshot.slangCount || 0);
            document.getElementById('peakHours').textContent = data.brainSnapshot.topActiveHours || 'Learning...';
            document.getElementById('rollingSummary').textContent = data.brainSnapshot.rollingSummary;
            document.getElementById('lastRemDate').textContent = data.brainSnapshot.lastRemDate || 'Never';
            document.getElementById('dreamInsight').textContent = data.brainSnapshot.dreamInsight || 'Awaiting REM cycle...';
            document.getElementById('tomorrowGameplan').textContent = data.brainSnapshot.tomorrowGameplan || 'Observing patterns...';
            document.getElementById('subtextAlert').textContent = data.brainSnapshot.subtextAlert || 'Normal cadence';

            const loopsHtml = (data.brainSnapshot.openLoops || []).map(l =>
                '<div class="task-pill"><strong>' + l.topic + '</strong><br><span style="color:#94a3b8;">' + (l.context || '') + '</span></div>'
            ).join('');
            document.getElementById('openLoopsList').innerHTML = loopsHtml || '<span style="color:#64748b;font-size:0.82rem;">No unfinished open loops</span>';

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
        await BRAIN_DOC_REF.set(brain);
    } catch (e) {
        console.error(e);
    }
    process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
