import { RequestNotSubmittedError } from './submission.mjs';

export const rollbackDispatchContractVersion=3;
// Thrown only by local approval preflight, before a connector attempts a write.
// A transport error or a failed remote workflow is not this proof.
export class WorkflowApprovalError extends RequestNotSubmittedError {
  constructor(message){super(message);this.name='WorkflowApprovalError';}
}

export function approvalWindow(approval,now=Date.now()) {
  if(!Number.isSafeInteger(now)||now<0)throw new WorkflowApprovalError('Rollback approval clock is invalid');
  if(!approval||!Number.isSafeInteger(approval.approvedAt)||approval.approvedAt<0||!Number.isSafeInteger(approval.expiresAt)||approval.expiresAt<=approval.approvedAt)throw new WorkflowApprovalError('Rollback approval requires valid approval and expiry timestamps');
  if(approval.approvedAt>now)throw new WorkflowApprovalError('Rollback approval timestamp is in the future');
  if(approval.expiresAt<=now)throw new WorkflowApprovalError('Rollback approval has expired before workflow execution');
  return {approvedAt:approval.approvedAt,expiresAt:approval.expiresAt};
}

// Fixed field order is also the UTF-8 JSON shape hashed in signed no-change
// attestations. The hash binds intent; authentication comes from the verifier.
export function workflowRequest(input) {
  return {
    requestId:input.requestId,environment:input.environment,
    expected:{sha:input.expected?.sha,artifact:input.expected?.artifact,deploymentId:String(input.expected?.deploymentId??''),deploymentAt:input.expected?.deploymentAt},
    target:{sha:input.target?.sha,artifact:input.target?.artifact},
    approval:{approvedAt:input.approval?.approvedAt,expiresAt:input.approval?.expiresAt},
  };
}
export function proposalWorkflowRequest(proposal,approval=proposal.approval) {
  return workflowRequest({requestId:proposal.id,environment:proposal.environment,expected:{sha:proposal.current.sha,artifact:proposal.current.artifact,deploymentId:proposal.current.deploymentId??proposal.current.id, deploymentAt:proposal.current.at},target:proposal.target,approval});
}
