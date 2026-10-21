import { defineTool } from 'eve/tools';

export default defineTool({
  description: 'Read only the incident authorized by the short-lived evidence capability supplied with this turn.',
  inputSchema: {type:'object',properties:{capability:{type:'string'}},required:['capability'],additionalProperties:false},
  async execute({capability}: {capability: string}) {
    const base=process.env.SRE_SERVICE_URL||'http://127.0.0.1:3001';
    const url=new URL(base);
    if(url.protocol!=='https:'&&!['localhost','127.0.0.1'].includes(url.hostname))throw new Error('A secure SRE service URL is required');
    const response=await fetch(base+'/internal/evidence',{headers:{authorization:'Bearer '+capability},redirect:'error',signal:AbortSignal.timeout(5000)});
    if(!response.ok)throw new Error('The incident evidence capability is invalid or expired');
    return response.json();
  },
});
