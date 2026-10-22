import { makeWASocket, useMultiFileAuthState } from '@whiskeysockets/baileys';
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
let currentQR = null; // Stores the latest QR code so late-connecting browsers can still get it
let isAuthenticated = false;

// 1. Create the Web Interface (Now Mobile Friendly)
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <!-- This tag makes it scale perfectly on mobile screens -->
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>WhatsApp Bot Login</title>
            <style>
                body { font-family: sans-serif; text-align: center; margin: 0; padding: 20px; background: #f0f2f5; }
                .card { background: white; padding: 20px; border-radius: 10px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); max-width: 400px; margin: 0 auto; width: 100%; box-sizing: border-box; }
                h2 { font-size: 1.2rem; }
                #qrcode { display: none; margin: 20px auto; max-width: 100%; border-radius: 10px; }
                #status { margin-top: 10px; font-size: 0.9rem; color: #555; }
            </style>
        </head>
        <body>
            <div class="card">
                <h2>WhatsApp Web Authentication</h2>
                <div id="status">Connecting to server...</div>
                <img id="qrcode" src=""/>
            </div>
            
            <script src="/socket.io/socket.io.js"></script>
            <script>
                const socket = io();
                const statusEl = document.getElementById('status');
                const qrEl = document.getElementById('qrcode');
                
                // When the browser successfully connects to the backend
                socket.on('connect', () => {
                    statusEl.innerText = 'Connected! Waiting for QR Code...';
                });

                socket.on('qr', (dataUrl) => {
                    qrEl.src = dataUrl;
                    qrEl.style.display = 'block';
                    statusEl.innerText = 'Please scan this QR code with your WhatsApp app';
                });
                
                socket.on('scanned', () => {
                    qrEl.style.display = 'none';
                    statusEl.innerHTML = '<h3 style="color: #25D366;">✅ Scanned Successfully!</h3><p>Starting the call...</p>';
                });
            </script>
        </body>
        </html>
    `);
});

// Send the current QR code to ANY user who opens the web page
io.on('connection', (socket) => {
    if (isAuthenticated) {
        socket.emit('scanned');
    } else if (currentQR) {
        socket.emit('qr', currentQR);
    }
});

// 2. Handle WhatsApp Authentication
async function startAuth() {
    console.log('Starting authentication process...');
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, qr } = update;
        
        // Save the QR and send it to the webpage
        if (qr) {
            console.log('QR Code generated. Broadcasting to web interface...');
            currentQR = await QRCode.toDataURL(qr);
            io.emit('qr', currentQR);
        }

        // Once successfully logged in
        if (connection === 'open') {
            isAuthenticated = true;
            currentQR = null; // Clear the stored QR code
            io.emit('scanned'); 
            console.log('✅ Authenticated successfully!');
            
            // Terminate standard Baileys so the VoIP client can take over
            sock.ws.close();
            
            // Wait 3 seconds, then start the call
            setTimeout(() => {
                startVoipCall();
            }, 3000);
        }
    });
}

// 3. Make the automated call
async function startVoipCall() {
    const client = new VoipClient({ authDir: AUTH_DIR });
    
    console.log("Connecting VoIP Client...");
    await client.connect();
    
    const targetNumber = "918925730217"; 
    const audioUrl = "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3"; 
    const durationMs = 39 * 60 * 1000; // 39 minutes
    
    console.log(`📞 Placing call to +${targetNumber}...`);
    
    try {
        const call = await client.call(targetNumber, {
            audioSource: audioUrl, 
            durationMs: durationMs 
        });

        call.on("connected", () => {
            console.log("🟢 They answered the call! Internet music is now playing.");
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

// 4. Initialize Logic
if (fs.existsSync(`${AUTH_DIR}/creds.json`)) {
    console.log('Credentials found. Skipping web authentication and making call immediately.');
    isAuthenticated = true;
    startVoipCall();
} else {
    startAuth();
}

// Start the web server using Render's assigned Port
const port = process.env.PORT || 3000;
httpServer.listen(port, () => {
    console.log(`🌐 Web interface is running on port ${port}`);
});
