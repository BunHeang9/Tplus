const AuditLog = require('./sequelize/auditLogModel');

async function create(entry) {
  await AuditLog.create({
    actor_user_id: entry.actor.user_id,
    actor_username: entry.actor.username,
    actor_name: entry.actor.full_name || null,
    actor_role: entry.actor.role,
    action: entry.action,
    entity_type: entry.entityType,
    entity_id: entry.entityId || null,
    request_path: entry.requestPath,
    change_data: JSON.stringify(entry.changeData || {}),
  });
}

async function findAll(limit = 200) {
  return AuditLog.findAll({
    attributes: [
      'audit_id', 'actor_user_id', 'actor_username', 'actor_name',
      'actor_role', 'action', 'entity_type', 'entity_id', 'request_path',
      'change_data', 'created_at',
    ],
    order: [['created_at', 'DESC'], ['audit_id', 'DESC']],
    limit,
    raw: true,
  });
}

module.exports = { create, findAll };
