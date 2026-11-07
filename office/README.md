# Team Octorouter on the office machine

The same stack as the EC2 deployment (CLIProxyAPI, cliproxyapi-dashboard, Postgres, deploy webhook),
run on the office Ubuntu machine (2× RTX 3090) and reached by the team over **Tailscale**. Nothing is
exposed to the office network or the internet, and no AWS or domain is needed.

| | EC2 (`../README.md`) | Office (this folder) |
|---|---|---|
| Server | EC2 `t3.medium`, created by SST | This machine; Docker runs it at boot, no login needed |
| HTTPS | Caddy + Let's Encrypt on `octorouter.octinho.com` | `tailscale serve` on `<machine>.<tailnet>.ts.net` |
| API | `https://octorouter.octinho.com/v1` | `https://<machine>.<tailnet>.ts.net/v1` |
| Dashboard | `https://dashboard.octorouter.octinho.com` | `https://<machine>.<tailnet>.ts.net:8443` |
| Who can reach it | Anyone on the internet (API key required) | Only devices in your tailnet (API key still required) |
| Secrets | SST secrets | Generated once into `/opt/octorouter/.env` |
| Deploy webhook | Port 9000 on all interfaces, hidden by the security group | Port 9000 on the Docker bridge only |

The compose file, webhook files and config template are the unchanged files from `../services/`.
`docker-compose.override.yml` holds the office differences and is loaded automatically from
`/opt/octorouter`. GPUs are not used: the router only forwards requests.

---

## 1. One-time setup

1. **Create a Tailscale account** at https://login.tailscale.com (free for small teams; check the
   current user limits on their pricing page).
2. In the Tailscale admin console, **DNS** page: turn on **MagicDNS** and **HTTPS Certificates**.
3. On this machine, from the repo:
   ```bash
   git clone https://github.com/barrie-davies/octorouter-config.git ~/octorouter-config
   sudo ~/octorouter-config/office/bootstrap.sh
   ```
   It installs Docker and Tailscale if missing, asks you to sign the machine in to Tailscale (open the
   URL it prints), then starts everything. At the end it prints the API and dashboard URLs and the
   **first client key** (yours). Keep that output.
4. **Stop the machine sleeping**, or the router goes down with it:
   ```bash
   sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
   ```
5. Open the dashboard URL, sign in, and **connect the provider accounts or API keys** the team will
   share (Claude, Gemini, Codex, ...). See "Claude Max OAuth" and "Gemini OAuth" in `../README.md`; for
   Gemini on this machine, run the `docker run ... -login -no-browser` command locally, without the SSH
   tunnel. Note that sharing a personal consumer subscription across a team may break that plan's
   terms; API keys or team plans are the safe option.
6. Check it from any tailnet device:
   ```bash
   curl -H "Authorization: Bearer <client key>" https://<machine>.<tailnet>.ts.net/v1/models
   ```

Re-running `bootstrap.sh` is safe: it refreshes files from the repo and keeps `.env`, `config.yaml`
and the stored logins.

---

## 2. Adding a teammate

1. **Tailscale access.** Invite them to your tailnet (admin console → Users → Invite), or share just
   this machine with them (Machines → this machine → Share). They install Tailscale and sign in.
   Then, in **Access controls**, limit teammates to TCP ports **443 and 8443** on this machine, so they
   can't reach anything else on it (SSH, other services).
2. **Their own API key.** Generate one and add it to the `api-keys:` list, with their name as a comment:
   ```bash
   echo "sk-team-$(openssl rand -hex 24)"
   sudo nano /opt/octorouter/config.yaml
   cd /opt/octorouter && sudo docker compose restart cliproxyapi
   ```
   ```yaml
   api-keys:
     - "sk-team-..."  # admin (first key)
     - "sk-team-..."  # alice
   ```
   To remove someone, delete their line and restart `cliproxyapi`.
3. **Their opencode config.** Same as the old team setup: they put the key in their shell as
   `OCTOROUTER_API_KEY`, and the `cliproxyapi` provider in the team's `~/.config/opencode/opencode.json`
   points at the new address:
   ```json
   "cliproxyapi": {
     "npm": "@ai-sdk/openai-compatible",
     "name": "CLIProxyAPI",
     "options": {
       "baseURL": "https://<machine>.<tailnet>.ts.net/v1",
       "apiKey": "{env:OCTOROUTER_API_KEY}"
     }
   }
   ```

Every key draws on the same connected provider accounts; there are no per-person quotas. To limit
spend, set limits at the provider (for example on an API key).

---

## 3. Running it

Everything lives in `/opt/octorouter` (same layout as EC2), so the maintenance steps in
`../README.md` apply as written, with `sudo` and without SSH:

```bash
cd /opt/octorouter
sudo docker compose ps
sudo docker compose logs -f cliproxyapi
sudo systemctl status octorouter-webhook
tailscale serve status
```

- **Updating CLIProxyAPI:** from the dashboard, as in `../README.md`. Afterwards bump the image tag in
  `services/docker-compose.yml`, commit, pull on the office machine, and re-run `bootstrap.sh`.
- **Management key** (dashboard and `/management.html` admin login):
  `sudo sed -n 's/^MANAGEMENT_API_KEY=//p' /opt/octorouter/.env`
- **Back up** `/opt/octorouter/.env`, `config.yaml` and `auths/`. They hold every secret and provider login.

## 4. Removing it

```bash
tailscale serve reset
cd /opt/octorouter && sudo docker compose down        # add -v to also delete the database
sudo systemctl disable --now octorouter-webhook
sudo rm /etc/systemd/system/octorouter-webhook.service
```
Then delete `/opt/octorouter` if you no longer need the logins and keys in it.
