export function claudeOptions(config={},env={}) {
  const raw=config.claude??{};
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(key=>!['command','model','timeoutMs','bare','maxBudgetUsd'].includes(key)))throw new Error('Invalid Claude CLI configuration');
  const command=env.SRE_CLAUDE_BIN??raw.command??'claude',model=env.SRE_CLAUDE_MODEL||raw.model;
  const timeoutMs=raw.timeoutMs??120000,bare=raw.bare??false,maxBudgetUsd=raw.maxBudgetUsd;
  if(typeof command!=='string'||!command.trim()||command.length>4096||/[\0\r\n]/.test(command))throw new Error('Configure a Claude executable, without shell arguments');
  if(model!==undefined&&(typeof model!=='string'||!model.trim()||model.length>256||/[\0\r\n]/.test(model)))throw new Error('Invalid Claude model');
  if(!Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>120000)throw new Error('Claude timeoutMs must be 100–120000');
  if(typeof bare!=='boolean')throw new Error('Claude bare must be a boolean');
  if(maxBudgetUsd!==undefined&&(!Number.isFinite(maxBudgetUsd)||maxBudgetUsd<=0||maxBudgetUsd>10000))throw new Error('Invalid Claude maxBudgetUsd');
  return {command,model,timeoutMs,bare,maxBudgetUsd};
}
