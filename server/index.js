import { createApp } from './app.js';
const app = createApp();
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3400);
app.server.listen(port, host, () => {
  console.log(`Signal is running at http://${host}:${app.server.address().port}`);
  console.log(app.config.localDemo ? 'Local demo access token: local-demo-only (loopback only). No live messages are sent.' : 'Admin authentication enabled. Use your configured ADMIN_TOKEN.');
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => app.close().then(() => process.exit(0)));
