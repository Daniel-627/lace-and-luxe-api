import "dotenv/config";
import { db } from "../src/lib/db.js";
import { hashPassword, tempPassword } from "../src/lib/password.js";

const [email, ...rest] = process.argv.slice(2);
if (!email || !email.includes("@")) {
  console.error('Usage: npm run create-owner -- you@example.com "Your Name"');
  process.exit(1);
}
const name = rest.join(" ") || "Owner";
const password = tempPassword();
const passwordHash = await hashPassword(password);

await db.staff.upsert({
  where: { email: email.toLowerCase() },
  update: { passwordHash, role: "OWNER", active: true, name, mustChangePassword: true },
  create: { email: email.toLowerCase(), name, passwordHash, role: "OWNER", mustChangePassword: true },
});
console.log(`\nOwner ready: ${email.toLowerCase()}\nTemporary password (shown once): ${password}\nChange it after your first sign-in.\n`);
await db.$disconnect();
