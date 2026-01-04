# Start an ephemeral Cloudflare Tunnel to your local server (port 9235)
# Requires cloudflared installed and available in PATH:
# https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/

Write-Host "Starting ephemeral Cloudflare Tunnel to http://localhost:9235"
Write-Host "If you want a stable hostname, follow the named-tunnel instructions in README_CLOUDFLARED.md"

# Run ephemeral tunnel (prints a public URL while running)
& cloudflared tunnel --url http://localhost:9235

# To stop: Ctrl+C in this window
# NOTE: Ephemeral tunnels are quick and easy for testing but the URL changes each run.
