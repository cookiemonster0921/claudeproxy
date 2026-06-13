# Setting Up the Discord Launcher on Northflank

This guide walks you through deploying the Discord session launcher daemon to Northflank as a persistent container service. Once set up, typing `/northflank` in Discord will launch a Claude Code session inside the container.

## What you'll end up with

- A deployment service on Northflank running 24/7 with automatic restarts
- The launcher daemon listening for `/northflank` Discord commands
- Claude sessions running as detached tmux panes inside the container
- A Docker image hosted on Docker Hub that Northflank pulls and runs

## How Northflank works

Northflank is a **container platform** — you give it a Docker image and it runs it as a persistent service. Unlike Modal (which is serverless), Northflank services run continuously with `restart: always`. There's no 24-hour recycling, no scale-to-zero. The container just runs.

The setup flow is:
1. You build a Docker image locally (contains the launcher daemon + all its deps)
2. You push that image to Docker Hub (a public registry)
3. The Northflank CLI creates a project + service that pulls and runs the image
4. Northflank keeps the container running forever, restarting it if it crashes

> ✅ **When Northflank is a good choice:** You want a genuinely persistent service (no 24h recycling), managed container platform, and a simple web dashboard to monitor things.
>
> ⚠️ **Free tier limit:** The free tier allows 2 services and 1 vCPU / 1 GB RAM total. This is enough for the launcher daemon. Claude sessions run as tmux panes inside the same container, so they share this RAM.

## Cost

Northflank free tier:

| Resource | Free allowance |
|---|---|
| Services | 2 |
| Compute | 1 vCPU, 1 GB RAM |
| Bandwidth | 10 GB/month |

**No credit card required** for the free tier.

---

## Prerequisites

### 1. Northflank account

Go to [northflank.com](https://northflank.com) and click **Sign up**. Use GitHub, Google, or email.

After signing up, you need an **API token**:
1. Go to your account settings: top-right avatar → **Account settings**
2. Click **API tokens** → **Create API token**
3. Give it a name (e.g. "cli-setup") and click **Create**
4. Copy the token — you'll only see it once

### 2. Docker Hub account

The setup script builds a Docker image locally and pushes it to Docker Hub. Northflank then pulls it from there.

1. Sign up at [hub.docker.com](https://hub.docker.com) (free)
2. Note your Docker Hub **username** (lowercase) — you'll use it as part of the image name

### 3. Docker Desktop (or Docker Engine)

You need Docker installed locally to build and push the image.

```bash
# macOS — install Docker Desktop from:
# https://www.docker.com/products/docker-desktop/

# Ubuntu/Debian
sudo apt-get install docker.io
sudo usermod -aG docker $USER
newgrp docker
```

Verify Docker is running:
```bash
docker --version
# Docker version 24.X.X
docker ps
# Should print an empty table, not an error
```

Log in to Docker Hub:
```bash
docker login
# Enter your Docker Hub username and password
```

### 4. Node.js and the Northflank CLI

```bash
# If Node.js isn't installed:
# macOS
brew install node

# Ubuntu/Debian
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install the Northflank CLI
npm install -g @northflank/cli
```

Verify:
```bash
northflank --version
```

Authenticate:
```bash
northflank login
# Opens a browser — enter your API token when prompted
```

### 5. Repo `.dev.vars` file

Open `.dev.vars` in the repo root and confirm these two lines exist:

```
WORKER_URL=https://claude-proxy.YOUR-ACCOUNT.workers.dev
PROXY_TOKEN=your-secret-token
```

---

## Step 1 — Deploy to Northflank

Pick an image name in the format `YOUR_DOCKERHUB_USERNAME/claude-launcher` (all lowercase). Then run:

```bash
./scripts/northflank/setup.sh --image YOUR_DOCKERHUB_USERNAME/claude-launcher
```

Replace `YOUR_DOCKERHUB_USERNAME` with your actual Docker Hub username.

**What this does:**
1. Builds the Docker image locally (Python + Node.js + Claude Code + tmux) — takes 3–5 minutes on first run
2. Pushes the image to Docker Hub as `YOUR_DOCKERHUB_USERNAME/claude-launcher:latest`
3. Creates a Northflank project called `claude-discord`
4. Creates a secret group with your `LAUNCHER_WS_URL` and `PROXY_TOKEN`
5. Creates a deployment service that runs `1 instance` of the image

**Expected output:**
```
  Building Docker image: youruser/claude-launcher:latest

[northflank] Pushing youruser/claude-launcher:latest ...
[northflank] Image pushed.
[northflank] Creating Northflank project 'claude-discord'...
[northflank] Project 'claude-discord' created.
[northflank] Creating secret group 'claude-launcher-secrets'...
[northflank] Creating deployment service 'claude-discord-launcher'...

  Northflank deployment complete.
  Service : claude-discord-launcher
  Project : claude-discord
  Image   : youruser/claude-launcher:latest
```

> **If you see "Service may already exist":** The service was already created from a previous run. Check the Northflank dashboard to confirm it's running.

> **Docker build fails?** Make sure Docker Desktop is open (the Docker daemon must be running). On macOS, check the whale icon in the menu bar.

---

## Step 2 — Authenticate Claude Code (one-time)

Claude Code must be logged in before it can run sessions. Northflank provides an **Exec** terminal directly in the browser.

1. Go to [app.northflank.com](https://app.northflank.com)
2. Open your **claude-discord** project
3. Click on the **claude-discord-launcher** service
4. Click the **Exec** tab (or "Terminal" depending on your plan)
5. In the browser terminal, run:

```bash
claude
# Log in with your Anthropic account
# Once done, press Ctrl+C
```

> ⚠️ **Unlike VMs, the container filesystem is ephemeral.** If the container restarts, the Claude credentials are lost. To persist them, add them as a Northflank secret (see Troubleshooting below).

---

## Step 3 — Verify the service is running

Check the status:

```bash
./scripts/northflank/setup.sh --status
```

Watch the live logs:

```bash
./scripts/northflank/setup.sh --logs
```

Look for:
```
target      : northflank  (LAUNCHER_TARGET)
Connected. Waiting for launch commands …
```

You can also check the Northflank dashboard:
1. Go to [app.northflank.com](https://app.northflank.com)
2. Open **claude-discord** project → **claude-discord-launcher** service
3. The status badge should show **Running**

---

## Day-to-day management

```bash
# Watch live logs
./scripts/northflank/setup.sh --logs

# Check service status
./scripts/northflank/setup.sh --status

# Rebuild and push a new image (after code changes)
./scripts/northflank/setup.sh --image youruser/claude-launcher --update

# Delete the entire project (permanent)
./scripts/northflank/setup.sh --delete
```

**Via the Northflank dashboard** (at [app.northflank.com](https://app.northflank.com)):
- **Restart** the service: Service → Actions → Restart
- **View logs**: Service → Logs tab
- **Open a terminal**: Service → Exec tab
- **Update secrets**: Project → Secret Groups → claude-launcher-secrets

---

## Troubleshooting

### "northflank: command not found"
```bash
npm install -g @northflank/cli
# If permission error on macOS/Linux:
sudo npm install -g @northflank/cli
```

### "docker: command not found" or "Cannot connect to Docker daemon"
Docker Desktop is not open. On macOS, launch Docker Desktop from your Applications folder. On Linux, start the service:
```bash
sudo systemctl start docker
```

### "denied: requested access to the resource is denied" when pushing
You're not logged in to Docker Hub:
```bash
docker login
```

### The service shows as "Running" but /northflank in Discord does nothing
The launcher daemon may not have connected to the LauncherDO WebSocket. Check the logs:
```bash
./scripts/northflank/setup.sh --logs
```

If you see connection errors, the `LAUNCHER_WS_URL` or `PROXY_TOKEN` in the secret group may be wrong. Update them in the Northflank dashboard:
1. Project → **Secret Groups** → **claude-launcher-secrets** → Edit
2. Update `LAUNCHER_WS_URL` to `wss://claude-proxy.YOUR-ACCOUNT.workers.dev/launcher-ws`
3. Update `PROXY_TOKEN` to match your `.dev.vars`
4. Save, then restart the service

### Claude credentials lost after container restart

Container filesystems are ephemeral. To persist Claude credentials as a Northflank secret:

**Step 1** — Log in locally and encode your credentials:
```bash
claude    # log in on your local machine
CREDS=$(cat ~/.claude/.credentials.json | base64)
echo "CLAUDE_CREDENTIALS_B64=$CREDS"
```

**Step 2** — Add to the Northflank secret group:
1. Dashboard → **claude-discord** project → **Secret Groups** → **claude-launcher-secrets**
2. Add a new variable: key `CLAUDE_CREDENTIALS_B64`, value = the base64 string from above
3. Save

**Step 3** — Decode at container startup. Edit `scripts/northflank/Dockerfile.launcher` to add an entrypoint script that decodes the variable into `~/.claude/.credentials.json` before starting the daemon.

### Build fails with "COPY failed: file not found"
Run the build from the repo root (not from inside `scripts/northflank/`):
```bash
cd /path/to/claude-proxy   # repo root
./scripts/northflank/setup.sh --image youruser/claude-launcher
```

### "nf-compute-10 plan not found" or billing error
The compute plan name may vary. Open the Northflank dashboard, create a service manually to see available plan names, then edit `scripts/northflank/service-spec.json` and replace `"nf-compute-10"` with the correct plan.
