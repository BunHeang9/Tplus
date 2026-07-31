// Central error handling. Controllers call next(err) and it lands here,
// so error formatting lives in one place instead of every route.

function notFound(req, res) {
  res.status(404).json({ error: 'Route not found' });
}

function errorHandler(err, req, res, next) {
  console.error(`[ERROR] ${req.method} ${req.originalUrl}`);
  console.error(err.stack || err.message);

  // In development it's useful to see the real message; in production
  // a generic one avoids leaking database or schema details to callers.
  const isDev = process.env.NODE_ENV !== 'production';

  res.status(err.status || 500).json({
    error: isDev ? err.message : 'Something went wrong on the server',
  });
}

module.exports = { notFound, errorHandler };
