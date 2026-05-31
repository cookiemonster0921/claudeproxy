# Cloud Deployment Guide

This guide covers every way to run Claude Code through the `claude-proxy` Cloudflare Worker on GCP. Pick the option that matches your use case.

---

## Quick comparison

| Option | Interactive? | Persistent? | Cost | Best for |
|---|---|---|---|---|
| [Docker (local)](#option-0-docker-local) | ✅ Full TTY | ❌ Ephemeral | Free | Daily dev, testing |
| [Cloud Shell](#option-1-cloud-shell) | ✅ Full TTY | ✅ 5 GB home | Free | One-off tasks, no local setup |
| [Compute Engine VM](#option-2-compute-engine-vm) | ✅ Full TTY | ✅ Full disk | ~$15–30/mo | Persistent remote workspace |
| [Cloud Run Job](#option-3-cloud-run-job) | ❌ No TTY | ❌ Ephemeral | Pay-per-use | CI, scheduled automation |
| [Cloud Run Service](#option-4-cloud-run-service) | ❌ No TTY | ❌ Stateless | Pay-per-request | HTTP API, webhooks |

---

## Prerequisites

All options require the Cloudflare Worker to already be deployed. Add its URL to `.dev.vars`:

```bash
echo 'WORKER_URL=https://claude-proxy.YOUR-ACCOUNT.workers.dev' >> .dev.vars
echo 'PROXY_TOKEN=your-secret-token' >> .dev.vars   # omit if no token is configured
```

For GCP options, authenticate once:

```bash
gcloud auth login
gcloud auth application-default login   # needed for identity tokens
```

---

## Option 0: Docker (local)

**Use when:** you want an interactive Claude session on your own machine routed through the proxy.

```bash
# Build
docker build -f docker/Dockerfile.claude -t claude-interactive .

# Run
docker run -it --rm \
  -e WORKER_URL="https://claude-proxy.YOUR-ACCOUNT.workers.dev" \
  -e PROXY_TOKEN="your-token" \
  -v "$(pwd)":/workspace \
  claude-interactive
```

The container starts Claude Code directly. Pass extra flags after the image name:

```bash
docker run -it --rm -e WORKER_URL=... claude-interactive --model claude-opus-4-7
```

**Stopping:** press `Ctrl-C` or type `/exit` inside Claude. The container is removed automatically (`--rm`).

---

## Option 1: Cloud Shell

**Use when:** you want an interactive session without installing anything locally. Cloud Shell gives you a free, browser-accessible Debian VM with a persistent 5 GB home directory.

### Launch

```bash
./scripts/launch-cloud-shell.sh
```

The script:
1. Reads `WORKER_URL` and `PROXY_TOKEN` from `.dev.vars`
2. SSH-es into your Cloud Shell
3. Installs Claude Code on first run (persisted — subsequent launches are instant)
4. Sets the proxy environment variables
5. Drops you straight into `claude`

### Options

```bash
# Override credentials inline
./scripts/launch-cloud-shell.sh \
  --worker-url https://claude-proxy.YOUR-ACCOUNT.workers.dev \
  --proxy-token your-token
```

### Notes

- **Cold start:** Cloud Shell powers off after inactivity. The first connection takes 30–60 seconds.
- **Persistence:** Claude Code is installed in `~/.local/bin` inside Cloud Shell's 5 GB persistent home — it survives reboots.
- **Reconnecting:** just run the script again. It detects an existing Claude Code install and skips reinstallation.
- **No extra cost:** Cloud Shell is free for personal GCP accounts.
- **Inactivity timeout:** Cloud Shell disconnects after ~20 minutes of no input. Use `/no-timeout` inside Claude or keep a background process running.

---

## Option 2: Compute Engine VM

**Use when:** you want a persistent, always-available remote workspace you can SSH into from any machine.

### Provision and connect (first time)

```bash
./scripts/provision-vm.sh --project YOUR_PROJECT_ID
```

The script:
1. Creates an `e2-small` Debian 12 VM in `us-central1-a`
2. Waits for SSH to become available
3. Installs `curl`, `git`, and Claude Code
4. Writes proxy env vars to `~/.claude-proxy-env` on the VM
5. Drops you into `claude` via SSH

### Reconnect

```bash
# Via the script (also refreshes proxy config)
./scripts/provision-vm.sh --connect

# Or raw gcloud SSH (manually source env)
gcloud compute ssh claude-vm --zone=us-central1-a \
  -- -t "bash --login -c 'source ~/.claude-proxy-env && exec claude'"

# Or plain SSH without Claude (for file work, debugging)
gcloud compute ssh claude-vm --zone=us-central1-a
```

### Delete the VM

```bash
./scripts/provision-vm.sh --delete
```

You will be prompted to type the VM name to confirm — the VM and its disk are permanently destroyed.

### Options

```bash
./scripts/provision-vm.sh \
  --project   my-project-id \
  --zone      europe-west1-b \       # any Compute Engine zone
  --vm-name   my-claude-vm \
  --machine-type e2-medium \         # bigger machine for faster responses
  --worker-url https://... \
  --proxy-token my-token
```

### Cost

| Machine | vCPU | RAM | Cost/month (approx) |
|---|---|---|---|
| `e2-micro` | 0.25 | 1 GB | Free (1 per account, us regions) |
| `e2-small` | 0.5 | 2 GB | ~$15 |
| `e2-medium` | 1 | 4 GB | ~$30 |

**Tip:** stop the VM when not in use to avoid compute charges (disk still billed):

```bash
gcloud compute instances stop claude-vm --zone=us-central1-a
gcloud compute instances start claude-vm --zone=us-central1-a  # resume later
```

### Notes

- **Proxy config:** stored in `~/.claude-proxy-env` on the VM. Re-run `provision-vm.sh --connect` after changing `WORKER_URL` or `PROXY_TOKEN` in `.dev.vars` to push the updated values.
- **Files:** `/workspace` is just the VM's local disk. Copy files with `gcloud compute scp` or use the VM as a full dev environment.
- **OS login:** the script uses `enable-oslogin=TRUE` metadata, which maps your gcloud account to a VM user. No SSH keys to manage.

---

## Option 3: Cloud Run Job

**Use when:** you want Claude Code to run a task non-interactively — CI pipelines, scheduled analysis, automated code review.

> ⚠️ Cloud Run Jobs have **no TTY**. Claude Code runs in `--print` (non-interactive) mode. You cannot have a back-and-forth conversation.

### Deploy

```bash
./scripts/deploy-gcr.sh --project YOUR_PROJECT_ID
```

The script:
1. Enables Artifact Registry and Cloud Run APIs
2. Creates the AR repo `claude-proxy` if it doesn't exist
3. Builds `docker/Dockerfile.claude` for `linux/amd64`
4. Pushes the image to Artifact Registry
5. Creates (or updates) the Cloud Run Job `claude-interactive`

### Execute a job

```bash
# Run and stream logs until complete
gcloud run jobs execute claude-interactive \
  --region=us-central1 \
  --wait

# Pass a one-shot prompt as an override argument
gcloud run jobs execute claude-interactive \
  --region=us-central1 \
  --args="--print,Summarise all TODO comments in /workspace" \
  --wait
```

### View logs

```bash
# Tail the most recent execution
gcloud run jobs executions list --job=claude-interactive --region=us-central1

gcloud logging read \
  'resource.type="cloud_run_job" AND resource.labels.job_name="claude-interactive"' \
  --limit=100 \
  --format="value(textPayload)"
```

### Options

```bash
./scripts/deploy-gcr.sh \
  --project  my-project \
  --region   us-east1 \
  --tag      $(git rev-parse --short HEAD) \   # pin image to a git SHA
  --job      my-claude-job
```

### Cost

Cloud Run Jobs bill only for the time the container is running (CPU + memory). An idle job costs nothing.

---

## Option 4: Cloud Run Service

**Use when:** you want to call Claude Code via HTTP — from a webhook, a CI step, another service, or a script that can't run `gcloud`.

> ⚠️ Also **no TTY**. Each request is a single `claude --print` turn. No multi-turn conversations.

### Deploy

```bash
# Private URL (requires GCP identity token to call)
./scripts/deploy-gcr-service.sh --project YOUR_PROJECT_ID

# Public URL (no auth required — anyone with the URL can call it)
./scripts/deploy-gcr-service.sh --project YOUR_PROJECT_ID --allow-unauthenticated
```

The script builds `docker/Dockerfile.claude-service` (which runs `service-server.py`) and deploys it as a Cloud Run Service.

### Call the service

```bash
SERVICE_URL="https://claude-service-xxxx-uc.a.run.app"

# Get an identity token (required if not public)
TOKEN=$(gcloud auth print-identity-token)

# Health check
curl "$SERVICE_URL/health" -H "Authorization: Bearer $TOKEN"

# One-shot prompt (blocking — waits for full response)
curl -X POST "$SERVICE_URL/run" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "list the files in /workspace"}'

# Streaming (Server-Sent Events — prints output as it arrives)
curl -N -X POST "$SERVICE_URL/run" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "explain the codebase structure", "stream": true}'
```

### Response format

**Blocking (`stream` omitted or `false`):**
```json
{ "output": "Here are the files in /workspace:\n..." }
```

**Streaming (`"stream": true`):** Server-Sent Events

```
event: data
data: Here are the files

event: data
data: in /workspace:

event: done
data: {"ok": true}
```

### Options

```bash
./scripts/deploy-gcr-service.sh \
  --project               my-project \
  --region                europe-west1 \
  --service               my-claude-svc \
  --allow-unauthenticated              # skip GCP auth for testing
```

### Cost

Cloud Run Services scale to zero. You pay only for requests:
- ~$0.40 per million requests
- ~$0.00002400 per vCPU-second
- Free tier: 2M requests/month, 360,000 vCPU-seconds/month

---

## Updating credentials

If your `WORKER_URL` or `PROXY_TOKEN` changes:

| Deployment | How to update |
|---|---|
| Docker (local) | Pass new `-e` flags at `docker run` time |
| Cloud Shell | Re-run `launch-cloud-shell.sh` — it overwrites the remote env |
| Compute Engine | Re-run `provision-vm.sh --connect` — rewrites `~/.claude-proxy-env` |
| Cloud Run Job | Re-run `deploy-gcr.sh` — updates `--set-env-vars` |
| Cloud Run Service | Re-run `deploy-gcr-service.sh` — updates `--set-env-vars` |

For production GCP deployments (Job + Service), prefer **Secret Manager** over plain env vars so the token never appears in the Cloud Run console:

```bash
# Store the token as a secret (one-time)
echo -n "your-token" | gcloud secrets create claude-proxy-token --data-file=-

# Reference it in the deploy command instead of --set-env-vars PROXY_TOKEN=...
gcloud run services update claude-service \
  --region=us-central1 \
  --set-secrets=PROXY_TOKEN=claude-proxy-token:latest
```

---

## Troubleshooting

**`claude: command not found` (VM or Cloud Shell)**
The installer puts `claude` in `~/.local/bin`. Make sure it's on `PATH`:
```bash
export PATH="$HOME/.local/bin:$PATH"
```
Or reconnect — the scripts add this to `~/.bashrc` automatically.

**`WORKER_URL is not set`**
Add it to `.dev.vars`:
```bash
echo 'WORKER_URL=https://claude-proxy.YOUR-ACCOUNT.workers.dev' >> .dev.vars
```

**Cloud Run Service returns 500**
Check the logs — the Worker may be returning an error:
```bash
gcloud run services logs read claude-service --region=us-central1 --limit=50
```

**Cloud Shell disconnects mid-session**
Cloud Shell has a 20-minute inactivity timeout. Use `tmux` inside the session to keep it alive:
```bash
# First time: install tmux (persists in Cloud Shell home)
sudo apt-get install -y tmux
# Start a persistent session
tmux new -s claude
# Reattach after reconnect
tmux attach -t claude
```

**VM SSH connection refused**
The VM may be stopped:
```bash
gcloud compute instances start claude-vm --zone=us-central1-a
```

**Proxy not routing correctly**
Verify the Worker is reachable and your token is correct:
```bash
curl -sf \
  -H "Authorization: Bearer $PROXY_TOKEN" \
  "$WORKER_URL/health" | jq .
```
