const antivirusInstallModel = require('../models/antivirusInstallModel');
const equipmentModel = require('../models/equipmentModel');

async function getAntivirus(req, res, next) {
  try {
    res.json(await antivirusInstallModel.getAntivirus());
  } catch (err) {
    next(err);
  }
}

// POST /api/antivirus  (admin)
async function createAntivirusInstall(req, res, next) {
  const { equipment_id } = req.body;
  if (!equipment_id) {
    return res.status(400).json({
      error: 'equipment_id is required',
      example: { equipment_id: 30, plan_date: '2026-08-01', antivirus_status: 'Pending' },
    });
  }
  try {
    const equipment = await equipmentModel.findById(equipment_id);
    if (!equipment) return res.status(404).json({ error: 'Equipment not found' });

    const install = await antivirusInstallModel.createAntivirusInstall(req.body);
    res.status(201).json({ message: 'Antivirus install record created', install });
  } catch (err) {
    next(err);
  }
}

async function updateAntivirusInstall(req, res, next) {
  try {
    const install = await antivirusInstallModel.updateAntivirusInstall(req.params.id, req.body);
    if (!install) return res.status(404).json({ error: 'Antivirus install record not found' });
    res.json({ message: 'Antivirus install record updated', install });
  } catch (err) {
    next(err);
  }
}

async function removeAntivirusInstall(req, res, next) {
  try {
    const install = await antivirusInstallModel.removeAntivirusInstall(req.params.id);
    if (!install) return res.status(404).json({ error: 'Antivirus install record not found' });
    res.json({ message: 'Antivirus install record removed', install });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getAntivirus,
  createAntivirusInstall,
  updateAntivirusInstall,
  removeAntivirusInstall,
};
