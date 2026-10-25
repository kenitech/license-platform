// An error the API reports to the caller as { error: code, message }.
export class ApiError extends Error {
  constructor(status, code, message, extra = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const badRequest = (message, code = 'invalid_request') => new ApiError(400, code, message);
export const notFound = (message, code = 'not_found') => new ApiError(404, code, message);
export const conflict = (message, code) => new ApiError(409, code, message);
export const forbidden = (message, code) => new ApiError(403, code, message);
