// The web app's "Install locally" link: a fixed loopback port that opens this computer's local
// settings and redirects there. Only its own Host is answered, so a rebound DNS name can't reach
// it; when the port is taken nothing listens and the link stays dead.

import http from 'node:http'

export const SETTINGS_LINK_PORT = 47821
export function serveSettingsLink(open: () => Promise<{ url: string }>, port = SETTINGS_LINK_PORT): http.Server {
  const host = `127.0.0.1:${port}`
  const server = http.createServer(async (req, res) => {
    res.setHeader('cache-control', 'no-store')
    if (req.headers.host !== host) return void res.writeHead(403).end()
    if (req.method !== 'GET' || req.url !== '/settings') return void res.writeHead(404).end()
    try {
      res.writeHead(302, { location: (await open()).url }).end()
    } catch {
      res.writeHead(503).end()
    }
  })
  server.on('error', () => server.close())
  server.listen(port, '127.0.0.1')
  server.unref()
  return server
}
