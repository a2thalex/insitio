// Usage: npm run invite:create -- [days]
// Prints a single-use sign-up link, created on behalf of the first site admin.
import { openDeps } from "../bootstrap.js";
import { createInvite, listUsers } from "../services/users.js";

const days = Number(process.argv[2] ?? 7);
const { db, config } = openDeps();
const admin = listUsers(db).find((u) => u.isAdmin);
if (!admin) {
  console.error("No site admin exists yet. Run: npm run admin:create -- <username>");
  process.exit(1);
}
const token = createInvite(db, admin.id, days);
console.log(`Invite link (single use, expires in ${days} days):\n\n  ${config.baseUrl}/join/${token}\n`);
