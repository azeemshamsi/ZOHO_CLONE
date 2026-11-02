# Moving OrdexaGo to Oracle Cloud (app + Oracle Autonomous Database)

Everything runs on Oracle Cloud's **Always Free** tier:

- **The app** runs on one free Ampere server (4 cores, 24 GB memory).
- **The data** lives in an Always Free **Autonomous Database**, which has 20 GB of space. Oracle handles its backups and updates. OrdexaGo talks to it through Oracle's MongoDB API, so the code stays the same.

You'll need to set aside about 1–2 hours of clicking. Steps marked 👤 are yours; the server script does the rest.

---

## 1. 👤 Create the Oracle Cloud account

1. Sign up at **cloud.oracle.com** → *Sign up*. A card is needed for verification; Always Free resources are never charged.
2. **Home region:** pick **India West (Mumbai)** or **India South (Hyderabad)**. This can't be changed later. The database and the server must be in this region.
3. *Optional, recommended:* Billing → *Upgrade to Pay As You Go*. Always Free resources stay free. Free Ampere servers are often "out of capacity" in Indian regions on trial accounts, and Pay As You Go accounts usually get one immediately.

## 2. 👤 Create the database

1. Menu → **Oracle Database → Autonomous Database → Create Autonomous Database**.
2. Fill in the form:
   - **Display name / Database name:** `ordexago`
   - **Workload type:** *JSON* (or *Transaction Processing* — both work)
   - **Always Free:** switch **ON**
   - **Database version:** **26ai** (needed for full MongoDB API support; choose the newest offered)
   - **ADMIN password:** a strong password. Keep it safe and don't paste it in chat.
   - **Network access:** *Secure access from allowed IPs and VCNs only*. Add **your own IP** for now; you'll add the server's IP in step 4. The MongoDB API doesn't work with "Secure access from everywhere".
   - **Require mutual TLS (mTLS):** **OFF**
3. Click **Create** and wait until the database shows *Available*.

## 3. 👤 Create the app's database user

1. Open the database → **Database actions → Database Users → + Create User**.
2. Set up the user:
   - **User name:** `ORDEXAGO`
   - **Password:** use letters and digits only, which avoids URL-escaping problems
   - **REST Enabled:** ON
   - **Quota on tablespace DATA:** UNLIMITED
3. Open the **Granted Roles** tab and tick `SODA_APP`, `CONNECT` and `RESOURCE`. Click **Create User**.
4. Back on the database page, open **Tool configuration → MongoDB API**. Copy the **Public access URL**. It looks like:
   `mongodb://[user:password@]XXXX-ORDEXAGO.adb.ap-mumbai-1.oraclecloudapps.com:27017/[user]?authMechanism=PLAIN&authSource=$external&ssl=true&retryWrites=false&loadBalanced=true`
5. Make your connection string by replacing `[user:password@]` with `ordexago:YOURPASSWORD@` and `[user]` with `ordexago`:
   `mongodb://ordexago:YOURPASSWORD@XXXX-ORDEXAGO.adb.ap-mumbai-1.oraclecloudapps.com:27017/ordexago?authMechanism=PLAIN&authSource=$external&ssl=true&retryWrites=false&loadBalanced=true`

## 4. 👤 Create the server

1. Menu → **Compute → Instances → Create instance**.
2. Fill in the form:
   - **Name:** `ordexago`
   - **Image:** *Canonical Ubuntu 24.04* (or 22.04)
   - **Shape:** *Ampere → VM.Standard.A1.Flex* with **4 OCPU, 24 GB** (all Always Free)
   - **Networking:** create a new VCN with a public subnet, and **assign a public IPv4 address**
   - **SSH keys:** *Generate a key pair for me* → **download the private key**. You need it to log in, and later for automatic deploys.
3. Click **Create**. Note the **Public IP address**.
   - If it says *Out of host capacity*: try another Availability Domain, retry later, or upgrade to Pay As You Go (step 1.3).
4. Open the website ports: on the instance page click the **Subnet** → **Security List** → **Add Ingress Rules**:
   - Source `0.0.0.0/0`, TCP, destination port **80**
   - Source `0.0.0.0/0`, TCP, destination port **443**
5. Let the server reach the database: Autonomous Database → **Network → Access control list → Edit**. Add the server's **public IP**.

## 5. 👤 Run the setup script on the server

1. Log in to the server. Either click **Cloud Shell** (top right, `>_`), upload the private key and run:
   `ssh -i ssh-key.key ubuntu@SERVER_IP`
   or use the same command from your computer's terminal.
2. On the server, run:
   ```bash
   curl -fsSLO https://raw.githubusercontent.com/azeemshamsi/ZOHO_CLONE/main/deploy/oracle/setup.sh && bash setup.sh
   ```
   If the repo is private, that download fails. In that case, open `deploy/oracle/setup.sh` on GitHub, copy it into a file `setup.sh` on the server (`nano setup.sh`, paste, Ctrl+O, Ctrl+X), then run `bash setup.sh`.

The script:

1. Installs Node.js, nginx and certbot, and opens ports 80/443 on the server's firewall.
2. Shows a **deploy key**. Add it on GitHub (*ZOHO_CLONE → Settings → Deploy keys → Add*), then press Enter.
3. Asks for your **domain** and the **connection string** from step 3. The connection string is typed hidden and saved only on the server.
4. Runs the **database check** (`npm run dbcheck`). Every line should say **PASS**. If anything fails, send Claude the output before going live.
5. Builds and starts OrdexaGo as a service that restarts itself.
6. Sets up nginx and asks you to point DNS to the server, then gets the free HTTPS certificate.

## 6. 👤 Point the domain to Oracle

At your domain registrar, edit the DNS for **ordexago.com**:

- `A` record `@` → server public IP
- `A` record `www` → server public IP

Remove the old Render records (CNAME/A). Then press Enter in the setup script to get the certificate.

## 7. Automatic deploys from GitHub (like Render)

In GitHub: **ZOHO_CLONE → Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Value |
|---|---|
| `ORACLE_HOST` | server public IP |
| `ORACLE_USER` | `ubuntu` |
| `ORACLE_SSH_KEY` | the whole private key file from step 4 (`-----BEGIN … END-----`) |

From then on, every push to `main` runs `.github/workflows/deploy-oracle.yml`. That logs in to the server and runs `deploy/oracle/update.sh`, which pulls, builds and restarts the app.

## 8. Other settings to bring over

- **Environment variables:** copy any you set on Render (e.g. `BREVO_API_KEY`, `MAIL_FROM`, `GEMINI_API_KEY`) into `/opt/ordexago/backend/.env` on the server. Then run `sudo systemctl restart ordexago`.
- **Brevo:** add the Oracle server's IP in Brevo → *Security → Authorised IPs*, or turn IP blocking off. Otherwise emails are refused.
- **Starting fresh:** it's a new, empty database, so sign up again on the site. Then re-enter Shopify, couriers and email in Settings.
- **Shutting down Render and Atlas:** once everything works, suspend the Render service and delete the Atlas cluster.

## Looking after it

- **Logs:** `sudo journalctl -u ordexago -f`
- **Restart:** `sudo systemctl restart ordexago`
- **Manual update:** `bash /opt/ordexago/deploy/oracle/update.sh --force`
- **Backups:** Autonomous Database backs itself up automatically (Database → Backups).
- **Inactivity:** Always Free databases are stopped after a long period without use. OrdexaGo's background jobs (hourly recurring documents, Shopify sync every 15 minutes) keep it active. If it ever shows *Stopped*, click **Start** on the database page.
- **Connections:** the Always Free database allows about 30 sessions. OrdexaGo uses at most 10 (`DB_POOL_SIZE`).
