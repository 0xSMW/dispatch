import { closeSync, constants, fchmodSync, fstatSync, ftruncateSync, lstatSync, openSync, readFileSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const privateDirectory = resolve('.dispatch');
if (!lstatSync(privateDirectory).isDirectory()) throw new Error('.dispatch must be a real directory');
function privateFile(name: 'environment.json' | 'credentials.json', create = false) {
 const path = resolve(privateDirectory, name);
 const fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK | (create ? constants.O_CREAT : 0), 0o600);
 try {
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.nlink !== 1) throw new Error(`${name} must be a regular file with one link`);
  fchmodSync(fd, 0o600);
  return fd;
 } catch (error) { closeSync(fd); throw error; }
}
function writePrivateJson(fd: number, value: unknown) {
 const bytes = Buffer.from(JSON.stringify(value, null, 2));
 ftruncateSync(fd, 0);
 for (let offset = 0; offset < bytes.length;) {
  const written = writeSync(fd, bytes, offset, bytes.length - offset, offset);
  if (!written) throw new Error('Private file write failed');
  offset += written;
 }
}
const neon = JSON.parse(readFileSync('.dispatch/neon.json','utf8'));
const aws = JSON.parse(readFileSync('.dispatch/aws.json','utf8'));
const environmentFile = privateFile('environment.json', true);
let env: Record<string, string>;
try {
const existing = (()=>{try{return JSON.parse(readFileSync(environmentFile,'utf8'));}catch{return {};}})();
const direct = neon.connection_uris[0].connection_uri;
const pooled = direct.replace(/@([^.]+)\./,'@$1-pooler.');
env = {...existing, DATABASE_URL:pooled, DATABASE_DIRECT_URL:direct, NODE_ENV:'production', APP_SECRET:existing.APP_SECRET??randomBytes(32).toString('hex'), API_KEY_PEPPER:existing.API_KEY_PEPPER??randomBytes(32).toString('hex'), CRON_SECRET:existing.CRON_SECRET??randomBytes(32).toString('hex'), AWS_REGION:'us-west-2', AWS_ROLE_ARN:aws.role_arn,SNS_TOPIC_ARN:aws.topic_arn,S3_BUCKET:aws.bucket,STORAGE_BACKEND:'s3',SES_PROVIDER:'ses',COUNTER_BACKEND:'postgres',WORKER_RUNTIME:'vercel',DB_POOL_SIZE:'4',PUBLIC_URL:'https://dispatch.smw.ai/api',APP_URL:'https://dispatch.smw.ai',CORS_ORIGINS:'https://dispatch.smw.ai',TRUST_PROXY:'1',ALLOW_PUBLIC_SETUP:'false',ALLOW_PASSWORDLESS_SESSIONS:'false'};
writePrivateJson(environmentFile, env);
} finally { closeSync(environmentFile); }
if(process.argv.includes('--upload')) for(const [key,value] of Object.entries(env)){
 const r=spawnSync('vercel',['env','add',key,'production','--scope','ai-marketing','--yes'],{input:String(value)+'\n',encoding:'utf8'});
 if(r.status!==0) throw new Error(`${key}: ${r.stderr}`);
 console.log(`Configured ${key}`);
}
