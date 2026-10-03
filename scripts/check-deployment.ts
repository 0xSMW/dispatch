import {readFileSync} from 'node:fs';
const env=JSON.parse(readFileSync('.dispatch/environment.json','utf8'));
Object.assign(process.env,env,{WORKER_RUNTIME:'local',AWS_PROFILE:'console'});
delete process.env.AWS_ROLE_ARN;
const credentials=JSON.parse(readFileSync('.dispatch/credentials.json','utf8'));
const {app,close}=await import('../apps/api/src/server.ts');
try{
 const health=await app.inject({method:'GET',url:'/health'});
 if(health.statusCode!==200)throw new Error(`Health failed ${health.statusCode}`);
 const login=await app.inject({method:'POST',url:'/sessions',payload:{email:credentials.email,password:credentials.password}});
 if(login.statusCode!==201&&login.statusCode!==200)throw new Error(`Login failed ${login.statusCode} ${login.body}`);
 const token=JSON.parse(login.body).token;
 if(!token)throw new Error('Session token missing');
 const me=await app.inject({method:'GET',url:'/me',headers:{authorization:`Bearer ${token}`}});
 if(me.statusCode!==200)throw new Error(`Authenticated request failed ${me.statusCode}`);
 console.log('Production-config health, admin password sign-in and authenticated API verified against Neon.');
}finally{await close();}
