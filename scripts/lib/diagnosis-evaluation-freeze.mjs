import {readdir,readFile} from 'node:fs/promises';
import {join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {hash} from '../../src/sre/security.mjs';

const root=resolve(fileURLToPath(new URL('../..',import.meta.url)));
export async function diagnosisEvaluationFreeze(){
 const files={};
 async function visit(path){for(const entry of(await readdir(join(root,path),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const next=join(path,entry.name);if(entry.isDirectory())await visit(next);else if(entry.isFile())files[relative(root,join(root,next))]=hash(await readFile(join(root,next),'utf8'));}}
 for(const directory of ['src','scripts','config','fixtures'])await visit(directory);
 for(const path of ['package.json','pnpm-lock.yaml'])files[path]=hash(await readFile(join(root,path),'utf8'));
 return{version:1,files,hash:hash(files),note:'Content frozen before the first inference call. Authored validation mechanisms were not used for tuning in this run; this is not an independent production benchmark.'};
}
