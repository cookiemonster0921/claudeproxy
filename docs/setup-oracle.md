# Setting Up the Discord Launcher on Oracle Cloud (OCI)

This guide walks you through creating an Oracle Cloud Infrastructure (OCI) ARM virtual machine that runs the Discord session launcher daemon. Once set up, typing `/oracle` in Discord will launch a Claude Code session on this VM.

## What you'll end up with

- A permanent ARM VM on Oracle Cloud running 24/7 with 4 OCPUs and 24 GB RAM
- A `claude-launcher` background service that listens for `/oracle` Discord commands
- Claude sessions running as detached tmux panes on the VM — no terminal window needed on your laptop

## Cost

Oracle Cloud has an **Always Free** tier that is significantly more generous than GCE for this use case:

| Resource | Free allowance |
|---|---|
| VM.Standard.A1.Flex (ARM) | 4 OCPUs + 24 GB RAM total, always free |
| Boot volume | 200 GB total across all instances |
| Network egress | 10 TB/month |

**No credit card is required** for an OCI Always Free account (though you can optionally upgrade to pay-as-you-go).

> ✅ **Why Oracle Cloud for this project:** The ARM instance gives 24 GB of RAM — enough to run 8–10 concurrent Claude sessions simultaneously. This is the best free-tier option for heavy use.

> ⚠️ **ARM capacity note:** Oracle's free ARM capacity is sometimes exhausted in popular regions. The provision script retries automatically until a slot opens (can take minutes to hours). You can press `Ctrl+C` and try again later, or pick a less-popular region.

---

## Prerequisites

### 1. Oracle Cloud account

1. Go to [cloud.oracle.com](https://cloud.oracle.com) and click **Start for free**.
2. Fill in your details. A phone number is required; a credit card is optional (choose "Always Free" to skip it).
3. After sign-up, go to the OCI Console: [cloud.oracle.com/sign-in](https://cloud.oracle.com/sign-in).

You'll need your **tenancy name** and **home region** — both shown in the top-right corner of the console.

### 2. OCI CLI

The `oci` command-line tool lets the setup script create the VM on your behalf.

```bash
# macOS
brew install oci-cli

# Linux / WSL
bash -c "$(curl -L https://raw.githubusercontent.com/oracle/oci-cli/master/scripts/install/install.sh)"
```

Or follow the [official installer](https://docs.oracle.com/en-us/iaas/Content/API/SDKDocs/cliinstall.htm).

Verify:
```bash
oci --version
# Should print: 3.X.X
```

### 3. Configure OCI CLI

Run the interactive setup wizard:

```bash
oci setup config
```

It will ask for:
- **User OCID** — find in the OCI console: top-right avatar → **My profile** → copy the OCID
- **Tenancy OCID** — find in: top-right menu → **Tenancy: your-name** → copy the OCID
- **Region** — your home region, e.g. `us-ashburn-1` or `ap-singapore-1`
- **Key pair** — press Enter to generate a new one (recommended)

After running, the wizard tells you to upload the generated public key to OCI:

1. Open the OCI console
2. Go to **Identity → Users → your user → API Keys → Add API Key**
3. Paste the content of `~/.oci/oci_api_key_public.pem`
4. Click **Add**

Verify the config works:
```bash
oci iam region list --output table
# Should print a list of OCI regions
```

### 4. SSH key

The script connects to the VM over SSH. If you don't have a key yet:

```bash
ssh-keygen -t ed25519 -C "oracle-claude"
# Press Enter three times to accept defaults
```

This creates `~/.ssh/id_ed25519` (private) and `~/.ssh/id_ed25519.pub` (public).

### 5. Install `jq`

The provision script uses `jq` to parse JSON responses from the OCI API.

```bash
# macOS
brew install jq

# Ubuntu/Debian
sudo apt-get install -y jq
```

### 6. Repo `.dev.vars` file

Open `.dev.vars` in the repo root and confirm these two lines exist:

```
WORKER_URL=https://claude-proxy.YOUR-ACCOUNT.workers.dev
PROXY_TOKEN=your-secret-token
```

---

## Step 1 — Create the VM

Run this from the repo root:

```bash
./scripts/oracle/provision-vm.sh
```

This script will:
1. Look up your tenancy OCID and region from `~/.oci/config`
2. Find the latest Ubuntu 22.04 ARM image
3. Create a VPC, Internet Gateway, subnet, and security rules (SSH in + all egress)
4. Launch a `VM.Standard.A1.Flex` instance (4 OCPU, 24 GB RAM) and retry until capacity is available
5. Wait for the VM to reach `RUNNING` state and for SSH to become available
6. Install Docker (useful for the Docker-based session approach if needed later)
7. Save the VM's IP to `scripts/oracle/.state/claude-discord-vm.env`

**Expected output:**
```
  Oracle Cloud — Provisioning Discord Bot VM
  Shape  : VM.Standard.A1.Flex (4 OCPU, 24 GB RAM)
  Name   : claude-discord-vm
  Region : us-ashburn-1

[oracle] Creating VCN...
[oracle] Creating Internet Gateway...
[oracle] Launching instance (VM.Standard.A1.Flex)...
[oracle] Public IP: 140.X.X.X
[oracle] SSH ready.
[oracle] Docker installed.

  VM ready.
  IP : 140.X.X.X
```

> **If capacity isn't available:** You'll see `Still waiting: Out of host capacity`. The script retries every 60 seconds automatically. This can take anywhere from 1 minute to a few hours depending on your region. You can press `Ctrl+C` and try a different region with `--region ap-osaka-1` (or any less-popular region).

> **To use a different region:** `./scripts/oracle/provision-vm.sh --region ap-osaka-1`

---

## Step 2 — Install the launcher daemon

```bash
./scripts/oracle/setup-launcher.sh
```

This script will:
1. Install Node.js 20, Claude Code, Python, `websockets`, and tmux on the VM
2. Copy the repo to the VM
3. Write a `.dev.vars` file on the VM with `LAUNCHER_TARGET=oracle`
4. Install and start the `claude-launcher` systemd service

**Expected output:**
```
[oracle] Installing prerequisites on VM...
[oracle] Syncing repo to ubuntu@140.X.X.X:~/claude-proxy/ ...
[oracle] Sync complete.
[oracle] Writing .dev.vars on VM...
[oracle] Installing claude-launcher systemd service...
  ✅ Launcher daemon is running.

  Setup complete.
  The daemon will now receive /oracle launch frames from Discord.
```

---

## Step 3 — Authenticate Claude Code (one-time)

SSH into the VM and log in to Claude Code:

```bash
# Open an SSH session on the VM
./scripts/oracle/provision-vm.sh --connect

# Inside the VM:
cd ~/claude-proxy
claude
# Log in with your Anthropic account in the browser that opens.
# Once done, press Ctrl+C to exit Claude.
exit
```

Credentials are saved to `~/.claude/` on the VM and reused by all future sessions.

---

## Step 4 — Verify everything is running

```bash
./scripts/oracle/setup-launcher.sh --status
```

You should see:
```
● claude-launcher.service - Claude Code Discord Session Launcher (oracle)
     Active: active (running) since ...
```

Watch the live connection log:

```bash
./scripts/oracle/setup-launcher.sh --logs
```

Look for:
```
target      : oracle  (LAUNCHER_TARGET)
Connected. Waiting for launch commands …
```

Press `Ctrl+C` to stop watching.

---

## Day-to-day management

```bash
# SSH into the VM
./scripts/oracle/provision-vm.sh --connect

# Check VM state + running sessions
./scripts/oracle/provision-vm.sh --status

# Watch daemon logs live
./scripts/oracle/setup-launcher.sh --logs

# Check daemon status
./scripts/oracle/setup-launcher.sh --status

# Push local code changes to the VM
./scripts/oracle/setup-launcher.sh --update

# On the VM — list running Claude sessions
tmux ls

# On the VM — attach to a running session
tmux attach -t cproxy_<session-id>

# On the VM — view session log
tail -f ~/.claude/discord-sessions/logs/<session-id>.log

# Destroy everything (VM + networking, permanent)
./scripts/oracle/provision-vm.sh --delete
```

---

## Troubleshooting

### "oci: command not found"
The OCI CLI isn't installed or isn't in your PATH. Try opening a new terminal after installation.

### "Could not read tenancy from ~/.oci/config"
The `oci setup config` step wasn't completed, or it wrote to a different file. Run `cat ~/.oci/config` to see what's there, then re-run `oci setup config`.

### "Out of host capacity" — keeps retrying forever
Oracle's free ARM capacity is genuinely exhausted in your region. Options:
- Leave the script running — capacity appears randomly as other users free up VMs
- Press `Ctrl+C` and try a different region: `--region eu-frankfurt-1`, `--region ap-osaka-1`, `--region me-jeddah-1`, etc.
- Check [Oracle's capacity availability dashboard](https://cloudharmony.com/speedtest-for-oracle) for region comparisons

### "SSH did not become available"
Wait 2 minutes and run `./scripts/oracle/provision-vm.sh --connect` — the VM may still be booting.

### The daemon logs show reconnection errors
Re-run `./scripts/oracle/setup-launcher.sh` to overwrite the `.dev.vars` on the VM with fresh values from your local `.dev.vars`.

### "Authentication error" when Claude tries to respond
Claude Code's login expired or was never set. Run:
```bash
./scripts/oracle/provision-vm.sh --connect
claude
# Log in again
```
