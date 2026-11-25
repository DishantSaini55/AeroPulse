import bcrypt from 'bcrypt';
import { jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';
import type { Database } from './db.js';
import type { UserRole } from './generated/prisma/enums.js';

export type PublicUser = { id: string; email: string; name: string; role: UserRole; active: boolean };
export type AuthProvider = {
  login(email: string, password: string): Promise<{ token: string; user: PublicUser } | null>;
  verifyToken(token: string): Promise<PublicUser | null>;
};

const emailSchema = z.email().max(254);
export const passwordSchema = z.string().min(12).refine(value => Buffer.byteLength(value, 'utf8') <= 72, 'Password must be at most 72 UTF-8 bytes');
export const normalizeEmail = (email: string) => email.trim().toLowerCase();

export function requireJwtSecret() {
  const value = process.env.JWT_SECRET;
  if (!value || Buffer.byteLength(value, 'utf8') < 32) throw new Error('JWT_SECRET must contain at least 32 bytes');
  return value;
}

export class AuthService implements AuthProvider {
  private readonly key: Uint8Array;
  private readonly dummyHash = bcrypt.hash('not-a-real-password', 12);

  constructor(private readonly db: Database, secret: string) {
    if (Buffer.byteLength(secret, 'utf8') < 32) throw new Error('JWT secret is too short');
    this.key = new TextEncoder().encode(secret);
  }

  async login(email: string, password: string) {
    const normalized = normalizeEmail(email);
    if (!emailSchema.safeParse(normalized).success) return null;
    const user = await this.db.user.findUnique({ where: { email: normalized } });
    const matches = await bcrypt.compare(password, user?.passwordHash ?? await this.dummyHash);
    if (!user || !user.active || !matches) return null;
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(user.id)
      .setIssuedAt()
      .setIssuer('aeropulse')
      .setAudience('aeropulse-web')
      .setExpirationTime('8h')
      .sign(this.key);
    return { token, user: this.publicUser(user) };
  }

  async verifyToken(token: string): Promise<PublicUser | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        algorithms: ['HS256'], issuer: 'aeropulse', audience: 'aeropulse-web',
      });
      if (!payload.sub) return null;
      const user = await this.db.user.findUnique({ where: { id: payload.sub } });
      return user?.active ? this.publicUser(user) : null;
    } catch {
      return null;
    }
  }

  private publicUser(user: PublicUser & { passwordHash?: string }): PublicUser {
    return { id: user.id, email: user.email, name: user.name, role: user.role, active: user.active };
  }
}
