import {hash} from './security.mjs';

const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const facts=(value,plan=false)=>({summary:value?.summary??null,assessment:(plan?value?.assessment:value?.changeAssessment)??null,candidateSha:value?.candidateSha??null,findings:(plan?value?.findings:value?.codeReview?.findings)||[],sourceFindings:value?.sourceFindings||[],evidenceIds:[...(value?.evidenceIds||[])].sort(),unknowns:[...(value?.unknowns||[])].sort(),rollback:value?.rollback||null});

// Shared identity for action guards and read-only artifact observations. The
// fingerprint describes reviewed facts; it is never an approval or capability.
export const assessmentHash=analysis=>hash(canonical(facts(analysis)));
export const planAssessmentCurrent=(payload,analysis)=>Boolean(analysis)&&((payload.assessmentHash||hash(canonical(facts(payload,true))))===assessmentHash(analysis));
