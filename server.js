import { VoipClient } from 'baileys-caller';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import QRCode from 'qrcode';
import fs from 'fs';

// Anti-crash mechanism
process.on('uncaughtException', (err) => console.error('Caught exception:', err));
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);
const AUTH_DIR = './auth';

let currentQR = null;
let isAuthenticated = fs.existsSync(`${AUTH_DIR}/creds.json`);

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
                    statusEl.innerText = '✅ Logged In! Waiting to start call...'; 
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

// 2. Use VoipClient Directly for Everything
async function startApp() {
    const client = new VoipClient({ authDir: AUTH_DIR });

    console.log("Connecting VoIP Client...");

    // The VoIP client exposes the underlying Baileys socket
    client.on('connection.update', async (update) => {
        const { connection, qr } = update;
        
        if (qr) {
            currentQR = await QRCode.toDataURL(qr);
            io.emit('qr', currentQR);
        }

        if (connection === 'open') {
            isAuthenticated = true;
            currentQR = null;
            io.emit('scanned');
            console.log('✅ Authenticated successfully!');
            
            // Wait a few seconds after login before making the call
            setTimeout(() => {
                makeCall(client);
            }, 5000);
        }
    });

    try {
        await client.connect();
    } catch (err) {
        console.error("Failed to connect VoIP client:", err);
    }
}

// 3. Automated Call Logic
async function makeCall(client) {
    const targetNumber = "918925730217"; 
    const audioUrl = "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3"; 
    const durationMs = 39 * 60 * 1000;
    
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
            // Don't kill the server, just let it idle
        });

    } catch (error) {
        console.error("Failed to place call:", error);
    }
}

// 4. Initialization
startApp();

const port = process.env.PORT || 3000;
httpServer.listen(port, () => {
    console.log(`🌐 Server running on port ${port}`);
});
