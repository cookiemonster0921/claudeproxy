# GCP Deployment Experiments

The working Discord container is a long-running background process. Compute
Engine is the supported deployment target for the image as it exists today.

Cloud Run Service and Cloud Run Job scripts are included as explicit
experiments:

- Cloud Run Service is expected to fail because this image does not listen on
  the injected `PORT`.
- Cloud Run Job can run temporarily, but the Discord listener intentionally
  never exits and its filesystem state is ephemeral.

## Configuration

Set these values in the repository root `.dev.vars`:

```bash
WORKER_URL=https://your-worker.workers.dev
PROXY_TOKEN=your-worker-token
ANTHROPIC_API_KEY=your-console-api-key
DISCORD_BOT_TOKEN=your-discord-bot-token
CLAUDE_MODEL=google_ai/gemini-2.5-flash
DISCORD_CHANNEL_IDS=1510193804525961326
DISCORD_USER_IDS=750640430416265267
DISCORD_DM_POLICY=allowlist
DISCORD_REQUIRE_MENTION=false
```

The deployment scripts sync `ANTHROPIC_API_KEY`, `DISCORD_BOT_TOKEN`, and
`PROXY_TOKEN` into Google Secret Manager. They do not place secret values in
image layers or `gcloud --set-env-vars` arguments.

## Push The Image

```bash
./scripts/gcp-push-discord-image.sh --project YOUR_PROJECT_ID
```

The default repository and image are:

```text
us-central1-docker.pkg.dev/YOUR_PROJECT_ID/claude-discord/claude-discord:latest
```

## Compute Engine

```bash
./scripts/gcp-deploy-discord-compute-engine.sh --project YOUR_PROJECT_ID
```

The default VM is `claude-discord-free`, an `e2-micro` in
`us-central1-a`. It installs Docker through a startup script, pulls the image,
reads runtime secrets from Secret Manager, and starts the container with
`--restart unless-stopped`. The startup script also adds a 2 GB swap file to
reduce avoidable out-of-memory exits on the 1 GB VM.

Inspect startup:

```bash
gcloud compute ssh claude-discord-free \
  --project YOUR_PROJECT_ID \
  --zone us-central1-a \
  --command='sudo docker logs --tail 80 claude-discord-chatgpt-version'
```

## Cloud Run Service Experiment

```bash
./scripts/gcp-deploy-discord-cloud-run-service.sh \
  --project YOUR_PROJECT_ID \
  --acknowledge-incompatible-runtime
```

This deployment is expected to fail its startup health check. A Cloud Run
Service ingress container must listen on `0.0.0.0:$PORT`; the working Discord
image intentionally does not expose an HTTP server.

## Cloud Shell Temporary Test

Start the Discord listener in your personal Cloud Shell session:

```bash
./scripts/gcp-run-discord-cloud-shell.sh \
  --project YOUR_PROJECT_ID
```

Inspect or stop it later:

```bash
./scripts/gcp-run-discord-cloud-shell.sh logs --project YOUR_PROJECT_ID
./scripts/gcp-run-discord-cloud-shell.sh status --project YOUR_PROJECT_ID
./scripts/gcp-run-discord-cloud-shell.sh stop --project YOUR_PROJECT_ID
```

Cloud Shell is for temporary testing only. The backing VM is ephemeral,
non-interactive sessions end automatically after 40 minutes, and interactive
sessions are capped at 12 hours. The script stores runtime state under
`$HOME/.claude-discord-cloud-shell`, which uses Cloud Shell's 5 GB persistent
home disk.

## Cloud Run Job Experiment

Deploy:

```bash
./scripts/gcp-deploy-discord-cloud-run-job.sh \
  --project YOUR_PROJECT_ID \
  --acknowledge-time-limited-runtime
```

Deploy and start one execution:

```bash
./scripts/gcp-deploy-discord-cloud-run-job.sh \
  --project YOUR_PROJECT_ID \
  --acknowledge-time-limited-runtime \
  --execute
```

The default timeout is `24h`. Cloud Run supports longer Job task timeouts, but
this container is still a continuously running listener rather than a finite
batch task.

## Cost Notes

Free-tier quotas are ceilings, not a guarantee of zero cost:

- Artifact Registry includes 0.5 GB of storage per billing account. Remove old
  image tags to stay under that limit.
- The Compute Engine free tier includes one eligible `e2-micro` VM in selected
  US regions plus limited standard persistent disk usage. `e2-micro` may be too
  small for Claude Code plus Bun; monitor for OOM exits.
- A continuously running Cloud Run Job consumes CPU and memory quota while it
  is active.
- Cloud Run Service does not fit this image's runtime contract.
