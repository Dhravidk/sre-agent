export const questionBatchLimits=Object.freeze({requests:32,bytes:32768,questionCharacters:4000});
export const requestBatchBytes=requests=>Buffer.byteLength(JSON.stringify(requests));

// Request count and UTF-8 bytes are independent bounds. Every retained batch
// is delivered whole; pending questions that do not fit wait for another turn.
export function assertRequestBatch(requests,version=2){
  if(requests===undefined)return;
  // Previously persisted batches allowed eight 4,000-character questions.
  // Preserve their exact retry payload, including worst-case JSON escaping.
  const count=version===1?8:questionBatchLimits.requests,bytes=version===1?196608:questionBatchLimits.bytes;
  if(![1,2].includes(version)||!Array.isArray(requests)||requests.length>count||requests.some(r=>!r||typeof r.question!=='string'||r.question.length>questionBatchLimits.questionCharacters||typeof r.jobId!=='string')||requestBatchBytes(requests)>bytes)throw Error('Invalid bounded investigation request batch');
}
