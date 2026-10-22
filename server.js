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

// 1. Create the Web Interface
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>WhatsApp Bot Login</title>
            <style>
                body { font-family: sans-serif; text-align: center; margin-top: 50px; background: #f0f2f5; }
                .card { background: white; padding: 40px; border-radius: 10px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); display: inline-block; }
                #qrcode { display: none; margin: 20px auto; border: 15px solid white; border-radius: 10px; }
            </style>
        </head>
        <body>
            <div class="card">
                <h2>WhatsApp Web Authentication</h2>
                <div id="status">Waiting for QR Code...</div>
                <img id="qrcode" src=""/>
            </div>
            
            <script src="/socket.io/socket.io.js"></script>
            <script>
                const socket = io();
                const statusEl = document.getElementById('status');
                const qrEl = document.getElementById('qrcode');
                
                socket.on('qr', (dataUrl) => {
                    qrEl.src = dataUrl;
                    qrEl.style.display = 'block';
                    statusEl.innerText = 'Please scan this QR code with your WhatsApp app';
                });
                
                socket.on('scanned', () => {
                    qrEl.style.display = 'none';
                    statusEl.innerHTML = '<h1 style="color: #25D366;">✅ Scanned Successfully!</h1><p>Bot is now authenticated and starting the call...</p>';
                });
            </script>
        </body>
        </html>
    `);
});

// 2. Handle WhatsApp Authentication via standard Baileys
async function startAuth() {
    console.log('Starting authentication process...');
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false // We are sending it to the web interface instead
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, qr } = update;
        
        // Send QR to the webpage
        if (qr) {
            const qrDataUrl = await QRCode.toDataURL(qr);
            io.emit('qr', qrDataUrl);
        }

        // Once successfully logged in
        if (connection === 'open') {
            io.emit('scanned'); // Show the green checkmark on the web interface
            console.log('✅ Authenticated successfully!');
            
            // Terminate standard Baileys so the VoIP client can take over the connection
            sock.ws.close();
            
            // Wait 3 seconds to ensure the standard connection is fully closed, then start the call
            setTimeout(() => {
                startVoipCall();
            }, 3000);
        }
    });
}

// 3. Make the automated call using baileys-caller
async function startVoipCall() {
    const client = new VoipClient({ authDir: AUTH_DIR });
    
    console.log("Connecting VoIP Client...");
    await client.connect();
    
    const targetNumber = "918925730217"; // The number you requested
    // You can pass direct internet HTTP links to MP3 files because FFmpeg supports them natively
    const audioUrl = "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3"; 
    const durationMs = 39 * 60 * 1000; // 39 minutes converted to milliseconds
    
    console.log(`📞 Placing call to +${targetNumber}...`);
    
    try {
        const call = await client.call(targetNumber, {
            audioSource: audioUrl, // Stream directly from the internet URL
            durationMs: durationMs // baileys-caller will automatically hang up after this time
        });

        call.on("connected", () => {
            console.log("🟢 They answered the call! Internet music is now playing.");
        });

        call.on("ended", (reason) => {
            console.log(`🔴 Call ended. Reason: ${reason}`);
            client.disconnect();
            process.exit(0); // Exit the script after the call is done
        });

    } catch (error) {
        console.error("Failed to place call:", error);
    }
}

// 4. Initialize Logic
// If auth folder exists, we are already logged in. Skip QR and jump straight to the call.
if (fs.existsSync(`${AUTH_DIR}/creds.json`)) {
    console.log('Credentials found. Skipping web authentication and making call immediately.');
    startVoipCall();
} else {
    // Start web interface and wait for scan
    startAuth();
}

// Start the web server
httpServer.listen(3000, () => {
    console.log('🌐 Web interface is running! Open your browser and go to http://localhost:3000');
});
