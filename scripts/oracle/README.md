# Oracle Cloud Infrastructure — Discord Bot Deployment

Self-contained deployment for running Claude Code Discord sessions on OCI Always Free compute. No paid resources required.

---

## Shape comparison — which instance to use

OCI Always Free gives you two compute options. Both are permanent (never expire), but they are very different in capability.

### AMD — `VM.Standard.E2.1.Micro`

| Spec | Value |
|---|---|
| Free instances | 2 |
| OCPU per instance | 1/8 (shared) |
| RAM per instance | 1 GB |
| Architecture | x86\_64 |

**RAM breakdown on AMD:**
```
Ubuntu OS (minimal):        ~350 MB
Docker daemon:              ~100 MB
One claude-discord session: ~155–400 MB
─────────────────────────────────────
Remaining headroom:          150 MB → zero
```

AMD can technically run one session but risks OOM the moment anything spikes. Two sessions is not viable. **Only use AMD for evaluation or single very-light workloads.**

---

### ARM — `VM.Standard.A1.Flex` ✅ Recommended

| Spec | Value |
|---|---|
| Free allocation | 4 OCPUs + 24 GB RAM total |
| Recommended config | 1 instance, 4 OCPU, 24 GB |
| Architecture | aarch64 (Ampere) |
| vCPU equivalent | 8 vCPUs (1 OCPU = 2 vCPUs) |

**RAM breakdown on ARM:**
```
Ubuntu OS:                  ~400 MB
Docker daemon:              ~100 MB
Available for sessions:     ~23.5 GB
Per session (idle):         ~155 MB
Per session (active):       ~250–400 MB
─────────────────────────────────────────
Comfortable sessions:       10–15
Theoretical max (idle):     ~140
```

**CPU:** Claude Code sessions spend 95%+ of their time waiting on network I/O (Discord gateway + Cloudflare Worker API). CPU is almost never the bottleneck. 4 OCPUs is well above what 10–15 sessions need.

---

## Measured resource usage (actual container)

Measured from a running `claude-discord` container at idle (no active conversation):

| Process | RAM |
|---|---|
| `claude` (main process) | ~242 MB RSS |
| `python3` (PTY wrapper) | ~9 MB |
| Shell helpers | ~2 MB |
| **Docker stats (working set)** | **~155 MB** |

> **Why the difference?** `/proc/VmRSS` double-counts shared libraries. Docker stats reports the unique working set — the real number is ~155 MB idle.

When active (bun + discord plugin subprocess running during a conversation):
- Bun process adds ~80–120 MB
- Peak during tool execution: ~350–500 MB per session

---

## Compared to GCE free tier

| | OCI ARM A1.Flex | OCI AMD E2.1.Micro | GCE e2-micro |
|---|---|---|---|
| RAM | **24 GB** | 1 GB × 2 | 1 GB |
| vCPU | **8** | 0.25 × 2 | 2 (shared, burstable) |
| Concurrent sessions | **10–15** | 1 (risky) | 1 (risky) |
| Network egress (free) | Generous | Generous | **1 GB/month** ❌ |
| ARM support | ✅ Yes | No | No |
| Available regions | Any | Any | US only |
| Free boot disk | 200 GB total | 200 GB total | 30 GB |

**GCE dealbreaker:** The 1 GB/month egress cap is fatal for a Discord bot. A single Docker image pull of `claude-discord` (~1–2 GB) exceeds the monthly budget. Traffic to Discord, Cloudflare Worker, and Docker Hub all count as billable egress. **Do not use GCE free tier for this project.**

---

## Prerequisites

```bash
# 1. Install OCI CLI
# macOS:
brew install oci-cli
# Linux:
curl -L https://raw.githubusercontent.com/oracle/oci-cli/master/scripts/install/install.sh | bash

# 2. Configure OCI CLI (you need your tenancy OCID, user OCID, and an API key)
oci setup config
# Follow the prompts — it writes to ~/.oci/config

# 3. Verify config
oci iam availability-domain list --all

# 4. Install jq (required for JSON parsing in scripts)
brew install jq   # macOS
sudo apt install jq  # Ubuntu

# 5. Create an SSH key if you don't have one
ssh-keygen -t ed25519 -C "oracle-claude" -f ~/.ssh/id_ed25519
```

You also need your `.dev.vars` populated with:
```
DISCORD_BOT_TOKEN=MTIz...
WORKER_URL=https://claude-proxy.YOUR-ACCOUNT.workers.dev
PROXY_TOKEN=your-secret
```

---

## Provisioning the VM

```bash
# Create ARM instance (recommended — 4 OCPU, 24 GB RAM, Always Free)
./scripts/oracle/provision-vm.sh

# Create AMD instance (evaluation only — 1 GB RAM, risky for Docker)
./scripts/oracle/provision-vm.sh --shape amd

# Custom name or region
./scripts/oracle/provision-vm.sh --name my-bot-vm --region ap-sydney-1

# Check what options are available
./scripts/oracle/provision-vm.sh --help
```

Provisioning takes ~5–8 minutes and creates:
- VCN (Virtual Cloud Network) with internet gateway
- Public subnet with security rules (SSH inbound, all egress)
- Compute instance with Ubuntu 22.04 and Docker pre-installed
- State file at `scripts/oracle/.state/<vm-name>.env`

---

## Build pipeline

`docker/discord-plugin/server.ts` is the **single source of truth**.  
The `Dockerfile` and build command are **unchanged** — the same `docker build` that runs locally runs on the Oracle VM.

Local edits are packaged into each rebuild by rsyncing `docker/` to the VM before building.

```bash
# After editing any file in docker/ (server.ts, entrypoint.sh, autotheme.py, etc.)
./scripts/oracle/deploy-session.sh build
```

What `build` does:
1. `sync-discord-plugin.sh` — push `docker/discord-plugin/server.ts` → local Claude cache
2. `rsync docker/` → Oracle VM
3. `docker build -f docker/Dockerfile.claude-discord .` on the VM (native arch, no cross-compilation)
4. Image is stored on the VM — no registry needed, no OCIR storage costs

> **First build:** ~10–15 minutes (downloads Debian, Bun, Claude Code).  
> **Subsequent builds:** ~1–3 minutes (Docker layer cache on VM preserves unchanged layers).

---

## Managing sessions

### Start a session

```bash
./scripts/oracle/deploy-session.sh start \
  --channel-id 1510193804525961326 \
  --discord-users 750640430416265267
```

Each session gets two named Docker volumes for persistence across restarts:
- `discord-state-<channel-id>` → `/root/.claude/` (conversation history, settings)
- `discord-workspace-<channel-id>` → `/workspace/` (files Claude creates)

### All commands

```bash
# Build image on VM from current local source
./scripts/oracle/deploy-session.sh build

# Start a Discord session
./scripts/oracle/deploy-session.sh start --channel-id ID --discord-users ID1,ID2

# Stop a session (volumes preserved)
./scripts/oracle/deploy-session.sh stop --channel-id ID

# Restart a session (picks up rebuilt image)
./scripts/oracle/deploy-session.sh restart --channel-id ID

# List all running sessions
./scripts/oracle/deploy-session.sh list

# Stream logs
./scripts/oracle/deploy-session.sh logs --channel-id ID --follow

# Open SSH shell on the VM
./scripts/oracle/deploy-session.sh ssh
```

### VM management

```bash
# Show VM status + running sessions
./scripts/oracle/provision-vm.sh --status

# SSH into VM
./scripts/oracle/provision-vm.sh --connect

# Permanently destroy VM and all network resources
./scripts/oracle/provision-vm.sh --delete
```

---

## Persistence

Session data survives container restarts and VM reboots because Docker volumes are stored on the VM's boot disk.

To back up session state to an OCI Object Storage bucket (free tier: 10 GB):

```bash
# On the Oracle VM, export a session's volumes
docker run --rm \
  -v discord-state-CHANNEL_ID:/data \
  ubuntu tar cz /data | \
  oci os object put --bucket-name claude-backups --name session-CHANNEL_ID.tar.gz --file -
```

---

## Cost — staying within Always Free

OCI Always Free resources used by this setup:

| Resource | Used | Always Free limit |
|---|---|---|
| ARM compute (A1.Flex) | 4 OCPU, 24 GB | 4 OCPU, 24 GB ✅ |
| Boot volume | 50 GB | 200 GB total ✅ |
| Public IP | 1 | 2 free ✅ |
| Network egress | Varies | 10 TB/month ✅ |
| Object Storage (optional backup) | < 10 GB | 10 GB free ✅ |

> **OCIR (Container Registry)** is NOT used. Images are built and stored on the VM. The `claude-discord` image is 1–2 GB and would exceed OCIR's 500 MB free tier immediately.

---

## Troubleshooting

**A1.Flex not available in my region / availability domain:**  
ARM availability is sometimes limited in specific ADs. Try a different region (`--region us-ashburn-1`, `--region ap-osaka-1`) or check [OCI region availability](https://www.oracle.com/cloud/architecture-and-regions/).

**SSH connection refused after provisioning:**  
Ubuntu cloud images can take 2–3 minutes after "RUNNING" before SSH accepts connections. The provisioning script waits automatically, but if it times out, try `./scripts/oracle/provision-vm.sh --connect` manually after a minute.

**`docker: command not found` on first SSH:**  
The install script adds `ubuntu` to the `docker` group. Log out and back in, or run `newgrp docker` in your SSH session.

**Build fails on ARM with platform errors:**  
No `--platform` flag is needed — building natively on the ARM VM means Docker uses `linux/arm64` automatically. All base images (`debian:bookworm-slim`, Bun, Claude Code) support arm64.
