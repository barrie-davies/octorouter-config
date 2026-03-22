# OctoRouter

OctoRouter is an EC2-based proxy for Claude and Gemini models. It uses CLIProxyAPI to manage multiple OAuth accounts and provides a unified OpenAI-compatible API, along with a management dashboard.

## Services

| Service | Port | Description |
|---|---|---|
| postgres | — | PostgreSQL 16 database for the dashboard |
| cliproxyapi | 8317 | OpenAI/Gemini/Claude proxy for CLI OAuth sessions |
| docker-proxy | — | Restricted Docker socket proxy for container management |
| dashboard | 3000 | Web UI for managing CLIProxyAPI |
| caddy | 80, 443 | Reverse proxy with automatic HTTPS |

## SST Deployment

### Prerequisites
- AWS profile configured
- SST installed
- `bun install` run in the repository root

### Secrets Setup
Before deploying, you must set the following secrets for the `ops` stage:

```bash
sst secret set OctoRouterSshPublicKey "ssh-ed25519 ..." --stage ops
sst secret set OctoRouterSshAllowedCidr "1.2.3.4/32" --stage ops
sst secret set OctoRouterPostgresPassword "$(openssl rand -hex 32)" --stage ops
sst secret set OctoRouterJwtSecret "$(openssl rand -base64 32)" --stage ops
sst secret set OctoRouterManagementApiKey "$(openssl rand -hex 32)" --stage ops
```

### Deploy Command
Deploy the stack to the `ops` stage:

```bash
sst deploy --config apps/octorouter/sst.config.ts --stage ops
```

## Post-Deploy Setup

### 1. SSH into instance
Connect to the OctoRouter instance using the `ec2-user`:

```bash
ssh ec2-user@octorouter.octopws.io
```

### 2. Set up config.yaml
Navigate to the application directory and create your configuration file from the template:

```bash
cd /opt/octorouter
cp config.example.yaml config.yaml
```

Edit `config.yaml` to set your secrets:
- **Management Secret**: Use the same value as `OctoRouterManagementApiKey`.
- **API Keys**: Generate at least one API key for clients to connect.
  ```bash
  openssl rand -hex 32
  ```

### 3. Restart services
Apply the configuration changes by restarting the Docker containers:

```bash
docker compose down && docker compose up -d
```

### 4. Verify API is running
Check if the API is responding correctly using your newly generated API key:

```bash
curl -H "Authorization: Bearer YOUR_API_KEY" https://octorouter.octopws.io/v1/models
```

### 5. Dashboard access
The dashboard is available at: https://dashboard.octorouter.octopws.io

## Claude Max OAuth
Claude OAuth requires an interactive browser flow. Since the instance is remote, you must use an SSH tunnel to handle the callback on your local machine.

1. **Open SSH Tunnel**: In a new terminal on your local machine, run:
   ```bash
   ssh -L 54545:localhost:54545 ec2-user@octorouter.octopws.io
   ```
2. **Run OAuth Command**: Back on the EC2 instance, execute the OAuth flow inside the container:
   ```bash
   docker exec -it cliproxyapi /CLIProxyAPI claude auth
   ```
3. **Complete in Browser**: Follow the URL provided in the terminal, log in to Claude, and complete the authorization. The callback will be handled via the SSH tunnel.

## Gemini OAuth
Similar to Claude, Gemini OAuth requires an SSH tunnel for the callback.

1. **Open SSH Tunnel**: In a new terminal on your local machine, run:
   ```bash
   ssh -L 8085:localhost:8085 ec2-user@octorouter.octopws.io
   ```
2. **Run OAuth Command**: On the EC2 instance, execute:
   ```bash
   docker exec -it cliproxyapi /CLIProxyAPI gemini auth
   ```
3. **Complete in Browser**: Follow the URL, log in to your Google account, and authorize the application.

## Maintenance

### Update Image
To update to the latest version of CLIProxyAPI:

```bash
cd /opt/octorouter
docker compose pull && docker compose up -d
```

### Check Logs
View real-time logs for troubleshooting:

```bash
docker compose logs -f cliproxyapi
```

## Troubleshooting

### Caddy Certificate Issues
If HTTPS is not working, check Caddy logs:
```bash
docker compose logs caddy
```
Ensure port 80 and 443 are open in the EC2 Security Group for Let's Encrypt challenges.

### OAuth Callback Fails
- Ensure the SSH tunnel is active on the correct port (54545 for Claude, 8085 for Gemini).
- Check that no other service is using those ports on your local machine.

### Containers Not Starting
Check the status of the containers:
```bash
docker compose ps
```
If a container is in a restart loop, check its logs for configuration errors in `config.yaml`.

## EC2 Directory Layout
```
/opt/octorouter/
├── .env              # generated from SST secrets — never edit manually
├── docker-compose.yml
├── Caddyfile
├── config.yaml       # edit this manually after deploy
├── config.example.yaml
├── auths/            # CLIProxyAPI OAuth tokens
└── logs/             # container logs
```
