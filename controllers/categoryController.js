const categoryModel = require('../models/categoryModel');

async function getAll(req, res, next) {
  try {
    res.json(await categoryModel.findAll());
  } catch (err) { next(err); }
}

async function getById(req, res, next) {
  try {
    const cat = await categoryModel.findById(req.params.id);
    if (!cat) return res.status(404).json({ error: 'Category not found' });
    res.json(cat);
  } catch (err) { next(err); }
}

async function create(req, res, next) {
  const { category_name } = req.body;
  if (!category_name) {
    return res.status(400).json({ error: 'category_name is required' });
  }
  try {
    const existing = await categoryModel.findByName(category_name);
    if (existing) {
      return res.status(409).json({
        error: `Category "${category_name}" already exists`,
        existing,
      });
    }
    res.status(201).json(await categoryModel.create(req.body));
  } catch (err) { next(err); }
}

async function update(req, res, next) {
  try {
    const cat = await categoryModel.update(req.params.id, req.body);
    if (!cat) return res.status(404).json({ error: 'Category not found' });
    res.json(cat);
  } catch (err) { next(err); }
}

// Refused while equipment still uses it. Deactivating (PUT is_active:false)
// hides it from dropdowns without touching existing records.
async function remove(req, res, next) {
  try {
    const existing = await categoryModel.findById(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'Category not found' });
    }

    const usage = await categoryModel.countUsage(req.params.id);
    if (usage.equipment_count > 0) {
      return res.status(409).json({
        error: `Cannot delete ${existing.category_name}: ${usage.equipment_count} item(s) still use it`,
        references: usage,
        hint: 'Move that equipment to another category first, or set is_active to false to hide it from dropdowns instead.',
      });
    }

    const deleted = await categoryModel.remove(req.params.id);
    res.json({ message: 'Category deleted', category: deleted });
  } catch (err) {
    next(err);
  }
}

module.exports = { getAll, getById, create, update, remove };
