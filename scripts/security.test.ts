import type {} from "../apps/api/src/server.js";
import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import Fastify from "../apps/api/node_modules/fastify/fastify.js";
import { presentEvent, presentLog, logBodies } from "../apps/api/src/logs.js";
import { presentFired } from "../apps/api/src/events.js";
import { presentRunDetail } from "../apps/api/src/automations.js";
import { registerPlatform } from "../apps/api/src/platform.js";
import { publishRoute53 } from "../packages/provider-ses/src/route53.js";
import { readSignedFile } from "../packages/storage/src/index.js";
import { hashPassword, id, seal } from "../packages/core/src/index.js";
import { connect, migrate, tx, acceptEmail } from "../packages/db/src/index.js";
import { cleanStorage } from "../apps/worker/src/storage.js";
import { applyInbound } from "../apps/worker/src/inbound.js";
import { pruneInboundDeliveries } from "../packages/db/src/inbound/deliveries.js";

test("Viewer presenters redact nested credentials and capability URLs", () => {
  const payload = { nested: { token: "sentinel", endpoint: "https://hooks.example/private?sig=sentinel", urls: ["https://files.example/private?sig=sentinel"] } };
  const log = presentLog({ id: "log", created_at: new Date(), path: "/webhooks", method: "POST", status: 200, response_body: payload }, true, true);
  const fired = presentFired({ id: "evt", name: "example", data: payload } as any, true);
  const run = presentRunDetail({ event_data: payload } as any, [], true);
  for (const shown of [log, fired, run]) assert.equal(JSON.stringify(shown).includes("sentinel"), false);
  assert.deepEqual(presentEvent(payload, false), payload);
  for (const route of ["/shared/:token", "/unsubscribe/:token"]) {
    assert.deepEqual(logBodies({ method: "GET", route, body: null, responseText: JSON.stringify(payload) }), { request_body: null, response_body: null });
  }
});

test("Route53 writes require an independently assigned zone, and authorized publishing works", async () => {
  let writes = 0;
  const client = { send: async (command: any) => {
    if (command.constructor.name === "ListHostedZonesByNameCommand") return { HostedZones: [{ Id: "/hostedzone/ZOWNER", Name: "example.com." }] };
    writes++; return {};
  } };
  const input = { name: "example.com", records: [{ record: "DKIM" as const, type: "CNAME" as const, name: "a._domainkey.example.com", value: "a.dkim.amazonses.com", status: "pending", ttl: "Auto" }] };
  await assert.rejects(publishRoute53(client, input), /not assigned/);
  await assert.rejects(publishRoute53(client, { ...input, zoneIds: ["ZOTHER"] }), /not assigned/);
  assert.equal(writes, 0);
  await publishRoute53(client, { ...input, zoneIds: ["ZOWNER"] });
  assert.equal(writes, 1);
});

test("signed file download streams and rejects expired credentials", async () => {
  const secret = "test secret with enough entropy for local fixtures";
  const token = seal({ use: "file", key: "attachments/tenant/email/att", exp: Math.floor(Date.now()/1000)+60 }, secret);
  let streams = 0;
  const storage = { stream: async () => { streams++; return Readable.from([Buffer.from("fixture")]); }, get: async () => { throw new Error("must not buffer"); } } as any;
  const result = await readSignedFile(token, storage, secret);
  assert.equal(streams, 1);
  assert.ok(result.bytes instanceof Readable);
  await assert.rejects(readSignedFile(seal({ use: "file", key: "attachments/tenant/email/att", exp: 1 }, secret), storage, secret));
});

test("database security boundaries", { skip: !process.env.TEST_DATABASE_URL }, async (t) => {
  const db = connect(process.env.TEST_DATABASE_URL);
  await migrate(db);
  const password = await hashPassword("a sufficiently long fixture password");
  const app = Fastify();
  app.addHook("preHandler", async (request) => { (request as any).auth = { tenant_id: request.headers["x-tenant"], user_id: request.headers["x-user"], permissions: ["full"] }; });
  registerPlatform(app, { db, paging: () => ({}), flushTelemetry: async () => {}, validKey: async () => null, sessionsEnabled: () => false, signins: { take: async () => true, release: async () => {} } });
  const fixture = async () => {
    const tenant = id("tenant"), users = [id("user"), id("user")], roles = [id("role"), id("role")], members = [id("member"), id("member")];
    await db.query("insert into tenants (id,name) values ($1,'Security fixture')", [tenant]);
    for (let i=0;i<2;i++) {
      await db.query("insert into users (id,tenant_id,email,name,password_hash) values ($1,$2,$3,'Fixture',$4)", [users[i],tenant,`${users[i]}@example.com`,password]);
      await db.query("insert into roles (id,tenant_id,name,permissions) values ($1,$2,$1,'[\"full\"]')", [roles[i],tenant]);
      await db.query("insert into memberships (id,tenant_id,user_id,role_id) values ($1,$2,$3,$4)", [members[i],tenant,users[i],roles[i]]);
    }
    return {tenant,users,roles,members};
  };
  try {
    for (const operation of ["role downgrade","role delete","membership reassign","membership delete","user deactivate","user delete"]) {
      await t.test(`concurrent ${operation} retains full access`, async () => {
        const f=await fixture(), viewer=id("role");
        await db.query("insert into roles (id,tenant_id,name,permissions) values ($1,$2,'Viewer','[\"read\"]')",[viewer,f.tenant]);
        const responses=await Promise.all([0,1].map(i => {
          const headers={"x-tenant":f.tenant};
          if(operation==="role downgrade") return app.inject({method:"PATCH",url:`/roles/${f.roles[i]}`,headers,payload:{permissions:["read"]}});
          if(operation==="role delete") return app.inject({method:"DELETE",url:`/roles/${f.roles[i]}`,headers});
          if(operation==="membership reassign") return app.inject({method:"POST",url:"/memberships",headers,payload:{user_id:f.users[i],role_id:viewer}});
          if(operation==="membership delete") return app.inject({method:"DELETE",url:`/memberships/${f.members[i]}`,headers});
          if(operation==="user deactivate") return app.inject({method:"PATCH",url:`/users/${f.users[i]}`,headers,payload:{active:false}});
          return app.inject({method:"DELETE",url:`/users/${f.users[i]}`,headers});
        }));
        assert.deepEqual(responses.map((x: { statusCode: number })=>x.statusCode).sort(),[200,409]);
      });
    }
    await t.test("old password cannot create a session after a reset", async () => {
      const f=await fixture(), original=db.query.bind(db);
      let reset=false;
      db.query=(async (...args:any[])=>{
        const result=await (original as any)(...args);
        if(!reset && String(args[0]).includes("where lower(u.email) = lower($1)")) {
          reset=true;
          await original("update users set password_hash=$1 where id=$2",[await hashPassword("a different long fixture password"),f.users[0]]);
        }
        return result;
      }) as typeof db.query;
      try {
        const result=await app.inject({method:"POST",url:"/sessions",payload:{email:`${f.users[0]}@example.com`,password:"a sufficiently long fixture password"}});
        assert.equal(result.statusCode,401);
        assert.equal((await original("select 1 from sessions where tenant_id=$1",[f.tenant])).rowCount,0);
      } finally { db.query=original; }
    });
    await t.test("revocation failure rolls back credentials and access mutations", async()=>{
      const f=await fixture();
      await db.query("insert into sessions(id,tenant_id,user_id,token_hash,expires_at) values ($1,$2,$3,$1,now()+interval '1 day')",[id("session"),f.tenant,f.users[0]]);
      await db.query(`create or replace function fail_session_revocation() returns trigger language plpgsql as $$ begin raise exception 'injected failure'; end $$;
        create trigger fail_session_revocation before update on sessions for each row execute function fail_session_revocation()`);
      try {
        for(const request of [
          {method:"PATCH" as const,url:`/users/${f.users[0]}`,payload:{password:"a different long fixture password"}},
          {method:"POST" as const,url:"/me/password",payload:{current_password:"a sufficiently long fixture password",password:"a different long fixture password"}},
          {method:"DELETE" as const,url:`/users/${f.users[0]}`},
          {method:"DELETE" as const,url:`/memberships/${f.members[0]}`},
        ]) {
          const result=await app.inject({...request,headers:{"x-tenant":f.tenant,"x-user":f.users[0]}});
          assert.equal(result.statusCode,500);
          const user=(await db.query("select password_hash,deactivated_at from users where id=$1",[f.users[0]])).rows[0];
          assert.equal(user.password_hash,password);assert.equal(user.deactivated_at,null);
          assert.equal((await db.query("select disabled_at from memberships where id=$1",[f.members[0]])).rows[0].disabled_at,null);
        }
      } finally { await db.query("drop trigger fail_session_revocation on sessions; drop function fail_session_revocation()"); }
    });
    await t.test("oversized sign-in is rejected before lookup", async () => {
      const response=await app.inject({method:"POST",url:"/sessions",payload:{email:"x@example.com",password:"x".repeat(17000)}});
      assert.equal(response.statusCode,413);
    });
    await t.test("invalid sends perform no object writes", async () => {
      const f=await fixture();let puts=0;
      await assert.rejects(acceptEmail(db,{from:"sender@unverified.example",to:"to@example.com",subject:"Fixture",text:"Hello",attachments:[{filename:"a.txt",content:Buffer.from("fixture").toString("base64")}]},{tenant_id:f.tenant,request_id:"test"},{storeAttachment:async()=>{puts++;}}));
      assert.equal(puts,0);
    });
    await t.test("concurrent SES notifications produce one received record", async () => {
      const f=await fixture(), domain=`${f.tenant}.example.com`, message=id("ses"), objects=new Map<string,Buffer>();
      await db.query("insert into domains (id,tenant_id,name,region,status,receiving) values ($1,$2,$3,'us-west-2','verified','enabled')",[id("domain"),f.tenant,domain]);
      const storage={ get:async()=>Buffer.from("From: sender@example.com\r\nSubject: Fixture\r\n\r\nHello"),put:async(key:string,body:Buffer)=>{objects.set(key,body);} } as any;
      const notification={mail:{messageId:message},receipt:{recipients:[`to@${domain}`],action:{objectKey:`raw/${message}`}}};
      await Promise.all([0,1].map(()=>tx(db,client=>applyInbound(client,storage,notification,{region:"us-west-2"}))));
      assert.equal((await db.query("select count(*)::int as n from received_emails where tenant_id=$1",[f.tenant])).rows[0].n,1);
      assert.equal(objects.size,1);
    });
    await t.test("storage reconciler removes rolled-back objects and terminal imports", async()=>{
      const f=await fixture(),key=`attachments/${f.tenant}/email/att`,deleted:string[]=[];
      await db.query("insert into pending_blobs(storage_key,created_at) values ($1,now()-interval '2 hours')",[key]);
      const importId=id("import"),importKey=`imports/${f.tenant}/${importId}`;
      await db.query("insert into contact_imports(id,tenant_id,status,storage_key) values($1,$2,'cancelled',$3)",[importId,f.tenant,importKey]);
      await cleanStorage(db,{delete:async key=>{deleted.push(key);}});
      assert.ok(deleted.includes(importKey));
      assert.ok((await db.query("select source_deleted_at from contact_imports where id=$1",[importId])).rows[0].source_deleted_at);
      assert.ok(deleted.includes(key));
      assert.equal((await db.query("select 1 from pending_blobs where storage_key=$1",[key])).rowCount,0);
    });
  } finally { await app.close(); await db.end(); }
});
