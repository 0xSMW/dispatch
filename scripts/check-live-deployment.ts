import {readFileSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const {Agent,request}=createRequire(new URL('../packages/core/package.json',import.meta.url))('undici');
const credentials=JSON.parse(readFileSync('.dispatch/credentials.json','utf8'));
const env=JSON.parse(readFileSync('.dispatch/environment.json','utf8'));
const dispatcher = new Agent({connect:{lookup:(hostname,options,cb)=>options.all?cb(null,[{address:'216.150.1.193',family:4}]):cb(null,'216.150.1.193',4)}});
const base='https://dispatch.smw.ai/api';
async function call(path,method='GET',payload,token){
 const res=await request(base+path,{dispatcher,method,headers:{...(payload?{'content-type':'application/json'}:{}),...(token?{authorization:'Bearer '+token}:{})},body:payload?JSON.stringify(payload):undefined});
 const text=await res.body.text();if(res.statusCode>=400)throw new Error(`${path} ${res.statusCode}: ${text.slice(0,1000)}`);return JSON.parse(text);
}
try{
 const health=await call('/health'); console.log('Live API health verified',health.ok);
 const login=await call('/sessions','POST',{email:credentials.email,password:credentials.password});
 await call('/me','GET',undefined,login.token);console.log('Live admin sign-in verified');
 const cron=await call('/internal/reconcile','GET',undefined,env.CRON_SECRET);console.log('Live workflow wake verified',cron.ok);
 if(process.argv.includes('--send')){
 const email=await call('/emails','POST',{from:'Dispatch <hello@smw.ai>',to:'success@simulator.amazonses.com',subject:'Dispatch deployment verification',...(process.argv.includes('--scheduled')?{scheduled_at:new Date(Date.now()+45000).toISOString()}:{}),text:'SES mailbox simulator test for internal deployment. No real recipient.',...(process.argv.includes('--attachment')?{attachments:[{filename:'verification.txt',content:Buffer.from('Dispatch S3 attachment verification').toString('base64')}]}:{})},credentials.api_key);
 writeFileSync('.dispatch/test-email.json',JSON.stringify(email),{mode:0o600});console.log('SES simulator email queued',email.id);
 }
 writeFileSync('.dispatch/live-session.json',JSON.stringify(login),{mode:0o600});
}finally{await dispatcher.close();}
