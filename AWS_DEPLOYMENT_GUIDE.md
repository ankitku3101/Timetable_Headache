# AWS Deployment Guide — Azure to AWS Migration

This document is a full record of migrating the backend + worker from Azure to AWS: every step taken, every command run, every mistake made along the way, and how each issue was debugged. Written so the same process can be repeated for other projects without re-learning the same lessons.

---

## 1. Why AWS over Azure, and the architecture chosen

The original setup deployed the Node backend directly (zip, no Docker) to an Azure Web App via GitHub Actions, and the Python CP-SAT worker had a Dockerfile but no clear CI deployment path.

Decision: move to AWS, and since the AWS account is on the **free tier**, avoid services with no free tier or hidden costs:

| Service | Verdict | Why |
|---|---|---|
| ECS Fargate | Avoided | No free tier — billed per vCPU/memory-second from day one |
| Application Load Balancer | Avoided | Only 750 free hours/month for 12 months, adds complexity for a single-app setup |
| NAT Gateway | Avoided | **Never** free, charged hourly + per-GB from hour one |
| ElastiCache (Redis) | Avoided | Minimal free tier; run Redis as a container instead |
| **EC2 (t2.micro/t3.micro)** | **Used** | 750 free hours/month for 12 months — enough for one instance running 24/7 |

**Final architecture**: a single EC2 instance running a Docker Compose stack:
- `redis` — internal job queue (container, not ElastiCache)
- `backend` — Express API
- `worker` — Python CP-SAT solver
- `caddy` — reverse proxy that auto-provisions free HTTPS certificates (Let's Encrypt) and can route multiple projects by hostname on the same box

MongoDB stayed on Atlas (external, no migration needed regardless of compute provider).

This also generalizes to hosting **multiple unrelated projects** on the same EC2 instance later — each new project is just another Docker Compose service plus another block in the `Caddyfile`, routed by a different subdomain.

---

## 2. AWS account setup

### 2.1 Claim the $100 AWS credit (optional but free money)

AWS's "Explore AWS" panel offers $100 in credits for 5 activities. Order that overlaps naturally with the migration:

1. **Set up a cost budget (AWS Budgets)** — do this first regardless, it's a safety net.
2. **Launch an instance using EC2** — this doubles as the actual migration step below.
3. **Use a foundation model in Amazon Bedrock** — unrelated, but a 5-minute console task.
4. **Create a web app using Lambda** — unrelated, use AWS's guided flow, stays within Lambda's permanent free tier.
5. **Create an Aurora or RDS database** — not needed for this project (MongoDB Atlas is used instead); spin up the smallest free-tier instance just to satisfy the activity, then delete it afterward if unused, since stopped-but-not-deleted RDS instances still incur storage charges.

### 2.2 Set a budget alert

1. AWS Console → search **"Budgets"** → **AWS Budgets**.
2. **Create budget** → **Use a template** → **Zero spend budget**.
3. Enter an email for alerts → **Create budget**.

This is what catches a runaway cost mistake before it becomes a bill.

---

## 3. Launching the EC2 instance

### 3.1 Console steps

1. EC2 service → **Launch instance**.
2. **Name**: `timetable-server` (or similar).
3. **AMI**: **Ubuntu Server 22.04 LTS** — not Amazon Linux (see mistake #1 below).
4. **Instance type**: whichever is marked **"Free tier eligible"** — `t2.micro` or `t3.micro` depending on region.
5. **Key pair**: **Create new key pair** → name it, type RSA, format `.pem` → download it. This file cannot be re-downloaded later; it's the only way to SSH in.
6. **Network settings** → **Edit**, three inbound rules:
   - SSH (port 22) — Source: **My IP** (not "Anywhere")
   - HTTP (port 80) — Source: **Anywhere** (0.0.0.0/0)
   - HTTPS (port 443) — Source: **Anywhere** (0.0.0.0/0)
7. Leave storage at the default 8 GB (well within the 30 GB free allowance).
8. **Launch instance**.

### Mistake #1 — Launched with Amazon Linux instead of Ubuntu

The default SSH username differs by AMI: Amazon Linux uses `ec2-user`, Ubuntu uses `ubuntu`. Since Ubuntu was specifically wanted, the fix was to **terminate the instance and relaunch** with the correct AMI (nothing had been configured on it yet, so nothing was lost) — you cannot change a running instance's AMI after the fact.

```bash
# EC2 Console → Instances → select instance → Instance state → Terminate instance
# Then Launch instance again, this time selecting "Ubuntu Server 22.04 LTS"
```

### Mistake #2 — Pasted a full URL instead of a bare IP into `ssh`

```
ssh -i "...\your-key-file.pem" ubuntu@https://<instance-public-ip>/     # wrong — this is a URL, not a hostname
ssh -i "...\your-key-file.pem" ubuntu@<instance-public-ip>               # correct
```

`ssh` expects a bare hostname or IP after `user@`, not a browser-style URL with a scheme and trailing slash.

### Mistake #3 — `Permission denied (publickey)` after fixing the AMI

This turned out to be the AMI/username mismatch again (Amazon Linux vs Ubuntu), not a key problem — the fix was #1 above. In general, if this error shows up:
- Confirm the SSH username matches the AMI (`ubuntu` for Ubuntu, `ec2-user` for Amazon Linux).
- Confirm the **Key pair name** shown on the instance's details page in the console matches the `.pem` file being used.
- Open the `.pem` file in a text editor and confirm it starts with `-----BEGIN ... PRIVATE KEY-----` and ends with a matching `-----END...-----` line (checks for a corrupted download).

### Mistake #4 — `port 22: Connection timed out`

Cause: the security group's SSH rule was locked to "My IP" at launch time, but the client's public IP had changed (or didn't match) by the time of connecting.

Fix: EC2 Console → instance → **Security** tab → click the security group → **Edit inbound rules** → on the SSH rule, click the **Source** field's "My IP" option again to re-detect the current IP → **Save rules**.

### 3.2 Securing the downloaded key on Windows

Windows requires the private key file to not be publicly readable, or `ssh` refuses to use it:

```powershell
$keyPath = "C:\Users\<you>\aws\your-key-file.pem"
icacls $keyPath /inheritance:r
icacls $keyPath /grant:r "$($env:USERNAME):(R)"
```
- `icacls ... /inheritance:r` — strips inherited permissions from the file so it isn't broadly readable.
- `icacls ... /grant:r "$env:USERNAME:(R)"` — grants only the current Windows user read access, replacing any prior grants.

### 3.3 Connecting

```
ssh -i "C:\Users\<you>\aws\your-key-file.pem" ubuntu@<instance-public-ip>
```
First connection prompts to confirm the host's fingerprint — type `yes`. This is AWS's server presenting its identity for the first time; expected and safe to accept.

---

## 4. Installing Docker on the instance

Run on the EC2 instance (inside the SSH session):

```bash
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker $USER
```
- `curl -fsSL ... -o get-docker.sh` — downloads Docker's official install script (`-f` fail silently on HTTP errors, `-s` silent, `-S` show errors, `-L` follow redirects).
- `sudo sh get-docker.sh` — runs the installer.
- `sudo usermod -aG docker $USER` — adds the current user to the `docker` group so `docker` commands don't need `sudo`. **Requires closing and reopening the SSH session** to take effect (group membership is only re-evaluated at login).

Verify after reconnecting:
```bash
docker --version
docker compose version
```

---

## 5. Application files added to the repo

### 5.1 `backend/Dockerfile`

```dockerfile
FROM node:22-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY src/ ./src/

EXPOSE 8080

CMD ["node", "src/server.js"]
```
The backend previously had no Dockerfile at all — Azure deployed it as a raw zip via `azure/webapps-deploy`. This was written from scratch based on `backend/package.json`'s `start` script (`node src/server.js`) and the configured port (8080).

### 5.2 `docker-compose.yml` (repo root)

```yaml
services:
  redis:
    image: redis:7-alpine
    restart: unless-stopped
    volumes:
      - redis-data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 30s
      timeout: 5s
      retries: 3
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"

  backend:
    build: ./backend
    restart: unless-stopped
    env_file:
      - .env
    environment:
      - REDIS_URL=redis://redis:6379
    depends_on:
      - redis
    healthcheck:
      test: ["CMD", "node", "-e", "require('http').get('http://localhost:8080/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"

  worker:
    build: ./workers/python
    restart: unless-stopped
    env_file:
      - .env
    environment:
      - REDIS_URL=redis://redis:6379
    depends_on:
      - redis
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"

  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy-data:/data
      - caddy-config:/config
    depends_on:
      - backend

volumes:
  redis-data:
  caddy-data:
  caddy-config:
```

Key decisions baked into this file:
- `restart: unless-stopped` on every service — Docker restarts a crashed container automatically.
- `REDIS_URL` is **hardcoded** in the `environment:` block (not left to `.env`) so it always points at the internal `redis` container, regardless of whatever stale value might exist in `.env` — this is what makes the old Azure/Upstash Redis URL harmless leftover noise instead of a live bug (see mistake #6).
- `healthcheck` on `redis` and `backend` — Docker only knows a container is actually working, not just alive, if it can probe something like `/health`.
- `logging: max-size/max-file` on every service — without this, container logs grow unbounded and can fill the disk over time.

### 5.3 `Caddyfile` (repo root)

```
timetable.ankit31.me {
    reverse_proxy backend:8080
}
```
Caddy automatically requests and renews a free Let's Encrypt HTTPS certificate for any hostname listed here, as long as DNS for that hostname points at the server. Adding a second project on the same instance later is just adding another block:
```
project2.yourdomain.com {
    reverse_proxy project2:PORT
}
```

### 5.4 `.env.production.example` (repo root)

```
# Copy this file to ".env" on the EC2 instance (NOT in git) and fill in real values.
# docker-compose.yml reads this automatically for both the backend and worker containers.

NODE_ENV=production
PORT=8080

# MongoDB Atlas connection string (same one you use today)
MONGODB_URI=mongodb+srv://<username>:<password>@<cluster>.mongodb.net/timetable_db

# Do NOT set REDIS_URL here — docker-compose.yml sets it automatically to
# redis://redis:6379, pointing at the Redis container in this same stack.

JWT_SECRET=<generate a long random string>
JWT_EXPIRES_IN=7d
GEMINI_API_KEY=<your_gemini_api_key>
```
A template only — the real `.env` with actual secrets is created directly on the server and is git-ignored, never committed.

### 5.5 `.gitignore` (repo root)

The repo had no root-level `.gitignore` before this. Added:
```
.env
node_modules/
```

---

## 6. Getting the code onto the server

```bash
git clone https://github.com/<your-fork>/Timetable_Headache.git
cd Timetable_Headache
```
If the repo is private, `git clone` prompts for a username/password — GitHub no longer accepts account passwords here, a [Personal Access Token](https://github.com/settings/tokens) (classic, `repo` scope) must be pasted in as the password instead.

---

## 7. Creating the real secrets file on the server

```bash
nano .env
```
Paste in real values (MongoDB URI, JWT secret, Gemini key, etc.), then save with `Ctrl+O`, `Enter`, exit with `Ctrl+X`.

### Mistake #5 — Corrupted `.env` from a bad paste in `nano`

**Symptom**: the worker container crash-looped with:
```
pymongo.errors.InvalidURI: MongoDB URI options are key=value pairs.
```

**Debugging steps taken**:
1. `docker compose logs worker --tail=50` — showed the Python traceback pointing at `pymongo.MongoClient(MONGODB_URI)` failing to parse the URI.
2. Suspected a malformed `.env` value. Checked the raw file for hidden characters:
   ```bash
   cat -A .env | grep MONGODB_URI
   ```
   `cat -A` reveals non-printing characters — `$` marks end-of-line, `^I` marks a tab, `^M` marks a stray carriage return (`\r`). The line looked clean at first glance.
3. Since the file *looked* fine but the app still failed, checked what the **container itself** actually received (the real source of truth — more reliable than re-reading the file, since it reveals exactly what Docker parsed and passed in):
   ```bash
   docker inspect timetable_headache-worker-1 --format '{{range .Config.Env}}{{println .}}{{end}}' | grep MONGO
   ```
   This revealed the actual bug: the `MONGODB_URI` value had the **old Azure/Upstash `REDIS_URL` value glued onto the end of it** with no line break in between — e.g. `...appName=Cluster0REDIS_URL=rediss://...`. Two separate `.env` lines had merged into one during a multi-line paste into `nano` over SSH (a common failure mode — terminal paste over SSH can silently drop a newline between pasted lines).

**Fix**: rewrote `.env` from scratch using a heredoc instead of `nano`, since heredocs are immune to this class of paste corruption (each line is explicitly delimited in the command itself, not dependent on terminal paste behavior):
```bash
cat > .env << 'EOF'
NODE_ENV=production
PORT=8080
MONGODB_URI=mongodb+srv://<user>:<pass>@<cluster>.mongodb.net/<db_name>?retryWrites=true&w=majority&appName=Cluster0
JWT_SECRET=<real value>
JWT_EXPIRES_IN=7d
GEMINI_API_KEY=<real value>
EOF
```
The old `REDIS_URL` (Upstash) was deliberately **left out entirely** — `docker-compose.yml` overrides it anyway (§5.2), so including it was pointless and it was the actual source of the corruption.

Verified the fix before restarting anything:
```bash
cat -A .env
```
Every line should end in a clean `$` with no `^M` and no two `KEY=` patterns appearing on the same line.

**Lesson**: prefer `cat > file << 'EOF' ... EOF` (heredoc) over `nano` for pasting multi-line secrets over SSH — it sidesteps terminal paste/newline bugs entirely.

---

## 8. Starting the stack

```bash
docker compose up -d --build
```
- `up -d` — starts all services in the background (detached).
- `--build` — builds the `backend` and `worker` images from their Dockerfiles first. The worker image took longest to build, since it installs `ortools`.

### Checking status

```bash
docker compose ps
```
All four services (`redis`, `backend`, `worker`, `caddy`) should show `Up`, with `redis` and `backend` additionally showing `(healthy)` once their healthchecks pass (~30s after start).

### Restarting after config changes

The rule used throughout:
| What changed | Command |
|---|---|
| Backend or worker source code | `docker compose up -d --build` (rebuild + recreate) |
| `.env` values | `docker compose up -d` (recreate, no rebuild) |
| `Caddyfile` | `docker compose restart caddy` |
| `docker-compose.yml` itself | `docker compose up -d` |

`git pull` on its own never restarts anything — Compose doesn't watch the filesystem.

---

## 9. DNS and HTTPS

### 9.1 What "domain" meant here

The frontend (on Vercel) is served over HTTPS, and browsers block HTTPS pages from calling a plain-HTTP backend ("mixed content"). Getting a free HTTPS certificate via Let's Encrypt (which Caddy automates) requires a real domain — it will not issue a certificate for a bare IP address.

Two free options considered:
1. A magic free hostname like `sslip.io` that maps to the server's IP automatically (`16-170-251-54.sslip.io`) — good for pure testing, but ties the hostname to one specific IP forever.
2. **A domain already owned** (`ankit31.me`, bought on Namecheap) — used instead, since it's not tied to a specific server IP and survives future migrations.

### 9.2 Adding the DNS record (Namecheap)

1. Namecheap → **Domain List** → **Manage** next to the domain → **Advanced DNS** tab.
2. **Add New Record**:
   - Type: `A Record`
   - Host: `timetable` (creates `timetable.ankit31.me`)
   - Value: the EC2 instance's public IP
   - TTL: Automatic
3. Save.

Naming convention adopted for future projects on the same domain/instance: `<project>.ankit31.me` per project — unlimited subdomains can be created on one purchased domain, each just another A record.

### 9.3 Verifying

```bash
curl http://localhost:8080/health              # on the server, bypasses Caddy — confirms the backend itself is up
curl https://timetable.ankit31.me/health        # from any machine — confirms DNS + Caddy + HTTPS all work end-to-end
```
Both should return `{"status":"ok"}`.

---

## 10. Post-migration fixes

### Mistake #6 — Login failing after switching the frontend over

**Symptom**: `Route POST /api/auth/login not found`.

**Debugging**: checked how the backend actually mounts its routes:
```bash
grep -n "app.use" backend/src/app.js
```
which showed every route mounted under `/api/v1/...` (e.g. `/api/v1/auth/login`), not `/api/auth/...`. Then checked how the frontend builds request URLs (`frontend/lib/constants.ts`, `frontend/lib/api.ts`) — the base URL comes from the `NEXT_PUBLIC_API_BASE_URL` environment variable, whose correct default is `http://localhost:8080/api/v1` (includes `v1`).

**Root cause**: the `NEXT_PUBLIC_API_BASE_URL` set in the Vercel project's environment variables was missing the `/v1` segment.

**Fix**: Vercel → project → **Settings** → **Environment Variables** → set:
```
NEXT_PUBLIC_API_BASE_URL=https://timetable.ankit31.me/api/v1
```
then trigger a new deployment (env var changes don't apply retroactively to already-built deployments).

### Documentation corrections made after the fact

- `About.md`, `architecture.md`, `README.md` still referenced the **Anthropic API** for LLM features. Checked actual backend code:
  ```bash
  grep -rl "GEMINI\|ANTHROPIC" backend/src
  ```
  which showed only a real `backend/src/integrations/gemini/` module exists — `ANTHROPIC_API_KEY` was loaded into config (`backend/src/config/env.js`) but never actually used anywhere. Fixed all three docs to say Gemini, and dropped the unused `ANTHROPIC_API_KEY` line from `.env.production.example`.
- Deleted the dead Azure GitHub Actions workflow (`.github/workflows/main_timetable-backend.yml`) that still referenced Azure App Service credentials no longer in use.
- A replacement SSH-based auto-deploy workflow (using `appleboy/ssh-action`) was drafted but ultimately **not kept** for this project, since the EC2 instance clones from a personal fork rather than a repo owned outright — decided to keep deploys manual here and set up auto-deploy only on projects owned end-to-end.

---

## 11. Ongoing operations

### 11.1 Elastic IP

The instance's public IP can change if it's ever stopped/restarted, which would break the DNS record. An **Elastic IP** keeps it stable. Cost: none beyond what's already implicitly used — since Feb 2024, AWS bills ~$0.005/hr for *any* public IPv4 (Elastic or auto-assigned), but new accounts get 750 free public-IPv4 hours/month for 12 months, covering one address used 24/7. The only real cost trap is an Elastic IP left **allocated but unattached** — avoided by attaching it immediately.

### 11.2 Monitoring a shared, memory-constrained instance

`t2.micro`/`t3.micro` has 1 GB RAM. Approach settled on:
- `restart: unless-stopped` + Docker healthchecks on every container (self-healing).
- CloudWatch agent installed on the instance for memory/disk metrics (not reported by EC2 by default) and `CPUCreditBalance` alarms (the real early-warning signal for burstable instances — usually the first bottleneck, before RAM).
- An external uptime check (Route 53 health check or a free tier like UptimeRobot) — the only way to know the instance itself is unreachable, since in-instance monitoring can't report on itself being down.
- Docker log rotation (`max-size`/`max-file`, already in `docker-compose.yml`) to stop logs from silently filling the disk.
- A 2 GB swap file as a buffer against RAM spikes (the CP-SAT solver can spike memory significantly while actively solving).
- Rule of thumb reached: 3–5 genuinely low-traffic Node apps plus this project's worker is a reasonable ceiling for one `t2.micro`/`t3.micro` before splitting onto a second instance.

### 11.3 Non-Dockerized projects on the same instance

For future projects without a Dockerfile yet, two options:
- Add a minimal generic Dockerfile (fits most Node apps unchanged):
  ```dockerfile
  FROM node:22-slim
  WORKDIR /app
  COPY package*.json ./
  RUN npm install --omit=dev
  COPY . .
  EXPOSE 3000
  CMD ["node", "index.js"]
  ```
- Or run it directly on the host with `pm2` (`pm2 start index.js --name myapp`), with Caddy reverse-proxying to `localhost:<port>` exactly as it does for Docker containers. Trade-off: two separate toolsets (`docker compose` vs `pm2`) to operate instead of one unified pattern.
