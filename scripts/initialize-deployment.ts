import { readFileSync, writeFileSync } from 'node:fs';
import { connect } from '../packages/db/src/index.ts';
import { schema } from '../packages/db/src/schema.ts';
import { createTenant } from '../packages/db/src/tenants.ts';
import { id } from '../packages/core/src/index.ts';
import { dnsRecords } from '../packages/provider-ses/src/records.ts';
import { countHit } from '../apps/api/src/counters.ts';
const env=JSON.parse(readFileSync('.dispatch/environment.json','utf8'));
Object.assign(process.env,env);
const db=connect(env.DATABASE_DIRECT_URL);
try{
 await db.query(schema);
 const result=await db.query('select id from tenants');
 if(!result.rowCount && process.env.DISPATCH_ADMIN_EMAIL){
  const {randomBytes}=await import('node:crypto');const password=randomBytes(24).toString('base64url');
  const library=JSON.parse(readFileSync('packages/templates/library.json','utf8'));
  const created=await createTenant(db,{name:'SMW AI',email:process.env.DISPATCH_ADMIN_EMAIL,password,userName:'Stephen Walker',pepper:env.API_KEY_PEPPER,library});
  writeFileSync('.dispatch/credentials.json',JSON.stringify({...created,password},null,2),{mode:0o600});
  console.log('Initial admin created; credentials saved privately.');
 }
 const owner=await db.query('select id from tenants order by created_at limit 1');
 if(owner.rowCount){
  const aws=JSON.parse(readFileSync('.dispatch/aws.json','utf8'));
  const records=dnsRecords({name:'smw.ai',region:'us-west-2',tokens:aws.identity.DkimAttributes.Tokens});
  await db.query(`insert into domains (id,tenant_id,name,region,status,records,dkim_tokens,verify_started_at,sending,receiving) values ($1,$2,'smw.ai','us-west-2','pending',$3,$4,now(),'enabled','disabled') on conflict (tenant_id,name) do nothing`,[id('domain'),owner.rows[0].id,JSON.stringify(records),JSON.stringify(aws.identity.DkimAttributes.Tokens)]);
 }
 const key='verification:'+Date.now();const values=await Promise.all(Array.from({length:20},()=>countHit(db,key)));
 if(new Set(values).size!==20||Math.max(...values)!==20)throw new Error('Atomic counter verification failed');
 await db.query('delete from counters where key=$1',[key]);
 console.log('Neon schema and concurrent atomic counters verified.');
} finally {await db.end();}
