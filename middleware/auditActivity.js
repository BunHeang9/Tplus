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
//
// The response body is captured alongside the request, not just the request.
// Most handlers already resolve ids into full records before responding - an
// assign returns the equipment with owner_name and asset_code already joined
// in, a part replacement returns part_name, an employee update returns the
// whole employee - so reusing that instead of re-deriving it here turns a bare
// entity_id: 733 into "who received what, with what asset code" without
// touching every controller that gets audited.
function auditActivity(entityType, actionOverride) {
  return (req, res, next) => {
    const originalJson = res.json.bind(res);
    let capturedBody;
    res.json = (body) => {
      capturedBody = body;
      return originalJson(body);
    };

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
        changeData: {
          request: redact(req.body),
          response: redact(capturedBody),
        },
      }).catch((err) => console.error('Audit log write failed:', err.message));
    });
    next();
  };
}

module.exports = { auditActivity };
