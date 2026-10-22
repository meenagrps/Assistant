import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { VoipClient } from 'baileys-caller';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import QRCode from 'qrcode';
import fs from 'fs';
import ffmpegStatic from 'ffmpeg-static';

// Give Render access to FFmpeg without manual installation
process.env.FFMPEG_PATH = ffmpegStatic;
process.on('uncaughtException', (err) => console.error('Caught exception:', err));
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

const AUTH_DIR = './auth';
let currentQR = null;
let isAuthenticated = false;
let isHandingOver = false;
let handoverTimer = null; 

// 1. Clean Web Interface
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>QR Login</title>
        </head>
        <body style="text-align: center; font-family: monospace; margin-top: 50px;">
            <h2 id="status">Loading...</h2>
            <img id="qrcode" style="display:none; margin: 0 auto; max-width: 100%;" src=""/>
            
            <script src="/socket.io/socket.io.js"></script>
            <script>
                const socket = io();
                const statusEl = document.getElementById('status');
                const qrEl = document.getElementById('qrcode');
                
                socket.on('connect', () => { statusEl.innerText = 'Waiting for QR...'; });
                socket.on('qr', (url) => { 
                    qrEl.src = url; 
                    qrEl.style.display = 'block'; 
                    statusEl.innerText = 'Scan this QR code'; 
                });
                socket.on('scanned', () => { 
                    qrEl.style.display = 'none'; 
                    statusEl.innerText = '✅ Scanned! WhatsApp is syncing keys...'; 
                });
                socket.on('calling', () => {
                    statusEl.innerText = '📞 Dialing the number now...';
                });
            </script>
        </body>
        </html>
    `);
});

io.on('connection', (socket) => {
    if (isHandingOver) {
        socket.emit('calling');
    } else if (isAuthenticated) {
        socket.emit('scanned');
    } else if (currentQR) {
        socket.emit('qr', currentQR);
    }
});

// 2. Authentication (with Chat Sync Disabled to stop pkmsg errors)
async function startAuth() {
    console.log('Starting Baileys authentication...');
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();
    
    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        markOnlineOnConnect: false,
        // CRITICAL FIXES FOR pkmsg ERRORS:
        syncFullHistory: false, // Don't download old messages
        fireInitQueries: false  // Don't request contacts or groups on login
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            currentQR = await QRCode.toDataURL(qr);
            io.emit('qr', currentQR);
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            console.log(`⚠️ Connection closed (Code: ${statusCode}).`);

            if (handoverTimer) {
                console.log('Interrupting handover timer...');
                clearTimeout(handoverTimer);
                handoverTimer = null;
                isHandingOver = false;
            }

            if (shouldReconnect) {
                console.log('Reconnecting in 2 seconds...');
                setTimeout(startAuth, 2000);
            }
            
        } else if (connection === 'open') {
            console.log('✅ Connection Open! Starting 12-second stabilization timer...');
            isAuthenticated = true;
            currentQR = null;
            io.emit('scanned');
            
            if (handoverTimer) clearTimeout(handoverTimer);
            
            handoverTimer = setTimeout(() => {
                console.log('Session is stable! Handing over to VoIP Client...');
                isHandingOver = true;
                io.emit('calling');
                
                sock.ev.removeAllListeners();
                sock.ws.close();
                
                setTimeout(startVoipCall, 3000);
            }, 12000);
        }
    });
}

// 3. Automated Call Logic
async function startVoipCall() {
    console.log("Connecting VoIP Client...");
    
    try {
        const client = new VoipClient({ authDir: AUTH_DIR });
        await client.connect();
        
        const targetNumber = "918925730217"; 
        const audioUrl = "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3"; 
        const durationMs = 39 * 60 * 1000; 
        
        console.log(`📞 Placing call to +${targetNumber}...`);
        
        const call = await client.call(targetNumber, {
            audioSource: audioUrl, 
            durationMs: durationMs 
        });

        call.on("connected", () => {
            console.log("🟢 They answered! Audio is playing.");
        });

        call.on("ended", (reason) => {
            console.log(`🔴 Call ended. Reason: ${reason}`);
        });

    } catch (error) {
        console.error("Failed to place call:", error);
    }
}

// 4. Initialization
if (fs.existsSync(`${AUTH_DIR}/creds.json`)) {
    console.log('Credentials found. Skipping web auth and making call...');
    isAuthenticated = true;
    isHandingOver = true;
    startVoipCall();
} else {
    startAuth();
}

const port = process.env.PORT || 3000;
httpServer.listen(port, () => {
    console.log(`🌐 Server running on port ${port}`);
});
