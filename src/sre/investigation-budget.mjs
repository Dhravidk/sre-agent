export function investigationTimeBudgetMs(reasoner){
  return ['claude','codex'].includes(reasoner?.mode)?(reasoner.options?.timeoutMs??180000)+60000:120000;
}
