# Meena Marketing - Telegram Microservice Gateway

A production-ready, highly optimized, zero-waste Node.js microservice designed to run in parallel with existing backend infrastructure. It provides real-time business alerts, automated month-end GST report dispatch, and interactive remote control via Telegram without incurring unnecessary database reads or resource bloat.

---

## 🚀 Key Architectural Highlights

* **Zero-Waste RAM Caching:** Fetches system configuration from Firebase *exactly once* on server boot. Subsequent commands and real-time triggers evaluate strictly against the server's local RAM cache, saving continuous database read operations.
* **Total Database Isolation:** Operates on dedicated Firebase paths (`system_folder/telegram_config` and isolated fields in `gst_reporter/status`) to guarantee zero data collisions or race conditions with parallel systems (such as WhatsApp bots).
* **Native HTTP & Memory Streaming:** Completely free of heavy browser dependencies (no Puppeteer, no headless Chrome, no QR code generation files). Uses native Node.js `fetch`, `FormData`, and `Blob` APIs to stream PDF reports directly from cloud endpoints to Telegram in-memory.
* **Instant Garbage Collection:** Forces active document buffers to `null` the exact millisecond Telegram confirms delivery, maintaining a flat, predictable memory footprint on cloud hosts like Render.
* **Smart Zero-Read Shield:** Automated routines evaluate local system clocks to sleep silently for 29 days a month, waking up only during the final night window to verify or dispatch month-end tax compliance reports.
* **30-Template Randomized Engine:** Dynamically cycles through 10 distinct structural layouts for Sales, Product Inquiries, and Inventory Reductions to prevent notification fatigue while maintaining strict Telegram HTML safety (`<b>`, `<i>`, `<code>`).
* **Dark-Themed Telemetry Dashboard:** Exposes a responsive, Telegram-styled web interface on the root URL featuring a precise real-time uptime engine and live state polling.

---

## 📋 Environment Variables

To successfully deploy this service on Render or any cloud provider, configure the following environment variables in your deployment dashboard:

| Variable Name | Description | Example Value |
| :--- | :--- | :--- |
| `TELEGRAM_BOT_TOKEN` | Your Telegram Bot Father API Token | `8441194390:AAEoltySyoge...` |
| `FIREBASE_CREDENTIALS` | Full JSON string of your Firebase Service Account | `{"type": "service_account", ...}` |
| `TZ` | Forces system timezone to Indian Standard Time | `Asia/Kolkata` |
| `PORT` | Dynamic port binding provided by cloud host | `7860` or `10000` |

---

## 🛠️ Installation & Local Setup

1. **Clone or create the project directory:**
   ```bash
   mkdir meena-telegram-bot && cd meena-telegram-bot
