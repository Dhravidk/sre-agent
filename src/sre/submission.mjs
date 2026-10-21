// Local evidence that the deployment transport has not been invoked. Every
// failure after that boundary must lose this classification, including failures
// while reading a response. This never authorizes an automatic write retry.
export class RequestNotSubmittedError extends Error {
  constructor(message){super(message);this.name='RequestNotSubmittedError';}
}
