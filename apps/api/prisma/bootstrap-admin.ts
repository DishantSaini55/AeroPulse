import 'dotenv/config';
import bcrypt from 'bcrypt';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { normalizeEmail, passwordSchema } from '../src/auth.js';
import { z } from 'zod';

const url = process.env.DATABASE_URL;
const email = normalizeEmail(process.env.BOOTSTRAP_ADMIN_EMAIL ?? '');
const password = process.env.BOOTSTRAP_ADMIN_PASSWORD ?? '';
if (!url) throw new Error('DATABASE_URL is required');
if (!z.email().safeParse(email).success || !passwordSchema.safeParse(password).success) {
  throw new Error('Set a valid BOOTSTRAP_ADMIN_EMAIL and a password of 12–72 UTF-8 bytes in your ignored local .env');
}
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
try {
  const existing = await db.user.count({ where: { role: 'ADMINISTRATOR' } });
  if (existing) throw new Error('An administrator already exists; bootstrap is disabled');
  await db.user.create({
    data: { email, name: 'Administrator', role: 'ADMINISTRATOR', passwordHash: await bcrypt.hash(password, 12) },
  });
  console.log(`Administrator created for ${email}. Remove BOOTSTRAP_ADMIN_PASSWORD from .env now.`);
} finally {
  await db.$disconnect();
}
