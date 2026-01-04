Cloudflared setup — quick guide

Overview
- Use Cloudflare Tunnel (cloudflared) to expose your local `server.js` (listening on port 9235) over HTTPS.
- Two fast options: Ephemeral tunnel (quick, changing URL) or Named tunnel (persistent hostname via your Cloudflare zone).

1) Ephemeral tunnel (fastest)
- Install `cloudflared` for Windows: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/
- Run the helper script in this repo:

```powershell
.\\\looder\\kahoot\\cloudflared-start.ps1
```

- `cloudflared` will print a public URL (https://XXXXX.trycloudflare.com or a similar hostname) while it runs. Use that URL in your browser or for the UI.

Notes:
- Ephemeral URLs change every run and are intended for quick testing.
- You do not need the Cloudflare Worker if you use cloudflared directly.

2) Named tunnel (persistent, recommended for production)
- Authenticate and create a tunnel (one-time):

```powershell
# Install cloudflared and login (opens a browser to authenticate)
cloudflared login

# Create a named tunnel (outputs a tunnel UUID)
cloudflared tunnel create my-kahoot-tunnel
```

- This creates a credentials file under %USERPROFILE%\.cloudflared. Copy the tunnel UUID and edit `cloudflared-config.yml` in this repo: set `tunnel:` to the UUID and set `credentials-file:` path to the JSON file created.

- Create a DNS CNAME in your Cloudflare dashboard (DNS) pointing the hostname you want (e.g., `kahoot.example.com`) to `tunnel.cloudflare.com` as documented in Cloudflare docs.

- Start the named tunnel with your config:

```powershell
# From the directory with your config.yml or specify --config
cloudflared tunnel run my-kahoot-tunnel
```

3) Security and notes
- `/api/spawn` executes server-side processes; restrict access before exposing publicly. Add a simple Bearer token or IP allowlist in `server.js` if exposing over the internet.

- Example quick restriction: add a header check for `x-spawn-token` and compare against a secret env var before starting spawn.

4) Using with this repo
- Run your server locally on port 9235:

```powershell
node server.js
```

- Start an ephemeral tunnel (quick test):

```powershell
.\\cloudflared-start.ps1
```

- Or set up a named tunnel for a stable hostname. See `cloudflared-config.yml` for an example.

5) When to use Cloudflare Worker vs cloudflared vs ngrok
- Use cloudflared when you control a Cloudflare account or want a secure, persistent tunnel integrated with Cloudflare DNS.
- Use ephemeral cloudflared for quick testing (no Cloudflare DNS required).
- Use Cloudflare Worker only if you want a Worker-based proxy/front with custom logic; not necessary if cloudflared exposes your service directly.
- Use ngrok if you prefer ngrok's tooling — both are valid; cloudflared integrates better with Cloudflare DNS and firewall features.

If you want, I can:
- Add a minimal env-check to `server.js` to require an `X-SPAWN-TOKEN` header for `/api/spawn`.
- Create a sample PowerShell script to run the named-tunnel flow step-by-step.
