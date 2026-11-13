# WA Multi Panel v2

Multiple WhatsApp numbers, one panel.  
Live OTP feed per account. Sessions survive redeploys with Upstash Redis.

---

## What it does

- Add any number of WhatsApp accounts
- Each account has its own OTP terminal — incoming messages show extracted codes, tap to copy
- Accounts stay connected across server restarts and redeploys (requires Upstash — free)
- Password-protected panel

---

## Deploy — Step by Step

### Step 1 — Upstash Redis (free, keeps sessions alive across redeploys)

1. Go to [upstash.com](https://upstash.com) → Create Account (free)
2. Console → Create Database
   - Name: `wa-panel` (anything)
   - Region: pick one close to your Render region
   - Type: Regional
3. After creation, go to **REST API** tab
4. Copy these two values — you'll need them in Step 3:
   - `UPSTASH_REDIS_REST_URL`  → looks like `https://xxxx.upstash.io`
   - `UPSTASH_REDIS_REST_TOKEN` → long base64 string

> Without Upstash, sessions still work but reset on every redeploy.  
> With Upstash, sessions survive redeploys — accounts reconnect automatically.

---

### Step 2 — GitHub

```bash
git init
git add .
git commit -m "wa multi panel"
git remote add origin https://github.com/YOUR_USER/wa-panel.git
git push -u origin main
```

---

### Step 3 — Render

1. [render.com](https://render.com) → **New Web Service**
2. Connect your GitHub repo
3. Settings auto-fill from `render.yaml`
4. **Environment Variables** mein add karo:

   | Key | Value |
   |-----|-------|
   | `ADMIN_PASSWORD` | apna password (kuch bhi, strong rakho) |
   | `UPSTASH_REDIS_REST_URL` | Upstash se copy kiya hua |
   | `UPSTASH_REDIS_REST_TOKEN` | Upstash se copy kiya hua |

5. **Deploy** karo

---

### Step 4 — Use karo

Panel URL: `https://your-app.onrender.com`

1. `ADMIN_PASSWORD` se login
2. **+ Add Account** → number dalo (country code ke saath, bina +)  
   Example: India → `919876543210`
3. QR code scan karo WhatsApp se:  
   Settings → Linked Devices → Link a Device
4. Connected → account sidebar mein dikhega
5. OTP terminal: incoming messages automatically show hote hain, codes highlight ke saath

---

## Multi-account use

- Kitne bhi accounts add kar sakte ho
- Left sidebar ya top strip se select karo
- Har account ka apna OTP terminal hai
- Codes tap karo → clipboard pe copy

---

## Persistence — kya hota hai

| Scenario | Redis ON | Redis OFF |
|---|---|---|
| Server restart | ✅ Stays connected | ✅ Stays connected |
| Redeploy | ✅ Auto-reconnects | ❌ Re-scan needed |
| New account added | ✅ Saved to Redis | ✅ Saved to files |
| Account removed | ✅ Deleted from Redis | ✅ Deleted from files |

---

## Render Free Tier — Sleep Problem

Free tier sleeps after 15 min inactivity.  
Server auto-pings itself every 4 min using `RENDER_EXTERNAL_URL`.  

If that's not enough:
- **UptimeRobot** (free) — ping your URL every 5 min
- Or upgrade to Render's paid plan ($7/mo) — always on

---

## Troubleshoot

| Problem | Fix |
|---|---|
| "Account already exists" | That number is already added |
| QR not showing | Wait 10–15 sec, Baileys kuch time leta hai |
| Connected but no OTPs | Only personal messages show (not groups) |
| Account disappeared after redeploy | Upstash setup nahi kiya — do Step 1 |
| "Auth required" on page load | Session expire — re-login |
| Slow first load on free tier | Free tier wakeup = 30–60 sec cold start |

---

## Security

- Panel `ADMIN_PASSWORD` se protect hai
- 24-hour session tokens
- WhatsApp sessions server pe stored hain — HTTPS use karo (Render default)
- `OWNER_NUMBER` env var nahi hai is version mein — koi bhi password se login kar sakta hai
  (private use ke liye theek hai, public deploy ke liye extra auth add karo)
