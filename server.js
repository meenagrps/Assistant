const admin = require('firebase-admin');
const express = require('express');

// FORCE ENTIRE SERVER NATIVELY INTO INDIAN STANDARD TIME (IST)
process.env.TZ = "Asia/Kolkata";

// ---------------------------------------------------------
// GLOBAL ERROR HANDLERS & GRACEFUL SHUTDOWN
// ---------------------------------------------------------
process.on('unhandledRejection', (reason, promise) => {
    console.error('⚠️ [CRITICAL] Background Promise Rejection caught:', reason);
});
process.on('uncaughtException', (error) => {
    console.error('⚠️ [CRITICAL] Background Exception caught:', error);
});

// ---------------------------------------------------------
// 1. FIREBASE & ENVIRONMENT VARIABLE SETUP
// ---------------------------------------------------------
let serviceAccount;

if (process.env.FIREBASE_CREDENTIALS) {
    try {
        serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
        console.log("🔒 Firebase Credentials loaded securely from Render Secrets.");
    } catch (err) {
        console.error("❌ ERROR: Your FIREBASE_CREDENTIALS secret is not valid JSON.");
        process.exit(1);
    }
} else {
    console.error("❌ FATAL ERROR: No Firebase credentials found! Please add the FIREBASE_CREDENTIALS secret in Render.");
    process.exit(1);
}

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// Telegram Bot Token Check
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TELEGRAM_BOT_TOKEN) {
    console.error("❌ FATAL ERROR: TELEGRAM_BOT_TOKEN secret is missing.");
    process.exit(1);
}

// Hugging Face API
const HF_API_URL = "https://corporationgoorac-quanai.hf.space/api/generate-bot";
let isManualGenerating = false; // RAM lock for PDF generation

// ---------------------------------------------------------
// 2. ZERO-WASTE RAM CACHE SYSTEM
// ---------------------------------------------------------
// These variables live entirely in the server's RAM.
// They prevent the server from spamming Firestore reads every time an alert triggers.
let telegramChatId = null;
let telegramSalesAlertsOn = true; 
const serverStartTime = new Date(); // Master Boot Time

async function loadTelegramConfig() {
    try {
        // Reads from Firebase EXACTLY ONCE on server boot.
        const docSnap = await db.collection('system_folder').doc('telegram_config').get();
        if (docSnap.exists) {
            const data = docSnap.data();
            telegramChatId = data.telegramChatId || null;
            
            if (data.telegramSalesAlertsOn !== undefined) {
                telegramSalesAlertsOn = data.telegramSalesAlertsOn;
            }
            console.log(`🚀 RAM Cache Loaded: Telegram ID [${telegramChatId || 'Not Set'}], Sales Alerts [${telegramSalesAlertsOn ? 'ACTIVE' : 'MUTED'}]`);
        } else {
            console.log(`ℹ️ No existing Telegram config found in database. Running on defaults.`);
        }
    } catch (err) {
        console.error("⚠️ Failed to fetch Telegram config on boot:", err);
    }
}
loadTelegramConfig();

// ---------------------------------------------------------
// 3. TELEGRAM SEND HELPERS (NATIVE HTTP)
// ---------------------------------------------------------
async function sendTelegramMessage(chatId, textMessage) {
    if (!chatId) return;
    try {
        const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: textMessage,
                parse_mode: 'HTML' // Enforces clean, crash-proof Telegram formatting
            })
        });
        const data = await response.json();
        if (!data.ok) {
            console.error("⚠️ Telegram API Delivery Error:", data.description);
        }
    } catch (error) {
        console.error("⚠️ Failed to execute Telegram native fetch request:", error.message);
    }
}

// ZERO-WASTE NATIVE PDF UPLOADER
async function sendTelegramPdfBuffer(chatId, pdfBuffer, fileName, caption = "") {
    if (!chatId) return false;
    try {
        const formData = new FormData();
        formData.append('chat_id', chatId);
        formData.append('caption', caption);
        formData.append('parse_mode', 'HTML');
        
        // Native Node 18+ conversion from Buffer to Blob
        const pdfBlob = new Blob([pdfBuffer], { type: 'application/pdf' });
        formData.append('document', pdfBlob, fileName);

        const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument`, {
            method: 'POST',
            body: formData
        });
        
        const data = await response.json();
        if (!data.ok) {
            console.error("⚠️ Telegram PDF API Error:", data.description);
            return false;
        }
        return true; // Success
    } catch (error) {
        console.error("⚠️ Failed to send PDF via Telegram:", error.message);
        return false;
    }
}

// Hugging Face Timeout Wrapper
async function fetchWithTimeout(resource, options = {}) {
    const { timeout = 300000 } = options; // 5 minutes
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(resource, { ...options, signal: controller.signal });
        clearTimeout(id);
        return response;
    } catch (error) {
        clearTimeout(id);
        throw error;
    }
}

// ---------------------------------------------------------
// 3.5 RANDOMIZED TELEGRAM TEMPLATE ENGINE
// ---------------------------------------------------------
// 10 Unique Sales Templates
const salesTemplates = [
    (d) => `🚨 <b>NEW SALE ALERT</b>\n\n📄 <b>Invoice:</b> ${d.invNo}\n👤 <b>Customer:</b> ${d.custName}\n🛍️ <b>Purchased Items:</b>\n${d.items}💰 <b>Amount:</b> ₹${d.total}\n💳 <b>Mode:</b> ${d.mode}\n\n<i>Meena Marketing Backend</i>`, // 1. Classic
    (d) => `🧾 <code>=== RECEIPT ===</code>\n<b>Inv:</b> ${d.invNo}\n<b>To:</b> ${d.custName}\n<code>-------------</code>\n${d.items}<code>-------------</code>\n<b>TOTAL:</b> ₹${d.total} (${d.mode})`, // 2. The Terminal
    (d) => `🏆 <b>EXECUTIVE SUMMARY</b>\n\n💰 <b>Revenue: ₹${d.total}</b> via ${d.mode}\n👤 Client: <i>${d.custName}</i>\n📄 Ref: ${d.invNo}\n\n<b>Cart:</b>\n${d.items}`, // 3. Executive (Total at top)
    (d) => `🛒 <b>A new sale was just closed!</b>\n\n<b>${d.custName}</b> purchased:\n${d.items}\n<b>Grand Total:</b> ₹${d.total}\n<b>Payment:</b> ${d.mode}\n<b>Invoice No:</b> ${d.invNo}`, // 4. Conversational
    (d) => `📓 <b>Ledger Entry [${d.invNo}]</b>\n\n<b>Entity:</b> ${d.custName}\n<b>Tender:</b> ${d.mode}\n<b>Value:</b> ₹${d.total}\n\n<b>Manifest:</b>\n${d.items}`, // 5. Ledger
    (d) => `🔥 <b>HIGH PRIORITY SALE</b> 🔥\n\n💵 <b>VALUE: ₹${d.total}</b>\n💳 <b>METHOD:</b> ${d.mode.toUpperCase()}\n👤 <b>BUYER:</b> ${d.custName.toUpperCase()}\n📄 <b>DOC ID:</b> ${d.invNo}\n\n<b>ITEMS:</b>\n${d.items}`, // 6. Urgent Priority
    (d) => `<b>Sale Registered</b>\nInv: ${d.invNo} | ${d.custName}\n\n${d.items}\nTotal: ₹${d.total}\nMode: ${d.mode}`, // 7. Minimalist
    (d) => `<i>New Invoice Generated</i>\n<b>#${d.invNo}</b>\n\n<b>Customer:</b> <i>${d.custName}</i>\n<b>Items:</b>\n${d.items}\n<b>Settlement:</b> <i>₹${d.total} (${d.mode})</i>`, // 8. High Contrast
    (d) => `🛍️📦💳 <b>SALE SUCCESS</b>\n\n👤 ${d.custName}\n🧾 ${d.invNo}\n\n🛒 <b>Items:</b>\n${d.items}\n💰 <b>₹${d.total}</b> [${d.mode}]`, // 9. Emojified
    (d) => `<b>TRANSACTION LOG</b>\nID: ${d.invNo}\nUSER: ${d.custName}\nAMT: ₹${d.total}\nVIA: ${d.mode}\n\n<b>Details:</b>\n${d.items}` // 10. System Log
];

// 10 Unique Ask/Inquiry Templates
// GUARANTEE: All 10 include Product Name, Model, Qty, Selling Price, MRP, and MY Rate.
const askTemplates = [
    (d) => `📦 <b>PRODUCT ENQUIRY</b>\n━━━━━━━━━━━━━━━━━━\n🔹 <b>Item:</b> ${d.name}\n🔖 <b>Model:</b> ${d.model}\n📦 <b>Qty:</b> ${d.qty}\n\n💰 <b>Selling Price:</b> Rs. ${d.base}\n🏷️ <b>MRP:</b> Rs. ${d.mrp}\n⭐ <b>MY Rate:</b> Rs. ${d.myRate}\n━━━━━━━━━━━━━━━━━━`,
    (d) => `📦 <b>PRODUCT ENQUIRY</b>\n\n<b>${d.name}</b> (<i>${d.model}</i>)\nAvailable Qty: <b>${d.qty}</b>\n\n<b>Selling Price:</b> Rs. ${d.base}\n<b>MRP:</b> Rs. ${d.mrp}\n🎯 <b>MY Rate: Rs. ${d.myRate}</b>`,
    (d) => `📦 <b>PRODUCT ENQUIRY</b>\n\n<b>Item:</b> ${d.name}\n<b>Model:</b> ${d.model}\n<b>Qty:</b> ${d.qty}\n\n💵 <b>Selling Price:</b> ${d.base}\n📈 <b>MRP:</b> ${d.mrp}\n🔥 <b>MY Rate: ${d.myRate}</b>`,
    (d) => `📦 <b>PRODUCT ENQUIRY</b>\n<code>------------------</code>\n<b>Product:</b> ${d.name}\n<b>Model:</b> ${d.model}\n<b>Qty:</b> ${d.qty}\n<code>------------------</code>\n<b>Selling Price:</b> ${d.base}\n<b>MRP:</b> ${d.mrp}\n<b>MY Rate:</b> ${d.myRate}`,
    (d) => `📦 <b>PRODUCT ENQUIRY</b>\n\nItem: <i>${d.name}</i>\nModel: <i>${d.model}</i>\nQty: ${d.qty}\n\n<b>Pricing Tier:</b>\n- <b>MRP:</b> ₹${d.mrp}\n- <b>Selling Price:</b> ₹${d.base}\n- <b>MY Rate: ₹${d.myRate}</b>`,
    (d) => `📦 <b>PRODUCT ENQUIRY</b>\n\nThey are looking at <b>${d.name}</b> (Model: ${d.model}).\nQty in stock: ${d.qty}.\n\n<b>Selling Price:</b> Rs. ${d.base}\n<b>MRP:</b> Rs. ${d.mrp}\nTell them <b>MY Rate</b> is <b>Rs. ${d.myRate}</b>.`,
    (d) => `📦 <b>PRODUCT ENQUIRY</b>\n\n${d.name} [${d.model}]\nQty: ${d.qty}\n<b>Selling Price:</b> ₹${d.base} | <b>MRP:</b> ₹${d.mrp}\n\n<b>MY Rate: ₹${d.myRate}</b>`,
    (d) => `📦 <b>PRODUCT ENQUIRY</b>\n\n<b>Item:</b> ${d.name} (${d.model})\n<b>Qty:</b> ${d.qty}\n\n<b>Selling Price:</b> ₹${d.base}\n<b>MRP:</b> ₹${d.mrp}\n<b>MY Rate:</b> <i>₹${d.myRate}</i>`,
    (d) => `📦 <b>PRODUCT ENQUIRY</b>\n\n📦 ${d.name} (${d.model})\n📊 Qty: ${d.qty}\n\n💵 <b>Selling Price:</b> ₹${d.base}\n🏷️ <b>MRP:</b> ₹${d.mrp}\n💥 <b>MY Rate: ₹${d.myRate}</b>`,
    (d) => `📦 <b>PRODUCT ENQUIRY</b>\n\n<b>QUERY:</b> ${d.name}\n<b>MODEL:</b> ${d.model}\n<b>QTY:</b> ${d.qty}\n<b>SELLING PRICE:</b> ₹${d.base}\n<b>MRP:</b> ₹${d.mrp}\n<b>MY RATE:</b> ₹${d.myRate}`
];

// 10 Unique Stock Reduction Templates
// GUARANTEE: All 10 include Product Name, Model, Qty (old -> new), Selling Price, and MRP. (NO MY Rate).
const stockTemplates = [
    (d) => `📉 <b>STOCK REDUCTION</b>\n━━━━━━━━━━━━━━━━━━\n📦 <b>Item:</b> ${d.name}\n🔖 <b>Model:</b> ${d.model}\n📉 <b>Qty:</b> ${d.old} ➔ ${d.new} (-${d.diff})\n\n💰 <b>Selling Price:</b> Rs. ${d.price}\n🏷️ <b>MRP:</b> Rs. ${d.mrp}\n\n👤 <b>By:</b> ${d.staff}\n⏱️ <b>Time:</b> ${d.time}\n🚨 <b>Reason:</b> <i>${d.reason}</i>`,
    (d) => `📉 <b>STOCK REDUCTION</b>\n\n<b>${d.name}</b> (Model: ${d.model})\nQty dropped: <b>${d.old} ➔ ${d.new} (-${d.diff})</b>\n\n<b>Selling Price:</b> Rs. ${d.price} | <b>MRP:</b> Rs. ${d.mrp}\n\n<b>By:</b> ${d.staff}\n<b>Reason:</b> <i>${d.reason}</i>`,
    (d) => `📉 <b>STOCK REDUCTION</b>\n\nItem: <i>${d.name}</i> (<i>${d.model}</i>)\nQty Change: <b>${d.old} ➔ ${d.new} (-${d.diff})</b>\n\n<b>Selling Price:</b> Rs. ${d.price}\n<b>MRP:</b> Rs. ${d.mrp}\n\nStaff: ${d.staff}\nNote: <code>${d.reason}</code>`,
    (d) => `📉 <b>STOCK REDUCTION</b>\n\n📦 <b>${d.name}</b> [${d.model}]\n📉 Qty: <b>${d.old} ➔ ${d.new} (-${d.diff})</b>\n\n💵 <b>Selling Price:</b> ${d.price}\n📈 <b>MRP:</b> ${d.mrp}\n\n👤 Staff: ${d.staff}\n💬 Reason: ${d.reason}`,
    (d) => `📉 <b>STOCK REDUCTION</b>\n<code>[INVENTORY OVERRIDE]</code>\nItem: ${d.name}\nModel: ${d.model}\nQty: ${d.old} ➔ ${d.new} (-${d.diff})\nSelling Price: ${d.price}\nMRP: ${d.mrp}\nUser: ${d.staff}\nAuth: ${d.reason}\nTime: ${d.time}`,
    (d) => `📉 <b>STOCK REDUCTION</b>\n\n${d.name} (${d.model})\nQty modified: ${d.old} ➔ ${d.new} (-${d.diff})\n\n<b>Selling Price:</b> ₹${d.price} | <b>MRP:</b> ₹${d.mrp}\n\n<i>Updated by ${d.staff} at ${d.time}</i>\nReason: ${d.reason}`,
    (d) => `📉 <b>STOCK REDUCTION</b>\n\nStaff <b>${d.staff}</b> reduced <b>${d.name}</b> (Model: ${d.model}).\nQty: ${d.old} ➔ ${d.new} (-${d.diff})\n\n<b>Selling Price:</b> Rs. ${d.price}\n<b>MRP:</b> Rs. ${d.mrp}\n\nReason: "<i>${d.reason}</i>"`,
    (d) => `📉 <b>STOCK REDUCTION</b>\n\n<b>Product:</b> ${d.name}\n<b>Model:</b> ${d.model}\n<b>Qty:</b> ${d.old} ➔ ${d.new} (-${d.diff})\n\n<b>Selling Price:</b> ₹${d.price}\n<b>MRP:</b> ₹${d.mrp}\n\n<b>Initiator:</b> ${d.staff}\n<b>Justification:</b> <i>${d.reason}</i>`,
    (d) => `📉 <b>STOCK REDUCTION</b>\n\n<b>${d.name}</b> (${d.model})\nQty: ${d.old} ➔ ${d.new} (-${d.diff})\n\n<b>Selling Price:</b> ₹${d.price}\n<b>MRP:</b> ₹${d.mrp}\n\nBy: <i>${d.staff}</i>\nReason: <b>${d.reason}</b>`,
    (d) => `📉 <b>STOCK REDUCTION</b>\n\n📦 ${d.name} (${d.model})\n📉 Qty: ${d.old} ➔ ${d.new} (-${d.diff})\n\n💰 <b>Selling Price:</b> ₹${d.price}\n🏷️ <b>MRP:</b> ₹${d.mrp}\n\n👤 ${d.staff}\n💬 ${d.reason}`
];

// Fallback Unrecognized Command Templates
const fallbackTemplates = [
    () => `⚠️ <b>Command Unrecognized.</b>\nI am strictly an alert gateway. Please use registered system prompts.`,
    () => `🤖 <i>I do not understand conversational text.</i>\nTry commands like 'status', 'marketing total', or 'gst report'.`,
    () => `🛑 <b>Invalid Input.</b>\nMy protocol only allows specific administrative commands.`,
    () => `❓ <i>Unknown Command.</i>\nI am a one-way notification microservice, not an AI chatbot.`,
    () => `⚙️ <b>System Notice:</b> Input not recognized in the current registry.`
];

// Helper to pick random template
function getRandomTemplate(templateArray, dataObject) {
    const randomIndex = Math.floor(Math.random() * templateArray.length);
    return templateArray[randomIndex](dataObject);
}

// ---------------------------------------------------------
// 4. EXPRESS WEBHOOK SERVER & TELEGRAM UI DASHBOARD
// ---------------------------------------------------------
const app = express();
app.use(express.json());

// --- 4A. TELEGRAM DARK THEME DASHBOARD (ROOT URL) ---
app.get('/', (req, res) => {
    const htmlTemplate = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
        <title>Meena Marketing - Telegram Server</title>
        <style>
            @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap');
            body {
                margin: 0; padding: 0; font-family: 'Inter', sans-serif;
                background-color: #0e1621; color: #e4e8ec; /* Telegram Night Theme */
                display: flex; flex-direction: column; align-items: center; justify-content: center;
                min-height: 100vh;
            }
            .container {
                background-color: #17212b; padding: 35px 25px;
                border-radius: 16px; box-shadow: 0 8px 30px rgba(0,0,0,0.4);
                border: 1px solid #242f3d; text-align: center; 
                max-width: 450px; width: 90%; box-sizing: border-box;
            }
            h2 { color: #ffffff; margin-top: 0; font-size: 24px; font-weight: 800; letter-spacing: -0.5px; }
            .brand-subtitle { color: #5eb5f7; font-size: 14px; font-weight: 600; text-transform: uppercase; margin-bottom: 25px; letter-spacing: 1px;}
            
            .metric-box {
                background: #242f3d; padding: 15px; border-radius: 12px;
                margin-bottom: 15px; display: flex; justify-content: space-between; align-items: center;
                border: 1px solid #2b394a;
            }
            .metric-label { font-size: 14px; color: #8a9eaf; font-weight: 600; text-align: left;}
            .metric-value { font-size: 15px; font-weight: 800; color: #ffffff; text-align: right;}
            
            .status-indicator { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 8px; }
            .status-green { background-color: #33c659; box-shadow: 0 0 10px rgba(51, 198, 89, 0.4); }
            .status-red { background-color: #e53935; box-shadow: 0 0 10px rgba(229, 57, 53, 0.4); }
            .status-orange { background-color: #ffb300; }

            .uptime-display {
                font-family: monospace; background: #0e1621; padding: 15px; border-radius: 8px;
                color: #5eb5f7; font-size: 13px; font-weight: 600; margin-bottom: 25px; border: 1px dashed #2b394a;
                line-height: 1.6;
            }
            
            .api-map { margin-top: 25px; text-align: left; }
            .api-title { font-size: 12px; color: #8a9eaf; text-transform: uppercase; font-weight: 800; margin-bottom: 10px;}
            .api-endpoint { background: #0e1621; padding: 10px; border-radius: 6px; font-size: 12px; font-family: monospace; color: #5eb5f7; margin-bottom: 8px; border: 1px solid #242f3d;}
            .api-method { color: #33c659; font-weight: bold; margin-right: 5px;}
            
            .footer { margin-top: 25px; font-size: 12px; color: #5c7083; font-weight: 600;}
        </style>
    </head>
    <body>
        <div class="container">
            <h2>Meena Marketing</h2>
            <div class="brand-subtitle">Telegram Server Gateway</div>
            
            <div class="uptime-display">
                <div style="color:#8a9eaf; margin-bottom:5px; font-family:'Inter', sans-serif; font-size:12px;">SERVER CONTINUOUS UPTIME</div>
                <span id="uptime-counter">Calculating...</span><br>
                <div style="margin-top:8px; font-size:11px; color:#5c7083;">Boot: <span id="boot-date"></span></div>
            </div>

            <div class="metric-box">
                <div class="metric-label">Master Link Status</div>
                <div class="metric-value" id="ui-link"><span class="status-indicator status-orange"></span>Polling...</div>
            </div>
            
            <div class="metric-box">
                <div class="metric-label">Live Sales Alerts</div>
                <div class="metric-value" id="ui-alerts"><span class="status-indicator status-orange"></span>Polling...</div>
            </div>

            <div class="api-map">
                <div class="api-title">Active Webhook Endpoints</div>
                <div class="api-endpoint"><span class="api-method">POST</span> /telegram-webhook</div>
                <div class="api-endpoint"><span class="api-method" style="color:#5eb5f7;">GET</span> /api/telemetry</div>
            </div>
        </div>
        <div class="footer">Zero-Waste RAM Architecture Active</div>

        <script>
            // 1. Precise Uptime Engine
            const bootTime = new Date("${serverStartTime.toISOString()}");
            
            // Format Boot Date Nicely
            const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' };
            document.getElementById('boot-date').innerText = bootTime.toLocaleDateString('en-IN', options);

            function updateUptime() {
                const now = new Date();
                let diff = Math.floor((now - bootTime) / 1000); // Total seconds

                const years = Math.floor(diff / (365 * 24 * 3600));
                diff %= (365 * 24 * 3600);
                const months = Math.floor(diff / (30 * 24 * 3600));
                diff %= (30 * 24 * 3600);
                const days = Math.floor(diff / (24 * 3600));
                diff %= (24 * 3600);
                const hours = Math.floor(diff / 3600);
                diff %= 3600;
                const minutes = Math.floor(diff / 60);
                const seconds = diff % 60;

                let timeString = "";
                if(years > 0) timeString += years + " Years, ";
                if(months > 0 || years > 0) timeString += months + " Months, ";
                
                timeString += days + " Days<br>" + 
                              String(hours).padStart(2, '0') + " Hrs, " + 
                              String(minutes).padStart(2, '0') + " Min, " + 
                              String(seconds).padStart(2, '0') + " Sec";

                document.getElementById('uptime-counter').innerHTML = timeString;
            }
            setInterval(updateUptime, 1000);
            updateUptime();

            // 2. Real-time Telemetry Polling (Zero page refresh)
            function pollTelemetry() {
                fetch('/api/telemetry')
                    .then(res => res.json())
                    .then(data => {
                        const linkEl = document.getElementById('ui-link');
                        const alertsEl = document.getElementById('ui-alerts');

                        if(data.chatId) {
                            linkEl.innerHTML = '<span class="status-indicator status-green"></span>Connected';
                        } else {
                            linkEl.innerHTML = '<span class="status-indicator status-red"></span>Waiting for /start';
                        }

                        if(data.salesActive) {
                            alertsEl.innerHTML = '<span class="status-indicator status-green"></span>ACTIVE';
                        } else {
                            alertsEl.innerHTML = '<span class="status-indicator status-red"></span>MUTED';
                        }
                    })
                    .catch(err => console.error("Telemetry Error"));
            }
            setInterval(pollTelemetry, 3000);
            pollTelemetry();
        </script>
    </body>
    </html>
    `;
    res.send(htmlTemplate);
});

// --- 4B. TELEMETRY API (For Frontend Reactivity) ---
app.get('/api/telemetry', (req, res) => {
    res.json({
        chatId: telegramChatId,
        salesActive: telegramSalesAlertsOn,
        bootTime: serverStartTime.toISOString()
    });
});

// --- 4C. TELEGRAM INTERACTIVE WEBHOOK ---
app.post('/telegram-webhook', async (req, res) => {
    // CRITICAL: Always respond 200 OK instantly so Telegram doesn't retry the payload
    res.status(200).send('OK');

    try {
        const update = req.body;
        if (!update.message || !update.message.text) return;

        const chatId = update.message.chat.id;
        const text = update.message.text.trim().toLowerCase();
        const userName = update.message.from.first_name || 'Admin';

        // --- A. /START COMMAND (Device Linking) ---
        if (text === '/start') {
            telegramChatId = chatId; // Update RAM instantly
            await db.collection('system_folder').doc('telegram_config').set({ telegramChatId: chatId }, { merge: true }); // Write to DB
            
            await sendTelegramMessage(chatId, `✅ <b>Device Linked Successfully, ${userName}!</b>\n\nThis Telegram account is now the master receiver for all Meena Marketing server alerts.\n\n<i>Use commands like 'status', 'sales pause', or 'marketing total' to control the system.</i>`);
            return;
        }

        // Security check: Ignore commands from unauthorized Telegram accounts
        if (chatId !== telegramChatId) {
            await sendTelegramMessage(chatId, "⛔ <b>Unauthorized:</b> You are not the active admin. Send /start to take control of the server alerts.");
            return;
        }

        // --- B. SALES ALERTS TOGGLE OFF ---
        if (text === 'sales pause' || text === 'sales stop' || text === 'sales off') {
            telegramSalesAlertsOn = false; // Update RAM instantly
            await db.collection('system_folder').doc('telegram_config').set({ telegramSalesAlertsOn: false }, { merge: true }); // Write to DB
            
            await sendTelegramMessage(chatId, "📴 <b>Sales Alerts Suspended</b>\n\nYou will no longer receive messaging alerts when a sales transaction is completed.");
            return;
        }

        // --- C. SALES ALERTS TOGGLE ON ---
        if (text === 'sales start' || text === 'sales on') {
            telegramSalesAlertsOn = true; // Update RAM instantly
            await db.collection('system_folder').doc('telegram_config').set({ telegramSalesAlertsOn: true }, { merge: true }); // Write to DB
            
            await sendTelegramMessage(chatId, "🔔 <b>Sales Alerts Restored</b>\n\nYou will now seamlessly receive real-time updates for newly generated invoices.");
            return;
        }

        // --- D. SYSTEM STATUS ---
        if (text === 'status') {
            const statusMsg = `📊 <b>System Control Panel</b>\n\n📱 <b>Active Master ID:</b> <code>${chatId}</code>\n🔔 <b>Sales Alerts:</b> ${telegramSalesAlertsOn ? 'ON ✅' : 'OFF 📴'}\n🟢 <b>Server:</b> Online and executing zero-waste cache logic.`;
            await sendTelegramMessage(chatId, statusMsg);
            return;
        }

        // --- E. MARKETING TOTAL (Daily Sales Calculation) ---
        if (text === 'marketing total') {
            await sendTelegramMessage(chatId, "⏳ <i>Calculating today's localized sales...</i>");
            
            const today = new Date();
            const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0);
            const endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59, 999);

            const q = await db.collection('sellings')
                .where('date', '>=', startOfDay)
                .where('date', '<=', endOfDay)
                .get();

            let cashTotal = 0, onlineTotal = 0, grandTotal = 0, count = 0;

            q.forEach(doc => {
                const data = doc.data();
                const total = data.totals?.grand || 0;
                const mode = (data.paymentMode || data.paymentMethod || 'Cash').toLowerCase();
                
                grandTotal += total;
                count++;

                if (mode === 'online') onlineTotal += total;
                else cashTotal += total;
            });

            const summaryMsg = `📈 <b>MEENA MARKETING - DAILY SUMMARY</b>\n📅 ${today.toLocaleDateString('en-IN')}\n\n🧾 <b>Total Invoices:</b> ${count}\n💵 <b>Cash Sales:</b> ₹${cashTotal.toLocaleString()}\n📱 <b>Online Sales:</b> ₹${onlineTotal.toLocaleString()}\n\n🏆 <b>GRAND TOTAL: ₹${grandTotal.toLocaleString()}</b>`;
            await sendTelegramMessage(chatId, summaryMsg);
            return;
        }

        // --- F. MANUAL GST REPORT GENERATION ---
        const gstMatch = text.match(/^(force\s+)?gst\s+report(?:\s+(.+))?$/i);
        if (gstMatch) {
            if (isManualGenerating) {
                await sendTelegramMessage(chatId, "⏳ <i>I am already generating a GST report. Please wait a moment.</i>");
                return;
            }
            
            isManualGenerating = true;
            const isForce = !!gstMatch[1];
            const param = gstMatch[2] ? gstMatch[2].trim() : null;

            try {
                await sendTelegramMessage(chatId, "⏳ <i>Connecting to Hugging Face Cloud Engine...</i>\n<i>Please wait while the PDF is assembled.</i>");
                
                let payload = { force: isForce };
                if (param) {
                    payload.mode = 'sequence';
                    payload.sequenceNo = param;
                } else {
                    payload.mode = 'date';
                    const now = new Date();
                    const y = now.getFullYear();
                    const m = String(now.getMonth() + 1).padStart(2, '0');
                    const lastDay = new Date(y, now.getMonth() + 1, 0).getDate();
                    payload.fromDate = `${y}-${m}-01`;
                    payload.toDate = `${y}-${m}-${lastDay}`;
                }

                const response = await fetchWithTimeout(HF_API_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

                if (!response.ok) {
                    if (response.status === 400) {
                        const errorData = await response.json();
                        let errorMsg = `⚠️ <b>COMPLIANCE ERROR DETECTED</b>\nI halted the PDF generation to prevent tax sequence violations.\n\n`;
                        if (errorData.missing && errorData.missing.length > 0) errorMsg += `❌ <b>Missing Bills:</b> ${errorData.missing.join(', ')}\n`;
                        if (errorData.duplicates && errorData.duplicates.length > 0) errorMsg += `⚠️ <b>Duplicates:</b> ${errorData.duplicates.join(', ')}\n`;
                        errorMsg += `\n<i>Reply with 'Force GST report ${param || ''}' to bypass this safety check.</i>`;
                        await sendTelegramMessage(chatId, errorMsg);
                    } else {
                        throw new Error(`Server returned status: ${response.status}`);
                    }
                } else {
                    const arrayBuffer = await response.arrayBuffer();
                    let pdfBuffer = Buffer.from(arrayBuffer);
                    
                    const caption = isForce 
                        ? "⚠️ <b>FORCED GST REPORT</b>\n<i>This document contains known sequence anomalies.</i>" 
                        : "✅ <b>GST REPORT GENERATED</b>\n<i>Strict sequence validation passed.</i>";
                    
                    await sendTelegramPdfBuffer(chatId, pdfBuffer, `GST_Report_${Date.now()}.pdf`, caption);
                    
                    pdfBuffer = null; // Instant Garbage Collection for Zero RAM Waste
                }
            } catch (error) {
                let errMsg = error.name === 'AbortError' 
                    ? "⏳ <b>Timeout Error:</b> The cloud server took too long. Please try again." 
                    : `❌ <b>Error:</b> Failed to generate PDF. (${error.message})`;
                await sendTelegramMessage(chatId, errMsg);
            } finally {
                isManualGenerating = false;
            }
            return;
        }

        // --- G. UNRECOGNIZED COMMAND FALLBACK ---
        // If the text does not match ANY of the above commands, trigger a random polite response
        const fallbackMsg = getRandomTemplate(fallbackTemplates, {});
        await sendTelegramMessage(chatId, fallbackMsg);
        return;

    } catch (err) {
        console.error("⚠️ Webhook processing error:", err);
    }
});

// ---------------------------------------------------------
// 5. FIREBASE ALERT LISTENERS (READING STRICTLY FROM RAM CACHE)
// ---------------------------------------------------------

// --- 5A. REAL-TIME BILLING TRIGGER ---
db.collection('sellings').where('createdAt', '>=', serverStartTime).onSnapshot(async (snapshot) => {
    snapshot.docChanges().forEach(async (change) => {
        if (change.type === 'added') {
            const billData = change.doc.data();
            
            // Prevent historical triggers
            if (billData.createdAt && billData.createdAt.toDate() < serverStartTime) return;
            
            // RAM CACHE GUARD: Zero database reads incurred here
            if (!telegramSalesAlertsOn || !telegramChatId) return;

            // HTML List Builder
            let itemListText = '';
            if (billData.items && Array.isArray(billData.items)) {
                billData.items.forEach(item => {
                    const modelText = item.model ? ` <i>(M: ${item.model})</i>` : '';
                    itemListText += `- ${item.qty}x ${item.name}${modelText}\n`;
                });
            }

            // Prepare data object for the randomized templater
            const dataObj = {
                invNo: billData.invoiceNo || 'N/A',
                custName: billData.customer?.name || 'Cash Customer',
                items: itemListText,
                total: (billData.totals?.grand || 0).toLocaleString(),
                mode: billData.paymentMode || 'Cash'
            };
            
            // Fetch a random template from the 10 available designs
            const alertMsg = getRandomTemplate(salesTemplates, dataObj);
            
            await sendTelegramMessage(telegramChatId, alertMsg);
        }
    });
}, (error) => console.error('🔥 [FATAL] Firestore Sellings Snapshot Error:', error));

// --- 5B. PRODUCT INQUIRY TRIGGER ("ASK" HOOK) ---
db.collection('ask').doc('ask').onSnapshot(async (docSnap) => {
    if (!docSnap.exists) return;
    const askData = docSnap.data();

    let clickedDate = null;
    if (askData.clickedTime) {
        clickedDate = typeof askData.clickedTime.toDate === 'function' ? askData.clickedTime.toDate() : new Date(askData.clickedTime);
    }

    if (clickedDate && clickedDate < serverStartTime) return;
    if (!telegramChatId) return; // Always sends if master device is linked

    // Prepare data object for randomized templater
    const dataObj = {
        name: askData.name || 'N/A',
        model: askData.model || 'N/A',
        base: (askData.basePrice || askData.price || 0).toLocaleString(),
        mrp: (askData.mrp || 0).toLocaleString(),
        myRate: (askData.myRate || 0).toLocaleString(),
        qty: askData.qty || 0
    };

    // Fetch a random template from the 10 available designs
    const alertMsg = getRandomTemplate(askTemplates, dataObj);
    
    await sendTelegramMessage(telegramChatId, alertMsg);
}, (error) => console.error('🔥 [FATAL] Firestore Ask Snapshot Error:', error));

// --- 5C. REAL-TIME INVENTORY REDUCTION ALERT ---
db.collection('alerts').doc('stock_reduction').onSnapshot(async (docSnap) => {
    if (!docSnap.exists) return;
    const alertData = docSnap.data();

    let editTime = null;
    if (alertData.lastUpdated) {
        editTime = new Date(alertData.lastUpdated);
    }

    if (editTime && editTime < serverStartTime) return;
    if (!telegramChatId) return; // Always sends if master device is linked

    let timeString = "Unknown Time";
    if (editTime) {
        timeString = editTime.toLocaleString('en-IN', {
            hour: '2-digit', minute: '2-digit', hour12: true,
            day: '2-digit', month: 'short', year: 'numeric'
        });
    }

    const oldQ = alertData.previousQty || 0;
    const newQ = alertData.qty || 0;

    // Prepare data object for randomized templater (NO MY Rate here)
    const dataObj = {
        name: alertData.name || 'N/A',
        model: alertData.model || 'N/A',
        price: (alertData.price || 0).toLocaleString(),
        mrp: (alertData.mrp || 0).toLocaleString(),
        old: oldQ,
        new: newQ,
        diff: oldQ - newQ,
        staff: alertData.lastEditBy || 'Unknown Staff',
        time: timeString,
        reason: alertData.lastEditReason || 'No reason provided'
    };

    // Fetch a random template from the 10 available designs
    const alertMsg = getRandomTemplate(stockTemplates, dataObj);
    
    await sendTelegramMessage(telegramChatId, alertMsg);
}, (error) => console.error('🔥 [FATAL] Firestore Stock Alert Snapshot Error:', error));

// ---------------------------------------------------------
// 6. AUTOMATED TELEGRAM GST REPORTER (STATEFUL CRON)
// ---------------------------------------------------------
async function runAutomatedTelegramGST(isBootUp = false) {
    try {
        const now = new Date();
        let targetYear = now.getFullYear();
        let targetMonth = now.getMonth(); 
        
        // Target: Last day of month, 10:00 PM to 11:59 PM
        const isLastDay = new Date(targetYear, targetMonth + 1, 0).getDate() === now.getDate();
        const isLateNight = now.getHours() >= 22; 
        
        // Zero-Read Shield: Do not query Firebase unless conditions are strictly met
        if (!isBootUp && !(isLastDay && isLateNight)) {
            return;
        }

        let reportingMonthStr = "";
        let isCatchup = false;

        if (isLastDay && isLateNight) {
            reportingMonthStr = `${targetYear}-${String(targetMonth + 1).padStart(2, '0')}`;
        } else {
            // Blackout Fix (Checked during Bootup)
            let prevMonthDate = new Date(targetYear, targetMonth - 1, 1);
            reportingMonthStr = `${prevMonthDate.getFullYear()}-${String(prevMonthDate.getMonth() + 1).padStart(2, '0')}`;
            isCatchup = true;
        }

        const docRef = db.collection('gst_reporter').doc('status');
        const docSnap = await docRef.get();
        let data = docSnap.exists ? docSnap.data() : {};
        
        // Prevent WhatsApp / Telegram Collisions by strictly isolating to 'telegramStatus'
        if (data.telegramCurrentMonth === reportingMonthStr && data.telegramStatus === "SENT") {
            return; 
        }

        const lastUpdated = data.telegramUpdatedAt ? new Date(data.telegramUpdatedAt) : new Date(0);
        const minutesSinceUpdate = (now - lastUpdated) / (1000 * 60);

        if (data.telegramCurrentMonth === reportingMonthStr && data.telegramStatus === "PROCESSING") {
            if (minutesSinceUpdate < 15) {
                return; // Another thread is working
            }
        }

        // Lock Database
        await docRef.set({
            telegramCurrentMonth: reportingMonthStr,
            telegramStatus: "PROCESSING",
            telegramUpdatedAt: new Date().toISOString()
        }, { merge: true });

        if (telegramChatId) {
            await sendTelegramMessage(telegramChatId, `⚙️ <b>Automated System:</b> Starting end-of-month GST Report generation for ${reportingMonthStr}...`);
        }

        const [yStr, mStr] = reportingMonthStr.split('-');
        const y = parseInt(yStr);
        const m = parseInt(mStr);
        const lastDayOfTarget = new Date(y, m, 0).getDate();
        
        const payload = {
            mode: 'date',
            fromDate: `${yStr}-${mStr}-01`,
            toDate: `${yStr}-${mStr}-${lastDayOfTarget}`,
            force: false // Automated system never forces errors
        };

        const response = await fetchWithTimeout(HF_API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            if (response.status === 400) {
                const errorData = await response.json();
                if (telegramChatId) {
                    let errorMsg = `🚨 <b>AUTOMATED GST REPORT FAILED</b>\nCompliance errors found in sequence for ${reportingMonthStr}.\n\n`;
                    if (errorData.missing && errorData.missing.length > 0) errorMsg += `❌ <b>Missing:</b> ${errorData.missing.join(', ')}\n`;
                    if (errorData.duplicates && errorData.duplicates.length > 0) errorMsg += `⚠️ <b>Duplicates:</b> ${errorData.duplicates.join(', ')}\n`;
                    errorMsg += `\n<i>Please fix the database and use the manual 'force gst report' command to recover.</i>`;
                    await sendTelegramMessage(telegramChatId, errorMsg);
                }
                
                await docRef.set({ telegramCurrentMonth: reportingMonthStr, telegramStatus: "FAILED", telegramUpdatedAt: new Date().toISOString() }, { merge: true });
                return;
            } else {
                throw new Error(`Server returned status: ${response.status}`);
            }
        }

        const arrayBuffer = await response.arrayBuffer();
        let pdfBuffer = Buffer.from(arrayBuffer);
        let messageDelivered = false;

        if (telegramChatId) {
            const caption = isCatchup 
                ? `✅ <b>RECOVERED GST REPORT</b>\n<i>This report for ${reportingMonthStr} was missed during an outage and has been automatically recovered.</i>`
                : `✅ <b>MONTHLY GST REPORT</b>\n<i>Automated delivery for ${reportingMonthStr}.</i>`;
            
            messageDelivered = await sendTelegramPdfBuffer(telegramChatId, pdfBuffer, `GST_Report_${reportingMonthStr}.pdf`, caption);
        }

        pdfBuffer = null; // Instant Garbage Collection for Zero RAM Waste

        if (messageDelivered) {
            await docRef.set({
                telegramCurrentMonth: reportingMonthStr,
                telegramStatus: "SENT",
                telegramUpdatedAt: new Date().toISOString()
            }, { merge: true });
        }

    } catch (error) {
        console.error("Automated GST System Error:", error);
        if (telegramChatId && error.name !== 'AbortError') {
            await sendTelegramMessage(telegramChatId, `❌ <b>Automated GST Task Error:</b> Failed to process report. (${error.message})`);
        }
        await db.collection('gst_reporter').doc('status').set({ 
            telegramStatus: "FAILED", 
            telegramUpdatedAt: new Date().toISOString() 
        }, { merge: true });
    }
}

// Check every 10 minutes normally
setInterval(() => runAutomatedTelegramGST(false), 600000);
// Check 45 seconds after server boots (to catch blackouts)
setTimeout(() => runAutomatedTelegramGST(true), 45000);


// ---------------------------------------------------------
// 7. SERVER INITIALIZATION
// ---------------------------------------------------------
const PORT = process.env.PORT || 7860;
app.listen(PORT, () => {
    console.log(`\n========================================================`);
    console.log(`🌐 Meena Marketing TELEGRAM Server running on port ${PORT}`);
    console.log(`⚡ Zero-Waste RAM Cache, 30-Template Engine & PDF GST Reporter Active`);
    console.log(`========================================================\n`);
}).on('error', (err) => {
    console.error('⚠️ [CRITICAL] Express Server Error:', err);
});
