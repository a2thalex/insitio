// Usage: npm run admin:create -- <username> [email]
// Creates a site admin (or promotes and resets an existing user) and prints a one-time password.
import { openDeps } from "../bootstrap.js";
import { randomToken } from "../auth/tokens.js";
import { createUser, getUserByName, setAdmin, setPassword } from "../services/users.js";

const [username, email = ""] = process.argv.slice(2);
if (!username) {
  console.error("Usage: npm run admin:create -- <username> [email]");
  process.exit(1);
}

const { db, config } = openDeps();
const password = randomToken(12);
const existing = getUserByName(db, username);
if (existing) {
  setAdmin(db, existing.id, true);
  setPassword(db, existing.id, password);
  console.log(`Promoted ${existing.username} to site admin and reset their password.`);
} else {
  createUser(db, { username, password, email, isAdmin: true });
  console.log(`Created site admin ${username}.`);
}
console.log(`\n  Sign in at ${config.baseUrl}/login`);
console.log(`  Username: ${username}`);
console.log(`  Password: ${password}\n`);
console.log("This password is shown once. Change it under Settings > Password.");
