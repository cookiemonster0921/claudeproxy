# Setting Up the Discord Launcher on Google Compute Engine

This guide walks you through creating a Google Compute Engine (GCE) virtual machine that runs the Discord session launcher daemon. Once set up, typing `/computeengine` in Discord will launch a Claude Code session on this VM.

## What you'll end up with

- A permanent e2-micro VM on Google Cloud running 24/7
- A `claude-launcher` background service that listens for `/computeengine` Discord commands
- Claude sessions running as detached tmux panes on the VM — no terminal window needed on your laptop

## Cost

GCE has an **Always Free** tier that covers exactly this use case:

| Resource | Free allowance |
|---|---|
| 1 × e2-micro VM | Free in `us-central1`, `us-west1`, or `us-east1` |
| 30 GB standard persistent disk | Free |
| 1 GB network egress/month | Free (to Americas/Europe) |

**You need a GCP account with billing enabled.** Google requires a credit card to activate your account, but the e2-micro VM will not be charged as long as you stay in a free-tier region. You can set a billing budget alert at $0 to get an email if anything unexpected happens.

> ⚠️ **RAM limitation:** The e2-micro has 1 GB of RAM total. After the OS (~350 MB) and a 2 GB swap file, you have ~650 MB for Claude sessions. This is enough for one session at a time. If you need multiple concurrent sessions, use the Oracle Cloud setup instead (24 GB RAM, still free).

---

## Prerequisites

Work through this checklist before running any scripts. Each item links to the official install page.

### 1. Google Cloud account

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and sign in with a Google account.
2. Create a new project (top-left dropdown → **New Project**). Name it anything, e.g. `claude-discord`.
3. Enable billing on the project: **Billing** → link to a billing account (credit card required; won't be charged for free-tier usage).

Note your **Project ID** — it looks like `claude-discord-123456` and appears under the project name in the top bar.

### 2. gcloud CLI

The `gcloud` command-line tool lets the setup script create the VM on your behalf.

```bash
# macOS (Homebrew)
brew install --cask google-cloud-sdk

# Linux / WSL
curl https://sdk.cloud.google.com | bash
exec -l $SHELL
```

Or follow the [official installer](https://cloud.google.com/sdk/docs/install).

Verify it installed:
```bash
gcloud --version
# Should print: Google Cloud SDK X.Y.Z
```

### 3. Authenticate gcloud

```bash
gcloud auth login
# Opens a browser — log in with your Google account

gcloud auth application-default login
# Required for some API calls — log in again in the browser

gcloud config set project YOUR_PROJECT_ID
# Replace YOUR_PROJECT_ID with the project ID from step 1
```

### 4. SSH key

The script connects to the VM over SSH. If you don't have a key yet:

```bash
ssh-keygen -t ed25519 -C "gce-claude"
# Press Enter three times to accept defaults and skip a passphrase
```

This creates `~/.ssh/id_ed25519` (private key) and `~/.ssh/id_ed25519.pub` (public key). The script uses the public key automatically.

### 5. Repo `.dev.vars` file

The launcher daemon needs to know where your Cloudflare Worker is. Open `.dev.vars` in the repo root and make sure these two lines exist:

```
WORKER_URL=https://claude-proxy.YOUR-ACCOUNT.workers.dev
PROXY_TOKEN=your-secret-token
```

If you're not sure what these are, ask whoever set up the Cloudflare Worker.

---

## Step 1 — Create the VM

Run this from the repo root:

```bash
./scripts/gce/provision-vm.sh
```

This script will:
1. Enable the Compute Engine API on your project (one-time)
2. Add your SSH public key to the project so you can log in
3. Create a firewall rule allowing SSH (port 22)
4. Create an `e2-micro` VM in `us-central1-a` with Ubuntu 22.04
5. Wait for the VM to boot
6. Install Node.js 20, Claude Code, Python, tmux, and a 2 GB swap file
7. Save the VM's IP address to `scripts/gce/.state/claude-discord-vm.env`

**Expected output (truncated):**
```
[gce] Enabling Compute Engine API...
[gce] Adding SSH public key to project metadata...
[gce] Creating firewall rule 'allow-ssh'...
[gce] Launching instance (e2-micro) in us-central1-a...
[gce] Public IP: 34.X.X.X
[gce] Waiting for SSH on 34.X.X.X...
[gce] SSH ready.
[gce] Installing prerequisites on VM...
  VM ready.
  IP : 34.X.X.X
```

**This takes about 3–4 minutes.** Most of the time is spent waiting for the VM to boot and installing packages.

> **If you see "already exists":** The VM was already created. Run `./scripts/gce/provision-vm.sh --status` to check it.

> **Want a different zone?** Add `--zone us-west1-b` or `--zone us-east1-b` to the command. All three are free-tier eligible.

---

## Step 2 — Install the launcher daemon

```bash
./scripts/gce/setup-launcher.sh
```

This script will:
1. Copy the repo to the VM (excluding secrets, `node_modules`, `.git`)
2. Write a `.dev.vars` file on the VM with `LAUNCHER_TARGET=computeengine`
3. Create and start a `systemd` service called `claude-launcher` that runs automatically on boot

**Expected output:**
```
[gce] Syncing repo to ubuntu@34.X.X.X:~/claude-proxy/ ...
[gce] Sync complete.
[gce] Writing .dev.vars on VM...
[gce] .dev.vars written on VM.
[gce] Installing claude-launcher systemd service...
[gce] claude-launcher service installed.
  ✅ Launcher daemon is running.

  Setup complete.
  The daemon will now receive /computeengine launch frames from Discord.
```

---

## Step 3 — Authenticate Claude Code (one-time)

Claude Code needs to be logged in before it can run sessions. SSH into the VM and log in:

```bash
# Open an SSH session on the VM
./scripts/gce/provision-vm.sh --connect

# Now you're inside the VM — run:
cd ~/claude-proxy
claude

# Log in with your Anthropic account in the browser that opens.
# Once done, press Ctrl+C to exit Claude.
exit
```

The credentials are saved to `~/.claude/` on the VM and will be reused by all future sessions.

---

## Step 4 — Verify everything is running

Check the daemon is connected:

```bash
./scripts/gce/setup-launcher.sh --status
```

You should see:
```
● claude-launcher.service - Claude Code Discord Session Launcher (computeengine)
     Loaded: loaded (/etc/systemd/system/claude-launcher.service; enabled)
     Active: active (running) since ...
```

Watch the live logs to confirm the WebSocket connection:

```bash
./scripts/gce/setup-launcher.sh --logs
```

You should see a line like:
```
Connected. Waiting for launch commands …
```

Press `Ctrl+C` to stop watching logs (the daemon keeps running).

---

## Day-to-day management

```bash
# SSH into the VM
./scripts/gce/provision-vm.sh --connect

# Check VM state
./scripts/gce/provision-vm.sh --status

# Watch daemon logs live
./scripts/gce/setup-launcher.sh --logs

# Check daemon status
./scripts/gce/setup-launcher.sh --status

# Push local code changes to the VM
./scripts/gce/setup-launcher.sh --update

# On the VM — list running Claude sessions
tmux ls

# On the VM — attach to a session to see what Claude is doing
tmux attach -t cproxy_<session-id>

# On the VM — check a session's log file
tail -f ~/.claude/discord-sessions/logs/<session-id>.log

# Destroy the VM (permanent — deletes all data)
./scripts/gce/provision-vm.sh --delete
```

---

## Troubleshooting

### "WORKER_URL not set in .dev.vars"
Open `.dev.vars` in the repo root and add:
```
WORKER_URL=https://claude-proxy.YOUR-ACCOUNT.workers.dev
```

### "Could not get public IP"
The VM may not have an external IP. Check in the GCP console: **Compute Engine → VM Instances → your VM → Network interfaces → External IP**. If it's blank, delete and recreate with `--delete` then `provision-vm.sh`.

### "SSH did not become available within 5 minutes"
The VM is still booting or the firewall isn't open. Check: **VPC Network → Firewall → allow-ssh** exists and allows TCP:22. Try `--connect` again after a minute.

### Daemon shows "active (running)" but Discord commands don't work
The daemon connects to the LauncherDO WebSocket. Check the logs:
```bash
./scripts/gce/setup-launcher.sh --logs
```
Look for `Connected. Waiting for launch commands…`. If you see reconnection errors, the `LAUNCHER_WS_URL` in `.dev.vars` on the VM may be wrong. Re-run `./scripts/gce/setup-launcher.sh` to overwrite it.

### Sessions die after Claude logs in
This is usually a RAM issue on e2-micro. Check memory:
```bash
./scripts/gce/provision-vm.sh --connect
free -h
```
If available RAM is near zero, the OOM killer is terminating Claude. The 2 GB swap helps but is slow. Consider the Oracle Cloud setup for a more capable free VM.
