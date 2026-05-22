'use strict';

/**
 * Standard error shape used across the API: { error, code, detail? }
 *
 * Throw an HttpError from a route handler; the global error handler in
 * index.js converts it into the standard JSON response.
 */
class HttpError extends Error {
  /**
   * @param {number} statusCode
   * @param {string} code     - machine-readable error code (UPPER_SNAKE)
   * @param {string} message  - human-readable message ("error" field)
   * @param {*} [detail]      - optional extra detail (zod issues, etc.)
   */
  constructor(statusCode, code, message, detail) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.detail = detail;
  }
}

const badRequest = (code, message, detail) => new HttpError(400, code, message, detail);
const unauthorized = (code, message, detail) => new HttpError(401, code, message, detail);
const forbidden = (code, message, detail) => new HttpError(403, code, message, detail);
const notFound = (code, message, detail) => new HttpError(404, code, message, detail);
const conflict = (code, message, detail) => new HttpError(409, code, message, detail);

module.exports = {
  HttpError,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
};
