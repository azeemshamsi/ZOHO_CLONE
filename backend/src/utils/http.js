class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

// Wrap async route handlers so thrown errors reach the error middleware.
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Validate req.body against a Joi schema; returns the cleaned value.
function validate(schema, data) {
  const { error, value } = schema.validate(data, { abortEarly: true, stripUnknown: true });
  if (error) throw new HttpError(400, error.details[0].message.replace(/"/g, ""));
  return value;
}

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

module.exports = { HttpError, ah, validate, round2 };
