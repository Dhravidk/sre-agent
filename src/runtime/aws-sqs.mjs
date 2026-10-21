// AWS transport adapter. Inject a transactional, durable Store implementation.
// The same store.event -> applyEvent path is used by the local HTTP adapter.
// Configure ReportBatchItemFailures on the Lambda event source mapping.
export function createSqsHandler({store}) {
  if(typeof store?.event!=='function') throw new Error('A durable event store is required');
  return async function handler(event) {
    const batchItemFailures=[];
    for(const record of event.Records||[]) {
      try {
        if(record.eventSource!=='aws:sqs' || !record.messageId) throw new Error('Invalid SQS record');
        await store.event(JSON.parse(record.body));
      } catch {
        if(!record.messageId) throw new Error('SQS record has no message ID');
        batchItemFailures.push({itemIdentifier:record.messageId});
      }
    }
    return {batchItemFailures};
  };
}
