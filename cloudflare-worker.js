/**
 * Cloudflare Worker — HTTPS Proxy to Kahoot Bot Server
 * 
 * Deploy this to Cloudflare Workers to get free HTTPS in front of your server.
 * 
 * SETUP:
 * 1. Go to https://dash.cloudflare.com/ → Workers & Pages → Create Application → Create Worker
 * 2. Replace the default code with this file's contents
 * 3. Click "Save and Deploy"
 * 4. Your worker URL will be: https://<worker-name>.<account>.workers.dev
 * 5. Use that URL instead of http://45.8.22.11:9235
 */

export default {
  async fetch(request, env, ctx) {
    // Your backend server (ngrok tunnel)
    const TARGET_ORIGIN = 'https://artiest-hypothalamic-genna.ngrok-free.dev';

    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Max-Age': '86400',
        }
      });
    }

    // Build target URL (preserve path + query string)
    const targetUrl = TARGET_ORIGIN + url.pathname + url.search;

    // Prepare headers (copy from original request, remove problematic ones)
    const headers = new Headers(request.headers);
    headers.delete('host');
    headers.delete('cf-connecting-ip');
    headers.delete('cf-ray');
    headers.delete('cf-visitor');
    headers.delete('cf-ipcountry');

    // Clone request for forwarding
    const newRequest = new Request(targetUrl, {
      method: request.method,
      headers: headers,
      body: request.method !== 'GET' && request.method !== 'HEAD'
        ? request.body
        : null,
      redirect: 'manual'
    });

    try {
      // Fetch from backend server
      const response = await fetch(newRequest);

      // Clone response headers and add CORS
      const responseHeaders = new Headers(response.headers);
      responseHeaders.set('Access-Control-Allow-Origin', '*');
      responseHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      responseHeaders.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

      // Return proxied response
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders
      });

    } catch (err) {
      // Handle errors (backend unreachable, etc.)
      return new Response(JSON.stringify({ error: 'Backend unreachable', details: err.message }), {
        status: 502,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }
  }
};
