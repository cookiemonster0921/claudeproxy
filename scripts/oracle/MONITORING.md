# VM Resource Monitoring — What Costs Money and How to Measure It

How to observe CPU, RAM, network, and disk usage on an OCI (or any Linux) VM while running Docker containers. Covers both live inspection and ongoing cost tracking.

---

## What OCI charges for (and what's free)

On OCI Always Free, **nothing below costs money** as long as you stay within the limits. This guide helps you verify you're within them.

| Resource | Always Free limit | Charged if exceeded |
|---|---|---|
| Compute (ARM A1.Flex) | 4 OCPU + 24 GB RAM | Per OCPU-hour + per GB-hour |
| Boot volume | 200 GB total | Per GB-month |
| Network egress | 10 TB/month | Per GB after limit |
| Public IPs | 2 reserved | Per IP-hour after limit |

---

## 1. Container-level resource usage

### Live stats for all running containers

```bash
# Single snapshot (non-interactive)
docker stats --no-stream

# Live updating (Ctrl-C to stop)
docker stats

# Specific container
docker stats --no-stream discord-session-1510193804525961326
```

**Output columns explained:**

| Column | What it means | Relevant to cost? |
|---|---|---|
| `CPU %` | % of one host CPU core used | Indirectly (OCPU billing) |
| `MEM USAGE / LIMIT` | Working set / host RAM limit | Yes — RAM billing |
| `MEM %` | Fraction of host RAM used | Yes |
| `NET I/O` | Bytes in/out since container start | Yes — egress billing |
| `BLOCK I/O` | Disk reads/writes since start | Indirectly (disk wear) |
| `PIDS` | Number of processes inside | No |

**Example output for a claude-discord session:**
```
NAME                               CPU %   MEM USAGE / LIMIT    MEM %   NET I/O       BLOCK I/O
discord-session-1510193804525961  1.18%   155.6MiB / 7.65GiB  1.99%   2.1MB / 890kB  0B / 0B
```

---

### Memory breakdown per process inside a container

```bash
# All processes in a container with their RSS
docker exec discord-session-CHANNEL_ID sh -c '
for pid in /proc/[0-9]*/status; do
  name=$(grep "^Name:" "$pid" 2>/dev/null | awk "{print \$2}")
  rss=$(grep "^VmRSS:" "$pid" 2>/dev/null | awk "{print \$2}")
  [ -n "$rss" ] && printf "%-25s %8s kB\n" "$name" "$rss"
done | sort -k2 -rn
'
```

```bash
# Total RSS across all processes in the container
docker exec discord-session-CHANNEL_ID sh -c '
total=0
for pid in /proc/[0-9]*/status; do
  rss=$(grep "^VmRSS:" "$pid" 2>/dev/null | awk "{print \$2}")
  [ -n "$rss" ] && total=$((total + rss))
done
echo "Total RSS: $((total / 1024)) MB"
'
```

> **Note:** RSS from `/proc` double-counts shared libraries. `docker stats` reports the real working set and is the accurate number.

---

### Network I/O per container (since container start)

```bash
docker stats --no-stream --format "table {{.Name}}\t{{.NetIO}}" | grep discord
```

To see the raw counter from inside the container:

```bash
# Inbound and outbound bytes for the container's network interface
docker exec discord-session-CHANNEL_ID sh -c '
cat /proc/net/dev | awk "NR>2 {
  printf \"%-10s  RX: %s bytes  TX: %s bytes\n\", \$1, \$2, \$10
}"
'
```

---

## 2. Host VM resource usage (SSH into the VM)

SSH to the Oracle VM first:
```bash
./scripts/oracle/provision-vm.sh --connect
# or:
./scripts/oracle/deploy-session.sh ssh
```

### CPU — all cores, per-process

```bash
# Top-level CPU view, refreshing every 2 seconds
top -d 2

# Better formatting with per-core breakdown
htop
# (install if needed: sudo apt install htop)

# One-shot snapshot sorted by CPU
ps aux --sort=-%cpu | head -20

# Per-core utilisation (shows if workload is distributed)
mpstat -P ALL 1 3
# (install: sudo apt install sysstat)
```

**What to look for:** Claude Code sessions are mostly idle (waiting on network). CPU should be <5% per session during normal use. Spikes to 20–40% during active tool execution are normal and brief.

---

### RAM — total, used, free, swap

```bash
# Human-readable overview (updates every second)
watch -n 1 free -h

# Detailed breakdown including buffers and cache
free -h

# Per-process memory sorted by RSS
ps aux --sort=-%mem | head -20

# See if the kernel is swapping (swap used = memory pressure)
vmstat 1 5
# si/so columns: swap-in / swap-out per second. Nonzero = under pressure.

# Which containers are using the most RAM
docker stats --no-stream --format "table {{.Name}}\t{{.MemUsage}}\t{{.MemPerc}}" | sort -k3 -rn
```

**Interpreting `free -h`:**
```
              total   used    free    shared  buff/cache  available
Mem:           23Gi   2.1Gi  19.3Gi   45Mi     1.8Gi      20.9Gi
Swap:            0B      0B      0B
```
- `available` is the number that matters — what new processes can use
- `buff/cache` is disk cache the OS will free if needed — not "wasted"
- No swap (`0B`) is normal and fine; swap appearing means RAM pressure

---

### Disk — usage and I/O

```bash
# Disk space used on all mounted filesystems
df -h

# Docker's total disk consumption (images + volumes + containers)
docker system df

# Breakdown: images, volumes, containers separately
docker system df -v

# Which Docker volumes are biggest
docker system df -v | grep -A 30 "VOLUME NAME"

# Live disk I/O (reads/writes per second)
iostat -x 1 5
# (install: sudo apt install sysstat)

# Per-process disk I/O
iotop
# (install: sudo apt install iotop)
```

**Docker disk usage explained:**
```
TYPE            TOTAL     ACTIVE    SIZE      RECLAIMABLE
Images          3         2         2.1GB     800MB (reclaimable)
Containers      5         3         12MB      0B
Local Volumes   6         3         450MB     200MB (reclaimable)
Build Cache     0         0         0B        0B
```

Free unused images and stopped containers:
```bash
docker system prune
# or aggressively (removes all unused images, not just dangling):
docker system prune -a
```

---

### Network egress — the critical billing metric

OCI free tier gives 10 TB/month of egress. This is generous, but good to track.

```bash
# Total bytes sent/received on the primary network interface since boot
ip -s link show ens3    # interface name varies; use `ip link` to find yours

# Or use:
cat /proc/net/dev
# 'eth0' or 'ens3' row: columns 2=RX bytes, 10=TX bytes

# Nicely formatted bandwidth monitor (install: sudo apt install nload)
nload ens3

# More detailed: per-connection traffic (install: sudo apt install nethogs)
sudo nethogs ens3

# Real-time bandwidth per process
sudo iftop -i ens3
# (install: sudo apt install iftop)
```

**Track egress over time with a simple daily log:**
```bash
# Add to crontab: crontab -e
# 0 0 * * * cat /proc/net/dev | grep ens3 | awk '{print strftime("%Y-%m-%d"), $10}' >> ~/egress-log.txt
```

**Check egress in OCI Console:**
1. Oracle Cloud Console → Networking → Virtual Cloud Networks → your VCN
2. Or: Observability & Management → Metrics Explorer
3. Metric: `VnicBytesFromNetwork` (ingress) / `VnicBytesToNetwork` (egress)

---

### All-in-one monitoring (no install required)

```bash
# Everything in one screen: CPU, RAM, processes, I/O
top

# Press these keys in top:
# M  — sort by memory usage
# P  — sort by CPU usage
# 1  — show per-core CPU
# c  — show full command line
# q  — quit
```

---

## 3. Per-container resource limits (enforce quotas)

By default Docker containers have no limits and can use all host RAM and CPU. To enforce limits on a Discord session:

```bash
# Limit a session to 512 MB RAM and 1 CPU core
docker run -d -i \
  --name discord-session-CHANNEL_ID \
  --memory 512m \
  --memory-swap 512m \    # same as memory = no swap
  --cpus 1.0 \
  ...rest of flags...
  claude-discord
```

To update limits on a running container:
```bash
docker update \
  --memory 512m \
  --memory-swap 512m \
  --cpus 1.0 \
  discord-session-CHANNEL_ID
```

Check current limits:
```bash
docker inspect discord-session-CHANNEL_ID | jq '.[0].HostConfig | {
  Memory,
  MemorySwap,
  NanoCpus,
  CpuQuota,
  CpuPeriod
}'
# Memory: 0 means unlimited
# NanoCpus: 1000000000 = 1 CPU core
```

---

## 4. Continuous monitoring with a one-liner dashboard

Run this on the Oracle VM to get a live view of all sessions:

```bash
watch -n 5 '
echo "=== $(date) ==="
echo ""
echo "HOST"
free -h | grep Mem
echo ""
echo "SESSIONS"
docker stats --no-stream --format \
  "  {{.Name}}  CPU={{.CPUPerc}}  MEM={{.MemUsage}}  NET={{.NetIO}}"
echo ""
echo "DISK"
df -h / | tail -1
docker system df 2>/dev/null | tail -3
'
```

---

## 5. OCI Console metrics (browser)

OCI provides free built-in metrics for compute instances:

1. **OCI Console** → Compute → Instances → your instance → **Metrics** tab
2. Key charts:
   - `CpuUtilization` — % of allocated OCPUs used
   - `MemoryUtilization` — % of allocated RAM used (requires OCI Monitoring agent)
   - `NetworksBytesIn` / `NetworksBytesOut` — cumulative egress/ingress
   - `DiskBytesRead` / `DiskBytesWritten` — disk I/O

3. For egress specifically: **Networking → Virtual Cloud Networks → your VCN → Flow Logs** (enable once, stored in Object Storage).

---

## 6. Quick reference — commands that matter most

```bash
# What's using RAM right now?
docker stats --no-stream

# Is the VM running out of memory?
free -h

# How much disk has Docker consumed?
docker system df

# Am I sending a lot of network traffic?
ip -s link show ens3 | grep -A2 TX

# Which session is most active?
docker stats --no-stream --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}" | sort -k3 -rn

# Kill a runaway container using too much RAM
docker stats --no-stream  # identify the name
docker stop discord-session-CHANNEL_ID

# Reclaim disk space from stopped containers and unused images
docker system prune -a
```
