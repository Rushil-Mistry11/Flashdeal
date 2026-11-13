const { randomUUID } = require('crypto');

module.exports = function requestId(req, res, next) {
  req.id = req.get('x-request-id') || randomUUID();
  res.set('X-Request-Id', req.id);
  next();
};
