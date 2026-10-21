import { GitLabReader, JiraReader, DynatraceReader } from '../src/connectors/clients.mjs';
if(!process.argv.includes('--live')) {
  console.log('Offline connector contracts: pnpm test\nTo perform credentialed, read-only checks: node --env-file-if-exists=.env scripts/check-connectors.mjs --live');
  process.exit(0);
}
const env=process.env;const results=[];
async function check(name,required,run) {
  const missing=required.filter(key=>!env[key]);
  if(missing.length){results.push({connector:name,status:'not configured',missing});return;}
  try{await run();results.push({connector:name,status:'read check passed'});}catch(error){results.push({connector:name,status:'failed',error:error.message});process.exitCode=1;}
}
await check('GitLab',['GITLAB_BASE_URL','GITLAB_TOKEN','GITLAB_PROJECT_ID','GITLAB_MR_IID'],async()=>{
  const c=new GitLabReader({base:env.GITLAB_BASE_URL,token:env.GITLAB_TOKEN,project:env.GITLAB_PROJECT_ID});await c.mergeRequest(env.GITLAB_MR_IID);await c.deployments();
});
await check('Jira',['JIRA_BASE_URL','JIRA_EMAIL','JIRA_API_TOKEN','JIRA_ISSUE_KEY'],async()=>{
  await new JiraReader({base:env.JIRA_BASE_URL,email:env.JIRA_EMAIL,token:env.JIRA_API_TOKEN,version:env.JIRA_API_VERSION}).issue(env.JIRA_ISSUE_KEY);
});
await check('Dynatrace',['DYNATRACE_BASE_URL','DYNATRACE_TOKEN',...(env.DYNATRACE_MODE==='grail'?[]:['DYNATRACE_PROBLEM_ID'])],async()=>{
  const c=new DynatraceReader({base:env.DYNATRACE_BASE_URL,token:env.DYNATRACE_TOKEN,mode:env.DYNATRACE_MODE});
  if(env.DYNATRACE_MODE==='grail')await c.query('fetch dt.davis.problems, from:now()-5m | limit 1');else await c.problem(env.DYNATRACE_PROBLEM_ID);
});
results.push({connector:'Teams',status:'requires interactive test',next:'Follow docs/CONNECTOR-TESTS.md for Playground and authenticated tenant tests.'});
console.log(JSON.stringify(results,null,2));
