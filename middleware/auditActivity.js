const auditModel = require('../models/auditModel');

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['password', 'new_password', 'password_hash'].includes(key.toLowerCase()))
    .map(([key, item]) => [key, redact(item)]));
}

// Place after authenticate. Successful update/delete requests are logged without
// storing passwords or query-string credentials.
function auditActivity(entityType, actionOverride) {
  return (req, res, next) => {
    res.once('finish', () => {
      if (res.statusCode < 200 || res.statusCode >= 300 || !req.user) return;

      const action = actionOverride || (req.method === 'DELETE' ? 'delete' : 'update');
      auditModel.create({
        actor: req.user,
        action,
        entityType,
        entityId: req.params.id || req.body.equipment_id ||
          (Array.isArray(req.body.equipment_ids) ? req.body.equipment_ids.join(',') : null) ||
          req.body.owner_id,
        requestPath: `${req.baseUrl}${req.path}`,
        changeData: { body: redact(req.body) },
      }).catch((err) => console.error('Audit log write failed:', err.message));
    });
    next();
  };
}

module.exports = { auditActivity };
