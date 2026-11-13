# WA Multi Panel v3

Multiple WhatsApp numbers, one panel.  
Live OTP feed per account. Everything stored on Render — no external services.

---

## Deploy — Step by Step

### Step 1 — GitHub

```bash
git init
git add .
git commit -m "wa multi panel v3"
git remote add origin https://github.com/YOUR_USER/wa-panel.git
git push -u origin main
```

### Step 2 — Render

1. [render.com](https://render.com) → **New Web Service**
2. Connect your GitHub repo
3. Settings auto-fill from `render.yaml`
4. **Environment Variables** mein sirf ek add karo:

   | Key | Value |
   |-----|-------|
   | `ADMIN_PASSWORD` | apna password (kuch bhi, strong rakho) |

5. **Deploy** karo

That's it. No Upstash. No external database. Sab Render pe.

---

## Kya kahan store hota hai

```
/data/                    ← Render persistent disk (1GB)
  accounts.json           ← added accounts ki list
  sessions.json           ← admin login tokens
  auth/
    919876543210/         ← WA auth files per account
    918888888888/
```

Redeploy ke baad bhi sab wahi milega.

---

## Use karo

Panel URL: `https://your-app.onrender.com`

1. `ADMIN_PASSWORD` se login
2. **+ Add Account** → number dalo (country code ke saath, bina +)  
   Example: India → `919876543210`
3. QR scan karo → Settings → Linked Devices → Link a Device
4. Connected → OTP terminal ready

---

## Persistence

| Scenario | Result |
|---|---|
| Server restart | ✅ Accounts auto-reconnect |
| Redeploy | ✅ Accounts + login session dono survive |
| New account | ✅ `/data/accounts.json` mein save |
| Account removed | ✅ Files delete, list update |

---

## Troubleshoot

| Problem | Fix |
|---|---|
| QR nahi aa raha | 10–15 sec wait karo |
| Account redeploy ke baad gaya | `DATA_DIR=/data` env var check karo |
| Login ke baad bhi logout | Same — DATA_DIR check karo |
| Slow first load | Starter plan cold start ~5 sec |
