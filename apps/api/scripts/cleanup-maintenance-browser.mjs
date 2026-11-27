// Recovery helper for interrupted browser verification. No argument = read-only listing.
import assert from 'node:assert/strict';
process.env.DATABASE_URL=process.env.TEST_DATABASE_URL??'postgresql://aeropulse_test:aeropulse_test@127.0.0.1:55432/aeropulse_test?schema=public';
const url=new URL(process.env.DATABASE_URL);
assert.equal(url.hostname,'127.0.0.1');assert.equal(url.pathname,'/aeropulse_test');
const {createDb}=await import('../dist/db.js');
const db=createDb();
try {
  const id=process.argv[2];
  if(!id){console.log(JSON.stringify(await db.logicalSystem.findMany({where:{OR:[{code:{startsWith:'Browser-'}},{code:{startsWith:'BROWSER-'}}]},select:{id:true,code:true,createdAt:true}}))); }
  else {
    const system=await db.logicalSystem.findUniqueOrThrow({where:{id},include:{devices:true}});
    assert.ok(/^BROWSER-/i.test(system.code));
    assert.ok(system.devices.every(device=>device.code.startsWith(system.code)&&['Browser primary','Browser standby'].includes(device.name)));
    const where={systemId:id};
    await db.workOrderChecklistItem.deleteMany({where:{workOrder:where}});await db.workOrderPartUsage.deleteMany({where:{workOrder:where}});await db.workOrderStatusHistory.deleteMany({where:{workOrder:where}});
    await db.maintenanceWorkOrder.deleteMany({where});await db.maintenancePlan.deleteMany({where});await db.failoverEvent.deleteMany({where});
    await db.alarm.deleteMany({where:{device:where}});await db.faultDiagnosis.deleteMany({where:{device:where}});await db.telemetryReading.deleteMany({where:{device:where}});await db.heartbeat.deleteMany({where:{device:where}});
    await db.device.deleteMany({where});await db.logicalSystem.delete({where:{id}});
    console.log('Removed only isolated browser fixture '+system.code+' ('+id+'). It can be recreated by the verification script.');
  }
} finally {await db.$disconnect();}
