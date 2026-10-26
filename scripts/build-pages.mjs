import {cpSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),destination=resolve(root,'dist/github-pages');
const api=process.env.API_URL;if(!api||!/^https:\/\/[^\s]+\/api\/?$/.test(api))throw Error('Set API_URL=https://YOUR-SERVER/api before building GitHub Pages.');
rmSync(destination,{recursive:true,force:true});mkdirSync(destination,{recursive:true});cpSync(resolve(root,'public'),destination,{recursive:true});
writeFileSync(resolve(destination,'config.js'),`window.SAT_CONFIG={apiBase:${JSON.stringify(api.replace(/\/$/,''))}};\n`);
console.log('Frontend ready at '+destination+'. Publish only this folder.');
