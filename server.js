import { makeWASocket, useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import { VoipClient } from 'baileys-caller';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import QRCode from 'qrcode';
import fs from 'fs';
import ffmpegStatic from 'ffmpeg-static';

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
let handoverTimer = null; // New variable to track our 12-second wait

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

// 2. Authentication using STANDARD Baileys
async function startAuth() {
    console.log('Starting Baileys authentication...');
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        markOnlineOnConnect: false
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

            // CRITICAL FIX: If WhatsApp throws 428 while we are waiting, CANCEL the handover and retry!
            if (handoverTimer) {
                console.log('Interrupting handover to allow WhatsApp to finish syncing...');
                clearTimeout(handoverTimer);
                handoverTimer = null;
                isHandingOver = false;
            }

            if (shouldReconnect) {
                console.log('Reconnecting in 2 seconds...');
                setTimeout(startAuth, 2000);
            } else {
                console.log('You logged out. Please delete the auth folder and restart.');
            }
            
        } else if (connection === 'open') {
            console.log('✅ Connection Open! Starting 12-second stabilization timer...');
            isAuthenticated = true;
            currentQR = null;
            io.emit('scanned');
            
            // Clear any old timers just to be safe
            if (handoverTimer) clearTimeout(handoverTimer);
            
            // Start the 12-second countdown. If no 428 error interrupts this, we make the call!
            handoverTimer = setTimeout(() => {
                console.log('Session is stable! Handing over to VoIP Client...');
                isHandingOver = true;
                io.emit('calling');
                
                // Safely kill standard Baileys
                sock.ev.removeAllListeners();
                sock.ws.close();
                
                // Start VoIP Call
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
