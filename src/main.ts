import { loadConfig } from "./config.js";
import { openDeps } from "./bootstrap.js";
import { createInsitioServer } from "./server.js";
import { countUsers } from "./services/users.js";

const config = loadConfig();
const deps = openDeps(config);
const server = createInsitioServer(deps);

server.listen(config.port, config.host, () => {
  const where = config.host ? `${config.host}:${config.port}` : `port ${config.port}`;
  console.log(`Insitio listening on ${where} for ${config.baseUrl} (data in ${config.dataDir})`);
  if (countUsers(deps.db) === 0) {
    console.log("No accounts yet. Create the first admin with: npm run admin:create -- <username>");
  }
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close();
    deps.db.close();
    process.exit(0);
  });
}
