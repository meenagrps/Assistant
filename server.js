import { makeWASocket, useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import { VoipClient } from 'baileys-caller';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import QRCode from 'qrcode';
import fs from 'fs';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

const AUTH_DIR = './auth';
let currentQR = null;
let isAuthenticated = false;

// 1. Barebones Web Interface (No Portal)
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
                    statusEl.innerText = '✅ Logged In! Making Call...'; 
                });
            </script>
        </body>
        </html>
    `);
});

io.on('connection', (socket) => {
    if (isAuthenticated) {
        socket.emit('scanned');
    } else if (currentQR) {
        socket.emit('qr', currentQR);
    }
});

// 2. WhatsApp Auth with Auto-Reconnect for Error 515
async function startAuth() {
    console.log('Starting Baileys authentication...');
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false
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
            console.log(`Connection closed. Reason: ${lastDisconnect?.error?.message}. Reconnecting: ${shouldReconnect}`);
            
            // This is the critical fix for Error 515 - it automatically reconnects
            if (shouldReconnect) {
                startAuth();
            }
        } else if (connection === 'open') {
            isAuthenticated = true;
            currentQR = null;
            io.emit('scanned');
            console.log('✅ Authenticated successfully!');
            
            // Close standard connection to hand over to VoIP
            sock.ws.close();
            
            // Give it 5 seconds to ensure session keys are fully written to the disk
            setTimeout(() => {
                startVoipCall();
            }, 5000);
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
            process.exit(0); 
        });

    } catch (error) {
        console.error("Failed to place call:", error);
    }
}

// 4. Initialization
if (fs.existsSync(`${AUTH_DIR}/creds.json`)) {
    console.log('Credentials found. Skipping web auth and making call...');
    isAuthenticated = true;
    startVoipCall();
} else {
    startAuth();
}

const port = process.env.PORT || 3000;
httpServer.listen(port, () => {
    console.log(`🌐 Server running on port ${port}`);
});
