import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const neon = JSON.parse(readFileSync('.dispatch/neon.json','utf8'));
const aws = JSON.parse(readFileSync('.dispatch/aws.json','utf8'));
const existing = (()=>{try{return JSON.parse(readFileSync('.dispatch/environment.json','utf8'));}catch{return {};}})();
const direct = neon.connection_uris[0].connection_uri;
const pooled = direct.replace(/@([^.]+)\./,'@$1-pooler.');
const env = {...existing, DATABASE_URL:pooled, DATABASE_DIRECT_URL:direct, NODE_ENV:'production', APP_SECRET:existing.APP_SECRET??randomBytes(32).toString('hex'), API_KEY_PEPPER:existing.API_KEY_PEPPER??randomBytes(32).toString('hex'), CRON_SECRET:existing.CRON_SECRET??randomBytes(32).toString('hex'), AWS_REGION:'us-west-2', AWS_ROLE_ARN:aws.role_arn,SNS_TOPIC_ARN:aws.topic_arn,S3_BUCKET:aws.bucket,STORAGE_BACKEND:'s3',SES_PROVIDER:'ses',COUNTER_BACKEND:'postgres',WORKER_RUNTIME:'vercel',DB_POOL_SIZE:'4',PUBLIC_URL:'https://dispatch.smw.ai/api',APP_URL:'https://dispatch.smw.ai',ALLOWED_ORIGINS:'https://dispatch.smw.ai',TRUST_PROXY:'1',ALLOW_PUBLIC_SETUP:'false',ALLOW_PASSWORDLESS_SESSIONS:'false'};
writeFileSync('.dispatch/environment.json',JSON.stringify(env,null,2),{mode:0o600});
if(process.argv.includes('--upload')) for(const [key,value] of Object.entries(env)){
 const r=spawnSync('vercel',['env','add',key,'production','--scope','ai-marketing','--yes'],{input:String(value)+'\n',encoding:'utf8'});
 if(r.status!==0) throw new Error(`${key}: ${r.stderr}`);
 console.log(`Configured ${key}`);
}
