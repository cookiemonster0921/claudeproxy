# Docker & Cloud Run Guide

Everything needed to build and run Claude Code through the `claude-proxy` Cloudflare Worker — locally in Docker and on Google Cloud Run.

---

## What's in this folder

| File / Folder | Purpose |
|---|---|
| `Dockerfile.claude` | Interactive Claude Code session — used for local `docker run` and Cloud Run Jobs |
| `Dockerfile.claude-service` | Stateless HTTP service — used for Cloud Run Services (API mode) |
| `Dockerfile.claude-discord` | Self-contained Discord session — Claude Code + Discord plugin in one container |
| `docker-entrypoint.sh` | Entrypoint for `Dockerfile.claude` |
| `discord-entrypoint.sh` | Entrypoint for `Dockerfile.claude-discord` — configures access control and starts claude |
| `discord-plugin/` | Discord MCP plugin source bundled into the Discord image |
| `container/` | Standalone TypeScript app that runs inside the service container |

All Dockerfiles use the **repo root as build context** (`docker build ... .`), so all `COPY` paths are relative to the repo root, not this folder.

---

## Prerequisites

**Required for everything:**

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) running locally
- The Cloudflare Worker already deployed (see `README.md`)
- `.dev.vars` in the repo root with your credentials:

  ```
  WORKER_URL=https://claude-proxy.YOUR-ACCOUNT.workers.dev
  PROXY_TOKEN=your-secret-token
  ```

**Required for Cloud Run:**

- [gcloud CLI](https://cloud.google.com/sdk/docs/install) installed and authenticated:

  ```bash
  gcloud auth login
  gcloud auth application-default login
  ```

- A GCP project with billing enabled

---

## Local Docker (interactive)

`Dockerfile.claude` gives you a full interactive Claude Code session routed through your Worker — the equivalent of running `cproxy on prod` locally, but in a clean container.

### Build

Run from the **repo root**:

```bash
docker build -f docker/Dockerfile.claude -t claude-interactive .
```

### Run

```bash
docker run -it --rm \
  -e WORKER_URL="https://claude-proxy.YOUR-ACCOUNT.workers.dev" \
  -e PROXY_TOKEN="your-secret-token" \
  claude-interactive
```

> **`-it` is required.** Claude Code needs a real TTY — without it the session won't start interactively.

### Mount a local project

```bash
docker run -it --rm \
  -e WORKER_URL="https://claude-proxy.YOUR-ACCOUNT.workers.dev" \
  -e PROXY_TOKEN="your-secret-token" \
  -v "$(pwd)":/workspace \
  claude-interactive
```

Claude Code uses `/workspace` as its project root inside the container. Files edited inside the session appear on your machine immediately.

### Pass extra Claude flags

Any arguments after the image name are forwarded directly to `claude`:

```bash
# Use a specific model
docker run -it --rm -e WORKER_URL=... -e PROXY_TOKEN=... \
  claude-interactive --model claude-opus-4-7

# Start with a one-shot prompt (non-interactive)
docker run --rm -e WORKER_URL=... -e PROXY_TOKEN=... \
  claude-interactive --print "Summarise all TODO comments"
```

### How the entrypoint works

`docker-entrypoint.sh`:
1. Validates `WORKER_URL` is set — exits with a clear error if missing
2. Sets `ANTHROPIC_BASE_URL` to your Worker URL so all API calls go through the proxy
3. Sets `ANTHROPIC_AUTH_TOKEN` to `PROXY_TOKEN` for Worker authentication
4. Unsets all Vertex / Bedrock / AWS env vars to prevent proxy bypass
5. `exec`s `claude` so it becomes PID 1 (clean signal handling)

---

## Cloud Run Job (batch / automation)

**Use when:** you want Claude to run a task non-interactively — CI pipelines, scheduled analysis, automated code review.

> ⚠️ Cloud Run Jobs have **no TTY**. Claude Code runs in `--print` mode. There is no back-and-forth conversation.

### First-time GCP setup

You only need to do this once per project:

```bash
# Set your project
gcloud config set project YOUR_PROJECT_ID

# Enable the required APIs
gcloud services enable \
  artifactregistry.googleapis.com \
  run.googleapis.com \
  cloudbuild.googleapis.com
```

### Deploy

```bash
./scripts/deploy-gcr.sh --project YOUR_PROJECT_ID
```

The script does everything automatically:

1. Reads `WORKER_URL` and `PROXY_TOKEN` from `.dev.vars`
2. Creates an Artifact Registry Docker repo named `claude-proxy` (if it doesn't exist)
3. Authenticates Docker with Artifact Registry
4. Builds `docker/Dockerfile.claude` for `linux/amd64`
5. Pushes the image to `REGION-docker.pkg.dev/PROJECT/claude-proxy/claude-interactive:latest`
6. Creates or updates the Cloud Run Job `claude-interactive` with the credentials as env vars

**Optional flags:**

```bash
./scripts/deploy-gcr.sh \
  --project  my-project-id \
  --region   us-east1 \              # default: us-central1
  --tag      $(git rev-parse --short HEAD) \  # pin image to a git SHA
  --job      my-job-name             # default: claude-interactive
```

### Execute a job

```bash
# Run and wait for it to finish, streaming logs
gcloud run jobs execute claude-interactive \
  --region=us-central1 \
  --wait

# Pass a one-shot prompt as a command override
gcloud run jobs execute claude-interactive \
  --region=us-central1 \
  --args="--print,Summarise all TODO comments in /workspace" \
  --wait
```

### View logs

```bash
# List recent executions
gcloud run jobs executions list \
  --job=claude-interactive \
  --region=us-central1

# Read logs from the most recent execution
gcloud logging read \
  'resource.type="cloud_run_job" AND resource.labels.job_name="claude-interactive"' \
  --limit=100 \
  --format="value(textPayload)"
```

### Redeploy after code changes

Just re-run the deploy script. It detects whether the job already exists and does `create` vs `update` automatically.

```bash
./scripts/deploy-gcr.sh --project YOUR_PROJECT_ID --tag v2
```

### Cost

Cloud Run Jobs bill only for the time the container is actively running. An idle job costs nothing. Pricing: ~$0.00002400 per vCPU-second.

---

## Cloud Run Service (HTTP API)

**Use when:** you want to call Claude via HTTP — from a webhook, another service, a CI step, or any script that can't run `gcloud` directly.

> ⚠️ Also **no TTY**. Each HTTP request triggers one `claude --print` turn. No multi-turn conversations.

The service exposes two endpoints:

| Endpoint | Description |
|---|---|
| `GET /health` | Readiness probe — returns `{"ok": true}` |
| `POST /run` | Run one Claude turn, returns full JSON response |
| `POST /run` with `"stream": true` | Same, streamed as Server-Sent Events |

### First-time GCP setup

Same as for Cloud Run Jobs (see above) — `artifactregistry.googleapis.com` and `run.googleapis.com` must be enabled.

### Deploy

```bash
# Private URL (requires GCP identity token to call — recommended for production)
./scripts/deploy-gcr-service.sh --project YOUR_PROJECT_ID

# Public URL (no auth — good for testing or internal tools)
./scripts/deploy-gcr-service.sh --project YOUR_PROJECT_ID --allow-unauthenticated
```

The script:
1. Reads credentials from `.dev.vars`
2. Builds `docker/Dockerfile.claude-service` for `linux/amd64`
3. Pushes to Artifact Registry
4. Deploys the Cloud Run Service (scales to zero when idle)
5. Runs a `/health` smoke test and prints the service URL

**Optional flags:**

```bash
./scripts/deploy-gcr-service.sh \
  --project               my-project-id \
  --region                europe-west1 \   # default: us-central1
  --service               my-svc-name \    # default: claude-service
  --allow-unauthenticated                  # make URL public
```

### Call the service

```bash
SERVICE_URL="https://claude-service-xxxx-uc.a.run.app"

# Get an identity token (only needed if the service is private)
TOKEN=$(gcloud auth print-identity-token)

# Health check
curl "$SERVICE_URL/health" \
  -H "Authorization: Bearer $TOKEN"

# One-shot prompt (blocking — waits for the full response)
curl -X POST "$SERVICE_URL/run" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "list the files in /workspace"}'

# Streaming prompt (prints output as it arrives)
curl -N -X POST "$SERVICE_URL/run" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "explain the codebase structure", "stream": true}'
```

Drop the `-H "Authorization: Bearer $TOKEN"` header if you deployed with `--allow-unauthenticated`.

### Response formats

**Blocking (`stream` omitted or `false`):**
```json
{ "output": "Here are the files in /workspace:\n- src/\n- package.json\n..." }
```

**Streaming (`"stream": true`):** Server-Sent Events, one line per SSE frame:
```
event: data
data: Here are the files

event: data
data: in /workspace:

event: done
data: {"ok": true}
```

On error, a final `event: error` frame is sent with `returncode` and `stderr`.

### Redeploy

```bash
./scripts/deploy-gcr-service.sh --project YOUR_PROJECT_ID
```

Cloud Run performs a zero-downtime rollout — the old revision keeps serving traffic until the new one passes its health check.

### Cost

Cloud Run Services scale to zero — you pay nothing when idle.

| Resource | Price |
|---|---|
| Requests | ~$0.40 per million |
| CPU | ~$0.00002400 per vCPU-second |
| Memory | ~$0.00000250 per GB-second |
| **Free tier** | 2M requests/month, 360,000 vCPU-seconds/month |

---

## Discord Sessions (one container per channel)

This is the cleanest way to run multiple concurrent Claude Code sessions controlled via Discord. Instead of building a separate HTTP layer, each container bundles Claude Code + the Discord plugin. Communication is entirely through Discord itself — the plugin runs as the MCP server, connects to the Discord gateway, and relays messages to Claude Code.

```
Discord channel #project-a  ──▶  claude-discord container (channel 111...)
Discord channel #project-b  ──▶  claude-discord container (channel 222...)
Discord channel #project-c  ──▶  claude-discord container (channel 333...)
```

Each container is fully isolated — separate session state, separate conversation history, separate tool permissions.

### How it works

1. Container starts → `discord-entrypoint.sh` runs
2. Entrypoint writes `access.json` from env vars (no pairing flow needed)
3. Entrypoint writes `~/.claude/settings.json` registering the Discord plugin as an MCP server
4. Claude Code starts and auto-launches the Discord plugin as a subprocess
5. The plugin connects to Discord gateway and begins listening
6. Discord message arrives → plugin sends `notifications/claude/channel` to Claude Code → Claude processes it → plugin posts the response back to Discord

No HTTP endpoints. No webhooks. No polling.

### Prerequisites

Add to your `.dev.vars`:
```
DISCORD_BOT_TOKEN=MTIz...your-bot-token...
```

The bot must be in the Discord server and have permission to read and send messages in the relevant channels.

### Build the image

```bash
# Sync latest plugin edits into the build context, then build
./scripts/sync-discord-plugin.sh
docker build -f docker/Dockerfile.claude-discord -t claude-discord .
```

Or let the spawn script handle it automatically (it syncs and builds if needed).

### Start a session — local Docker

```bash
./scripts/spawn-discord-session.sh \
  --channel-id 1510193804525961326 \
  --allowed-users "750640430416265267"
```

The container runs detached with `--restart unless-stopped`. It keeps running until you explicitly stop it.

**With multiple allowed users:**
```bash
./scripts/spawn-discord-session.sh \
  --channel-id 1234567890123456789 \
  --allowed-users "111222333444,555666777888" \
  --require-mention
```

**`--require-mention`** — Claude only responds when @mentioned in the channel (useful for shared servers where the bot is present in many channels).

### Start a session — Cloud Run

```bash
./scripts/spawn-discord-session.sh \
  --channel-id 1234567890123456789 \
  --allowed-users "YOUR_DISCORD_USER_ID" \
  --project my-gcp-project
```

The script creates a Cloud Run Job named `discord-session-CHANNELID`, builds and pushes the image to Artifact Registry, and starts an execution. Each channel gets its own named job.

> **24-hour limit**: Cloud Run Jobs have a maximum task timeout of 24 hours. After that, the execution ends and you re-run the script to start a new one. For permanently persistent sessions (days/weeks without restart), use a Compute Engine VM or GKE pod instead.

### Manage sessions

```bash
# List all running sessions (local)
./scripts/spawn-discord-session.sh --list

# List all running sessions (Cloud Run)
./scripts/spawn-discord-session.sh --list --project my-gcp-project

# Stop a session (local)
./scripts/spawn-discord-session.sh --stop --channel-id 1234567890123456789

# Stop a session (Cloud Run)
./scripts/spawn-discord-session.sh --stop --channel-id 1234567890123456789 --project my-gcp-project

# View logs (local)
docker logs -f discord-session-1234567890123456789

# View logs (Cloud Run)
gcloud run jobs executions list --job=discord-session-1234567890123456789 --region=us-central1
gcloud logging read 'resource.labels.job_name="discord-session-1234567890123456789"' --limit=50
```

### Environment variables

| Variable | Required | Description |
|---|---|---|
| `DISCORD_BOT_TOKEN` | ✅ | Bot token from Discord Developer Portal |
| `WORKER_URL` | ✅ | Cloudflare Worker proxy URL |
| `PROXY_TOKEN` | — | Worker auth token (default: `dev-token`) |
| `DISCORD_ALLOWED_CHANNEL` | Recommended | Channel ID this session serves |
| `DISCORD_ALLOWED_USERS` | Recommended | Comma-separated Discord user ID snowflakes |
| `DISCORD_REQUIRE_MENTION` | — | `true` to require @mention in guild channels |
| `DISCORD_DEBUG_WEBHOOK_URL` | — | Webhook URL for plugin debug logs |
| `DISCORD_STATE_DIR` | — | Plugin state directory (default: `/root/.claude/channels/discord`) |

### Updating the plugin

After editing `server.ts`, sync and rebuild:

```bash
./scripts/sync-discord-plugin.sh

# Rebuild and restart affected sessions
docker build -f docker/Dockerfile.claude-discord -t claude-discord .
./scripts/spawn-discord-session.sh --stop  --channel-id CHANNEL_ID
./scripts/spawn-discord-session.sh --start --channel-id CHANNEL_ID
```

For Cloud Run, re-run the spawn script with `--project` — it detects the existing job and does an update, then starts a new execution.

### Access control

The entrypoint generates `access.json` from env vars and starts the plugin with `DISCORD_ACCESS_MODE=static`. This means:

- Access is determined entirely by `DISCORD_ALLOWED_USERS` and `DISCORD_ALLOWED_CHANNEL`
- The pairing flow is disabled (you don't need to run `/discord:access` inside Claude)
- The access file is read-only at runtime — no user can modify it by sending Discord messages

This is intentional for containerised sessions: credentials are configuration, not runtime state.

---

## Credentials & secrets

### Development

The deploy scripts read `WORKER_URL` and `PROXY_TOKEN` from `.dev.vars` automatically. You don't need to pass them as flags.

### Production — use Secret Manager

For production deployments, store `PROXY_TOKEN` in Secret Manager so it never appears in plain text in the Cloud Run console or deployment logs.

```bash
# Store the token once
echo -n "your-proxy-token" | \
  gcloud secrets create claude-proxy-token --data-file=-

# Grant Cloud Run access to the secret
gcloud secrets add-iam-policy-binding claude-proxy-token \
  --member="serviceAccount:$(gcloud run services describe claude-service \
    --region=us-central1 --format='value(spec.template.spec.serviceAccountName)')" \
  --role="roles/secretmanager.secretAccessor"

# Update the service to use the secret instead of a plain env var
gcloud run services update claude-service \
  --region=us-central1 \
  --set-secrets=PROXY_TOKEN=claude-proxy-token:latest

# Same for a job
gcloud run jobs update claude-interactive \
  --region=us-central1 \
  --set-secrets=PROXY_TOKEN=claude-proxy-token:latest
```

### Rotating credentials

If your `WORKER_URL` or `PROXY_TOKEN` changes, just re-run the deploy script — it overwrites the env vars on the existing Cloud Run resource.

---

## Manage deployed resources

### List everything

```bash
# Jobs
gcloud run jobs list --region=us-central1

# Services
gcloud run services list --region=us-central1

# Images in Artifact Registry
gcloud artifacts docker images list \
  us-central1-docker.pkg.dev/YOUR_PROJECT/claude-proxy
```

### Update resources without a full redeploy

```bash
# Update env vars on a job
gcloud run jobs update claude-interactive \
  --region=us-central1 \
  --set-env-vars="WORKER_URL=https://new-worker.workers.dev,PROXY_TOKEN=new-token"

# Update env vars on a service
gcloud run services update claude-service \
  --region=us-central1 \
  --set-env-vars="WORKER_URL=https://new-worker.workers.dev"

# Scale a service
gcloud run services update claude-service \
  --region=us-central1 \
  --max-instances=10
```

### Delete resources

```bash
# Delete a job
gcloud run jobs delete claude-interactive --region=us-central1

# Delete a service
gcloud run services delete claude-service --region=us-central1

# Delete the Artifact Registry repo and all images
gcloud artifacts repositories delete claude-proxy \
  --location=us-central1
```

---

## Troubleshooting

**`WORKER_URL is not set`**
The entrypoint validates this before starting Claude. Make sure `.dev.vars` contains:
```
WORKER_URL=https://claude-proxy.YOUR-ACCOUNT.workers.dev
```

**`claude: command not found` inside a container**
The image installs Claude Code in `/root/.local/bin`. If you're running a custom command and bypassing the entrypoint, add it to PATH:
```bash
export PATH="/root/.local/bin:$PATH"
```

**`docker build` fails with `denied: Unauthenticated request`**
Re-run the Docker credential helper:
```bash
gcloud auth configure-docker us-central1-docker.pkg.dev
```

**Cloud Run Service returns 500**
Check the logs — the Worker or the Claude subprocess may be returning an error:
```bash
gcloud run services logs read claude-service \
  --region=us-central1 \
  --limit=50
```

**Cloud Run Job times out**
The job has a 1-hour task timeout (`--task-timeout=3600`). For longer-running tasks, increase it (max 24h):
```bash
gcloud run jobs update claude-interactive \
  --region=us-central1 \
  --task-timeout=7200
```

**Image is `arm64` but Cloud Run needs `amd64`**
The deploy scripts already pass `--platform linux/amd64`. If you build manually, always include this flag:
```bash
docker build --platform linux/amd64 -f docker/Dockerfile.claude -t ... .
```

**Proxy not routing correctly**
Verify the Worker is reachable and responding before deploying:
```bash
curl -sf \
  -H "Authorization: Bearer $PROXY_TOKEN" \
  "$WORKER_URL/health" | jq .
```
