import http from 'node:http';
import { createApp, loadConfig } from './app.js';

const cfg = loadConfig();
const app = createApp(cfg);
app.startJobs();

const server = http.createServer((req, res) => {
  app.handle(req, res);
});
server.headersTimeout = 20000;
server.requestTimeout = 30000;
server.listen(cfg.PORT, () => {
  console.log(`AppointmentDock listening on :${cfg.PORT} (base ${cfg.APP_URL})`);
  console.log(`Email ${app.notifier.emailOn ? 'on' : 'off'}, SMS ${app.notifier.smsOn ? 'on' : 'off'}`);
});

function shutdown() {
  server.close(() => { app.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
