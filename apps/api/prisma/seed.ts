import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });

const systems = [
  ['RADAR', 'Radar System'],
  ['VHF', 'VHF Communication System'],
  ['ILS', 'Instrument Landing System'],
  ['DME', 'DME System'],
  ['AMSS', 'AMSS Server'],
  ['AUTOMATION', 'Automation Server'],
  ['ASMGCS', 'ASMGCS Server'],
  ['NETWORK', 'Network Infrastructure'],
  ['UPS', 'UPS System'],
  ['COOLING', 'Cooling System'],
] as const;

try {
  for (const [code, name] of systems) {
    const system = await db.logicalSystem.upsert({
      where: { code },
      update: {},
      create: { code, name },
    });
    await db.device.upsert({
      where: { code: `${code}-P` }, update: {},
      create: { code: `${code}-P`, name: `${name} Primary`, role: 'PRIMARY', activationState: 'ACTIVE', systemId: system.id },
    });
    await db.device.upsert({
      where: { code: `${code}-S` }, update: {},
      create: { code: `${code}-S`, name: `${name} Secondary`, role: 'SECONDARY', activationState: 'STANDBY', systemId: system.id },
    });
  }
  console.log('Ensured 10 simulated systems and 20 devices (existing systems unchanged)');
} finally {
  await db.$disconnect();
}
