const DEFAULT_PUBLIC_MESSAGE = '服务器内部错误，请稍后重试。';

class ApiError extends Error {
  constructor(message, { status = 500, code = 'INTERNAL_ERROR', expose = status < 500, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = this.constructor.name;
    this.status = status;
    this.code = code;
    this.expose = expose;
  }
}

class InputError extends ApiError {
  constructor(message, options = {}) {
    super(message, { status: 400, code: 'INPUT_ERROR', expose: true, ...options });
  }
}

class NotFoundError extends ApiError {
  constructor(message, options = {}) {
    super(message, { status: 404, code: 'NOT_FOUND', expose: true, ...options });
  }
}

class ForbiddenError extends ApiError {
  constructor(message, options = {}) {
    super(message, { status: 403, code: 'FORBIDDEN', expose: true, ...options });
  }
}

class ConflictError extends ApiError {
  constructor(message, options = {}) {
    super(message, { status: 409, code: 'BUSINESS_CONFLICT', expose: true, ...options });
  }
}

class ExternalServiceError extends ApiError {
  constructor(message = '外部服务暂时不可用，请稍后重试。', options = {}) {
    super(message, { status: 502, code: 'EXTERNAL_SERVICE_ERROR', expose: true, ...options });
  }
}

class StorageError extends ApiError {
  constructor(message = '存储操作失败。', options = {}) {
    super(message, { status: 500, code: 'STORAGE_ERROR', expose: false, ...options });
  }
}

const STATUS_CODES = new Map([
  [400, 'INPUT_ERROR'],
  [403, 'FORBIDDEN'],
  [404, 'NOT_FOUND'],
  [409, 'BUSINESS_CONFLICT'],
  [502, 'EXTERNAL_SERVICE_ERROR']
]);
const PUBLIC_ERROR_CODES = new Set([
  'INPUT_ERROR',
  'FORBIDDEN',
  'NOT_FOUND',
  'BUSINESS_CONFLICT',
  'EXTERNAL_SERVICE_ERROR',
  'STORAGE_ERROR',
  'INTERNAL_ERROR'
]);

function codeForStatus(status) {
  if (STATUS_CODES.has(status)) return STATUS_CODES.get(status);
  return status >= 400 && status < 500 ? 'INPUT_ERROR' : 'INTERNAL_ERROR';
}

function errorPayload(error) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  const expose = error instanceof ApiError ? error.expose : status < 500;
  const code = error instanceof ApiError && PUBLIC_ERROR_CODES.has(error.code)
    ? error.code
    : codeForStatus(status);
  return {
    status,
    body: {
      success: false,
      code,
      message: expose ? error.message : DEFAULT_PUBLIC_MESSAGE
    }
  };
}

// Keeps legacy route responses compatible while giving every API failure the
// same stable machine-readable envelope. Existing clients may continue to use
// `message`; new clients should branch on `code`.
function normalizeApiErrorResponses(req, res, next) {
  res.locals ||= {};
  const originalJson = res.json.bind(res);
  res.json = body => {
    if (res.statusCode >= 400 && body?.success === false) {
      const status = res.statusCode;
      const internal = status >= 500 && status !== 502;
      const code = PUBLIC_ERROR_CODES.has(body.code) ? body.code : codeForStatus(status);
      if (internal && !res.locals.apiErrorLogged) {
        console.error(`[API Error] ${req.method} ${req.originalUrl}: ${body.message || 'unknown error'}`);
        res.locals.apiErrorLogged = true;
      }
      body = {
        ...body,
        code,
        message: internal ? DEFAULT_PUBLIC_MESSAGE : body.message
      };
    }
    return originalJson(body);
  };
  next();
}

function apiErrorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  res.locals ||= {};
  const inheritedStatus = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599
    ? error.status
    : 500;
  const normalized = error instanceof ApiError
    ? error
    : new ApiError(error?.message || DEFAULT_PUBLIC_MESSAGE, {
        status: inheritedStatus,
        code: codeForStatus(inheritedStatus),
        expose: inheritedStatus < 500,
        cause: error
      });
  const { status, body } = errorPayload(normalized);
  if (!normalized.expose) {
    console.error(`[API Error] ${req.method} ${req.originalUrl}:`, error);
    res.locals.apiErrorLogged = true;
  }
  res.status(status).json(body);
}

function handleApiError(error, req, res, next, fallbackStatus = 500) {
  const normalized = error instanceof ApiError
    ? error
    : new ApiError(error?.message || DEFAULT_PUBLIC_MESSAGE, {
        status: fallbackStatus,
        code: codeForStatus(fallbackStatus),
        expose: fallbackStatus < 500,
        cause: error
      });
  if (typeof next === 'function') return next(normalized);
  const { status, body } = errorPayload(normalized);
  return res.status(status).json(body);
}

module.exports = {
  ApiError,
  InputError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  ExternalServiceError,
  StorageError,
  DEFAULT_PUBLIC_MESSAGE,
  errorPayload,
  handleApiError,
  normalizeApiErrorResponses,
  apiErrorHandler
};
