import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';

const cesiumSource  = 'node_modules/cesium/Build/Cesium';
const cesiumBaseUrl = 'cesiumStatic';

export default defineConfig({
  define: {
    CESIUM_BASE_URL: JSON.stringify(`/${cesiumBaseUrl}/`),
  },

  plugins: [
    viteStaticCopy({
      targets: [
        { src: `${cesiumSource}/ThirdParty`, dest: cesiumBaseUrl },
        { src: `${cesiumSource}/Workers`,    dest: cesiumBaseUrl },
        { src: `${cesiumSource}/Assets`,     dest: cesiumBaseUrl },
        { src: `${cesiumSource}/Widgets`,    dest: cesiumBaseUrl },
      ],
    }),
  ],

  server: {
    host: true,   // expose on all network interfaces (0.0.0.0)
    port: 5173,
    fs: { allow: ['..'] },
    middlewareMode: false,
    proxy: {
      // ── Flight data providers ───────────────────────────────────────────
      '/api/localproxy': {
        target:      'http://localhost:3001',
        changeOrigin: true,
        rewrite:     path => path.replace(/^\/api\/localproxy/, ''),
      },
      '/api/airplaneslive': {
        target:      'https://api.airplanes.live',
        changeOrigin: true,
        rewrite:     path => path.replace(/^\/api\/airplaneslive/, ''),
      },
      '/api/adsbool': {
        target:      'https://api.adsb.lol',
        changeOrigin: true,
        rewrite:     path => path.replace(/^\/api\/adsbool/, ''),
      },
      '/api/opensky': {
        target:      'https://opensky-network.org',
        changeOrigin: true,
        rewrite:     path => path.replace(/^\/api\/opensky/, ''),
      },
      // ── Satellite TLE providers ─────────────────────────────────────────
      '/api/celestrak': {
        target:       'https://celestrak.org',
        changeOrigin: true,
        timeout:      15000,
        proxyTimeout: 15000,
        rewrite:      path => path.replace(/^\/api\/celestrak/, ''),
        onError:      (err, req, res) => {
          console.error('[proxy] CelesTrak error:', err.message);
          res.writeHead(502, { 'Content-Type': 'text/plain' });
          res.end('CelesTrak proxy timeout or unavailable — client will try direct fetch');
        },
      },
      '/api/spacetrack': {
        target:            'https://www.space-track.org',
        changeOrigin:      true,
        cookieDomainRewrite: 'localhost',
        rewrite:           path => path.replace(/^\/api\/spacetrack/, ''),
      },

      // ── OpenSky OAuth2 token endpoint ───────────────────────────────────────
      // auth.opensky-network.org sends no CORS headers — must proxy.
      '/api/opensky-auth': {
        target:      'https://auth.opensky-network.org',
        changeOrigin: true,
        rewrite:     path => path.replace(/^\/api\/opensky-auth/, ''),
      },

      // ── N2YO satellite API ──────────────────────────────────────────────────
      // api.n2yo.com sends no CORS headers — must proxy.
      '/api/n2yo': {
        target:      'https://api.n2yo.com',
        changeOrigin: true,
        rewrite:     path => path.replace(/^\/api\/n2yo/, ''),
      },

      // ── Google Routes API (traffic-aware polylines) ───────────────────────
      '/api/google-routes': {
        target:      'https://routes.googleapis.com',
        changeOrigin: true,
        rewrite:     path => path.replace(/^\/api\/google-routes/, ''),
      },
    },
  },

  optimizeDeps: {
    include: ['cesium'],
  },

  build: {
    chunkSizeWarningLimit: 10000,
    rollupOptions: {
      output: {
        manualChunks: { cesium: ['cesium'] },
      },
    },
  },
});
