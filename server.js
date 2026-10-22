import { makeWASocket, useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import { VoipClient } from 'baileys-caller';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import QRCode from 'qrcode';
import fs from 'fs';

// --- ANTI-CRASH MECHANISM FOR RENDER ---
// This prevents the server from restarting and wiping your auth folder if an error occurs.
process.on('uncaughtException', (err) => console.error('Caught exception:', err));
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

const AUTH_DIR = './auth';
let currentQR = null;
let isAuthenticated = false;
let isCalling = false; // Prevent multiple call triggers

// 1. Barebones Web Interface
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
                    statusEl.innerText = '✅ Logged In! Syncing keys, please wait...'; 
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
    if (isCalling) {
        socket.emit('calling');
    } else if (isAuthenticated) {
        socket.emit('scanned');
    } else if (currentQR) {
        socket.emit('qr', currentQR);
    }
});

// 2. WhatsApp Auth
async function startAuth() {
    console.log('Starting Baileys authentication...');
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        markOnlineOnConnect: false // Helps prevent immediate 428 errors
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            currentQR = await QRCode.toDataURL(qr);
            io.emit('qr', currentQR);
        }

        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log(`Connection closed. Reconnecting: ${shouldReconnect}`);
            
            if (shouldReconnect && !isCalling) {
                setTimeout(startAuth, 2000); // Wait 2 seconds before reconnecting
            }
        } else if (connection === 'open') {
            isAuthenticated = true;
            currentQR = null;
            io.emit('scanned');
            console.log('✅ Authenticated successfully! Waiting 15 seconds for WhatsApp to sync security keys...');
            
            // CRITICAL FIX: Give WhatsApp 15 seconds to finish background sync before closing
            setTimeout(() => {
                console.log('Sync complete. Handing over to VoIP Client...');
                isCalling = true;
                io.emit('calling');
                
                // Gracefully close standard connection, not a hard kill
                sock.end(undefined); 
                
                setTimeout(startVoipCall, 3000);
            }, 15000);
        }
    });
}

// 3. Automated Call Logic
async function startVoipCall() {
    const client = new VoipClient({ authDir: AUTH_DIR });
    
    console.log("Connecting VoIP Client...");
    await client.connect();
    
    const targetNumber = "918925730217"; 
    const audioUrl = "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3"; 
    const durationMs = 39 * 60 * 1000; // 39 mins
    
    console.log(`📞 Placing call to +${targetNumber}...`);
    
    try {
        const call = await client.call(targetNumber, {
            audioSource: audioUrl, 
            durationMs: durationMs 
        });

        call.on("connected", () => {
            console.log("🟢 They answered! Audio is playing.");
        });

        call.on("ended", (reason) => {
            console.log(`🔴 Call ended. Reason: ${reason}`);
            client.disconnect();
            // Do NOT use process.exit(0) here on Render, or it wipes the auth folder!
            console.log("Call finished. Server staying alive to preserve Auth data.");
        });

    } catch (error) {
        console.error("Failed to place call:", error);
    }
}

// 4. Initialization
if (fs.existsSync(`${AUTH_DIR}/creds.json`)) {
    console.log('Credentials found. Skipping web auth and making call...');
    isAuthenticated = true;
    isCalling = true;
    startVoipCall();
} else {
    startAuth();
}

const port = process.env.PORT || 3000;
httpServer.listen(port, () => {
    console.log(`🌐 Server running on port ${port}`);
});
