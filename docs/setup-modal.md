# Setting Up the Discord Launcher on Modal

This guide walks you through deploying the Discord session launcher daemon to Modal. Once set up, typing `/modal` in Discord will launch a Claude Code session inside a Modal container.

## What you'll end up with

- A deployed Modal app called `claude-discord-launcher` running 24/7
- One container always kept warm (`min_containers=1`) connected to Discord
- Claude sessions running as detached tmux panes inside the container
- An HTTP health endpoint at `<your-modal-url>/` you can check anytime

## How Modal works (important to understand)

Modal is a **serverless** platform — it doesn't give you a traditional VM. Instead:

- Your code runs inside **containers** that Modal manages
- Containers **normally scale to zero** when idle (no requests = no cost)
- Setting `min_containers=1` prevents scale-to-zero: one container always stays alive
- `@modal.web_server` turns the function into a persistent HTTP endpoint, which keeps the container running
- The WebSocket daemon runs in a **background thread** inside that container
- Containers have a **24-hour maximum lifetime** — Modal recycles them after 24 hours. The launcher's built-in reconnect logic handles this automatically; in-progress Claude sessions will end when the container is recycled

> ✅ **When Modal is a good choice:** You want zero infrastructure to manage. No SSH, no VM admin, no OS updates. Just `modal deploy` and it runs.
>
> ⚠️ **Limitation:** All sessions share one container. When Modal recycles the container (every ~24h), active sessions end. For uninterrupted long-running sessions, use the Oracle Cloud setup instead.

## Cost

Modal's free tier includes approximately:
- **$30 of compute credits per month** (enough to run one small container 24/7)
- CPU-based containers are very cheap — a container idling at the Modal health endpoint costs a few cents per day

A persistently-running `cpu` container (0.1 vCPU while idle) costs roughly **$5–10/month** — within the free credit allowance for most usage.

---

## Prerequisites

### 1. Modal account

Go to [modal.com](https://modal.com) and sign up with GitHub or Google. No credit card required to start.

### 2. Python 3.8+

Modal's CLI is a Python package. Check your Python version:

```bash
python3 --version
# Should print Python 3.8 or newer
```

If not installed:
```bash
# macOS
brew install python3

# Ubuntu/Debian
sudo apt-get install python3 python3-pip
```

### 3. Modal CLI

```bash
pip install modal
```

Verify:
```bash
modal --version
# Should print a version number
```

### 4. Authenticate Modal

```bash
modal token new
# Opens a browser — log in with your Modal account
```

This saves your credentials to `~/.modal.toml`.

### 5. Repo `.dev.vars` file

Open `.dev.vars` in the repo root and confirm these two lines exist:

```
WORKER_URL=https://claude-proxy.YOUR-ACCOUNT.workers.dev
PROXY_TOKEN=your-secret-token
```

The setup script reads these automatically — you don't need to copy them anywhere.

---

## Step 1 — Deploy the launcher

Run this from the repo root:

```bash
./scripts/modal/setup.sh
```

This script will:
1. Read `WORKER_URL` and `PROXY_TOKEN` from your `.dev.vars`
2. Create a Modal secret called `claude-launcher-secrets` containing all the environment variables the daemon needs
3. Build a Docker image containing Python, Node.js 20, Claude Code, and tmux
4. Deploy the `claude-discord-launcher` app to Modal with `min_containers=1`

**Expected output:**
```
  Setting up Modal secret: claude-launcher-secrets

  Deploying claude-discord-launcher to Modal
  App file: scripts/modal/modal_launcher.py
  Secret  : claude-launcher-secrets

WARNING: First deploy builds the Docker image — this takes 3–5 minutes.
WARNING: Subsequent deploys reuse the cached image and take ~30 seconds.

✓ Created objects.
✓ App deployed!

  Deployed! The launcher daemon is now running on Modal.
```

> **First deploy:** Building the Docker image (Node.js + Claude Code) takes 3–5 minutes. Subsequent deploys are ~30 seconds because Modal caches the image.

> **Redeploying after code changes:** Run `./scripts/modal/setup.sh --update` — same command.

---

## Step 2 — Authenticate Claude Code (one-time)

Claude Code needs to be logged in before it can run sessions. You do this by opening a shell inside the running container.

```bash
modal shell scripts/modal/modal_launcher.py::launcher
```

This drops you into an interactive shell inside the container. Then:

```bash
# Inside the Modal container shell:
claude
# Log in with your Anthropic account in the browser that opens.
# Once done, press Ctrl+C.
exit
```

> ⚠️ **Important:** Modal containers are recycled every ~24 hours. When that happens, the Claude credentials inside the container are lost and you'll need to re-authenticate.
>
> **For persistent auth**, store your credentials as a Modal secret (see Troubleshooting below).

---

## Step 3 — Verify the deployment

Check that the app is running and the daemon is connected:

```bash
./scripts/modal/setup.sh --status
```

You should see `claude-discord-launcher` in the app list with a `deployed` status.

Watch the live logs to confirm the WebSocket connection:

```bash
./scripts/modal/setup.sh --logs
```

Look for:
```
target      : modal  (LAUNCHER_TARGET)
Connected. Waiting for launch commands …
```

Press `Ctrl+C` to stop watching.

You can also visit the health endpoint in a browser. The URL looks like:
```
https://YOUR-ACCOUNT--claude-discord-launcher-launcher.modal.run/
```
It should return:
```json
{"status": "running", "target": "modal", "ws_daemon": "alive", "uptime_seconds": 42}
```

---

## Day-to-day management

```bash
# Watch live logs
./scripts/modal/setup.sh --logs

# Check app + container status
./scripts/modal/setup.sh --status

# Redeploy after code changes
./scripts/modal/setup.sh --update

# Stop the app (saves cost; /modal commands won't work until redeployed)
./scripts/modal/setup.sh --stop

# Redeploy after stopping
./scripts/modal/setup.sh
```

---

## Troubleshooting

### "modal: command not found"
The Modal CLI wasn't added to your PATH. Try:
```bash
pip install modal
python3 -m modal --version
```
If that works, add the pip bin directory to your PATH:
```bash
export PATH="$PATH:$(python3 -m site --user-base)/bin"
```

### "Secret not found" during deploy
The `./scripts/modal/setup.sh` script creates the secret automatically. If it fails, create it manually:
```bash
# Read values from your .dev.vars first
WORKER_URL=$(grep WORKER_URL .dev.vars | cut -d= -f2)
PROXY_TOKEN=$(grep PROXY_TOKEN .dev.vars | cut -d= -f2)
WS_URL="${WORKER_URL/https:\/\//wss:\/\/}/launcher-ws"

modal secret create claude-launcher-secrets \
    LAUNCHER_WS_URL="$WS_URL" \
    PROXY_TOKEN="$PROXY_TOKEN" \
    LAUNCHER_TARGET=modal \
    LAUNCHER_BACKGROUND=1 \
    CPROXY_SCRIPT=/app/claude-proxy.sh
```

### Claude credentials expire every 24 hours

Modal recycles containers after 24 hours. To avoid re-authenticating daily, store your Claude credentials as a Modal secret:

```bash
# First, log in to Claude locally to get the credentials file:
claude

# Then encode and store it:
CREDS=$(cat ~/.claude/.credentials.json | base64)
modal secret create claude-auth CLAUDE_CREDENTIALS_B64="$CREDS"
```

Then edit `scripts/modal/modal_launcher.py` to add `modal.Secret.from_name("claude-auth")` to the `_secrets` list and decode the credentials at container start.

### The health endpoint returns `"ws_daemon": "dead"`
The WebSocket background thread crashed. Check the logs:
```bash
./scripts/modal/setup.sh --logs
```
Then redeploy to restart:
```bash
./scripts/modal/setup.sh --update
```

### "No daemons connected" when using /modal in Discord
The container may have scaled down (shouldn't happen with `min_containers=1`) or is still warming up after a deploy. Wait 30 seconds and try again. Check `--status` to confirm the app is deployed.
