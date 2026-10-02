export class TranscriptError extends Error {
  constructor(code, message, details = {}, retryable = false) {
    super(message); this.name = 'TranscriptError'; this.code = code;
    this.details = details; this.retryable = retryable;
  }
  toJSON() { return { code: this.code, message: this.message, retryable: this.retryable, ...this.details }; }
}
export function safeError(error) {
  return error instanceof TranscriptError ? error.toJSON() : {
    code: 'internal_error', message: 'The transcript service could not complete this request.', retryable: false
  };
}
