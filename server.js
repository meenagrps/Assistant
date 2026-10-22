import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { VoipClient } from 'baileys-caller';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import QRCode from 'qrcode';
import fs from 'fs';
import ffmpegStatic from 'ffmpeg-static';

// ==========================================
// 1. SYSTEM CONFIGURATION & ANTI-CRASH
// ==========================================
process.env.FFMPEG_PATH = ffmpegStatic; // Map FFmpeg internally
process.on('uncaughtException', (err) => console.error('🔥 Critical Exception:', err));
process.on('unhandledRejection', (err) => console.error('🔥 Unhandled Rejection:', err));

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);
const AUTH_DIR = './auth';

// State Machine for the Frontend UI
let botState = { phase: 'INIT', qrUrl: null, message: 'Initializing...' };
let handoverTimer = null;

// Update UI across all connected browsers
function broadcastState(phase, message, qrUrl = null) {
    botState = { phase, message, qrUrl };
    io.emit('state_update', botState);
    if (message) console.log(`[STATE] ${message}`);
}

// ==========================================
// 2. FRONTEND WEB INTERFACE (Responsive & Clean)
// ==========================================
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>WhatsApp VoIP Bot</title>
            <style>
                body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; text-align: center; background: #f0f2f5; padding: 2rem 1rem; margin: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; }
                .card { background: white; padding: 2rem; border-radius: 12px; box-shadow: 0 8px 24px rgba(0,0,0,0.05); width: 100%; max-width: 400px; box-sizing: border-box; }
                h2 { margin-top: 0; color: #1c1e21; font-size: 1.25rem; }
                #status { margin-bottom: 1.5rem; color: #606770; font-weight: 500; min-height: 24px; }
                #qrcode { display: none; margin: 0 auto; width: 100%; max-width: 250px; border: 10px solid white; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
                .spinner { display: inline-block; width: 40px; height: 40px; border: 4px solid #f3f3f3; border-top: 4px solid #25D366; border-radius: 50%; animation: spin 1s linear infinite; margin: 20px auto; }
                @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
            </style>
        </head>
        <body>
            <div class="card">
                <h2>WhatsApp Link</h2>
                <div id="status">Connecting to backend...</div>
                <div id="loader" class="spinner"></div>
                <img id="qrcode" src="" alt="QR Code"/>
            </div>
            
            <script src="/socket.io/socket.io.js"></script>
            <script>
                const socket = io();
                const statusEl = document.getElementById('status');
                const qrEl = document.getElementById('qrcode');
                const loaderEl = document.getElementById('loader');
                
                socket.on('state_update', (data) => {
                    statusEl.innerText = data.message;
                    
                    if (data.phase === 'QR_READY' && data.qrUrl) {
                        qrEl.src = data.qrUrl;
                        qrEl.style.display = 'block';
                        loaderEl.style.display = 'none';
                    } else {
                        qrEl.style.display = 'none';
                        loaderEl.style.display = data.phase === 'ENDED' ? 'none' : 'block';
                    }
                });
            </script>
        </body>
        </html>
    `);
});

// Serve current state instantly to new web visitors
io.on('connection', (socket) => socket.emit('state_update', botState));

// ==========================================
// 3. WHATSAPP AUTHENTICATION LOGIC (Standard Baileys)
// ==========================================
async function initializeAuth() {
    broadcastState('AUTH_INIT', 'Starting authentication engine...');
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();
    
    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        markOnlineOnConnect: false,
        syncFullHistory: false, // Prevents pkmsg memory crash
        fireInitQueries: false  // Prevents contact sync overload
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            const qrDataUrl = await QRCode.toDataURL(qr);
            broadcastState('QR_READY', 'Please scan the QR code', qrDataUrl);
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            console.log(`⚠️ Socket closed. Code: ${statusCode}`);

            // Interrupt handover if WhatsApp drops connection mid-sync
            if (handoverTimer) {
                clearTimeout(handoverTimer);
                handoverTimer = null;
                console.log('🛑 Handover interrupted. Resync required.');
            }

            if (shouldReconnect) {
                broadcastState('RECONNECTING', 'Connection dropped. Reconnecting...');
                setTimeout(initializeAuth, 2000);
            } else {
                broadcastState('LOGGED_OUT', 'Device unlinked. Restart server to generate new QR.');
            }
            
        } else if (connection === 'open') {
            broadcastState('SYNCING', '✅ Linked! Stabilizing connection (15s)...');
            
            if (handoverTimer) clearTimeout(handoverTimer);
            
            // Wait 15 seconds to ensure file locks are released before VoIP client takes over
            handoverTimer = setTimeout(() => {
                broadcastState('HANDOVER', 'Preparing VoIP Engine...');
                sock.ev.removeAllListeners();
                sock.ws.close();
                
                setTimeout(executeVoipCall, 3000);
            }, 15000);
        }
    });
}

// ==========================================
// 4. VOIP ENGINE (baileys-caller)
// ==========================================
async function executeVoipCall() {
    broadcastState('CALL_INIT', 'Starting WebRTC Engine...');
    
    try {
        const client = new VoipClient({ 
            authDir: AUTH_DIR,
            syncFullHistory: false, 
            fireInitQueries: false
        });

        // Timeout wrapper: Prevent silent hangs if VoIP fails to initialize WebAssembly
        const connectPromise = client.connect();
        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error("VoIP connection timed out (Check Node Version)")), 25000)
        );

        await Promise.race([connectPromise, timeoutPromise]);
        
        const targetNumber = "918925730217"; 
        const audioUrl = "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3"; 
        const durationMs = 39 * 60 * 1000; 
        
        broadcastState('CALLING', `📞 Dialing +${targetNumber}...`);
        
        const call = await client.call(targetNumber, {
            audioSource: audioUrl, 
            durationMs: durationMs 
        });

        call.on("connected", () => {
            broadcastState('ON_CALL', '🟢 Call Connected. Streaming Audio...');
        });

        call.on("ended", (reason) => {
            broadcastState('ENDED', `🔴 Call Ended. Reason: ${reason}`);
            // DO NOT process.exit() so Render doesn't wipe the auth folder.
        });

        call.on("failed", (err) => {
            broadcastState('ENDED', `❌ Call Failed: Missed or Rejected.`);
            console.error("Call failure detail:", err);
        });

    } catch (error) {
        broadcastState('ENDED', '❌ System Error during Call initialization.');
        console.error("🔥 VoIP Engine Failure:", error.message || error);
    }
}

// ==========================================
// 5. BOOTSTRAP SYSTEM
// ==========================================
if (fs.existsSync(`${AUTH_DIR}/creds.json`)) {
    console.log('🔍 Valid credentials found. Bypassing Auth & initiating VoIP Protocol...');
    executeVoipCall();
} else {
    initializeAuth();
}

const port = process.env.PORT || 3000;
httpServer.listen(port, () => {
    console.log(`🚀 Node v${process.versions.node} - Server active on port ${port}`);
});
