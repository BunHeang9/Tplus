const partStockModel = require('../models/partStockModel');
const partModel = require('../models/partModel');
const partStatusModel = require('../models/partStatusModel');
const partCustomFieldModel = require('../models/partCustomFieldModel');

// Spare parts held in stock. Counted, not identified - "3 x 8GB working"
// rather than a record per module.

// GET /api/part-stock?part_type_id=1&in_stock_only=true
async function getAll(req, res, next) {
  try {
    const stock = await partStockModel.findAll(req.query);

    // Each line's own custom field values (e.g. Battery -> Color, Serial
    // Number), merged in flat like the equipment list does for its custom
    // fields - same pattern, one level down.
    const valuesByStock = await partCustomFieldModel.getValuesForMany(
      stock.map((s) => s.stock_id),
    );
    for (const line of stock) Object.assign(line, valuesByStock[line.stock_id] || {});

    res.json({ count: stock.length, stock });
  } catch (err) {
    next(err);
  }
}

// GET /api/part-stock/summary
async function getSummary(req, res, next) {
  try {
    res.json({ summary: await partStockModel.getSummary() });
  } catch (err) {
    next(err);
  }
}

// GET /api/part-stock/available?part_type_id=1
// What can be fitted now - working only, quantity above zero.
async function getAvailable(req, res, next) {
  try {
    const stock = await partStockModel.findAvailable(req.query.part_type_id);
    res.json({ count: stock.length, stock });
  } catch (err) {
    next(err);
  }
}

// POST /api/part-stock  (admin)
// For parts bought in, or a stock take that found more than expected.
//
// RAM and storage are identified by part_value - a size. Accessories by
// model_name and model_number, since "Laptop bag" alone would merge two
// different bags into one line.
async function add(req, res, next) {
  const { part_type_id, part_value, model_name, quantity } = req.body;

  if (!part_type_id) {
    return res.status(400).json({ error: 'part_type_id is required' });
  }

  try {
    const partType = await partModel.findTypeById(part_type_id);
    if (!partType) return res.status(404).json({ error: 'Part type not found' });

    // Any custom field this part type was set up with, marked required when
    // it was attached - the same mechanism a new part type (Screen, Battery,
    // anything) uses to require its own attributes, instead of that only
    // being possible for RAM/Hard Disk's hardcoded ram_type/disk_type below.
    const customFields = await partCustomFieldModel.findByPartType(part_type_id);
    const missingRequired = customFields
      .filter((f) => f.is_required && !req.body[f.field_key])
      .map((f) => f.field_label);
    if (missingRequired.length > 0) {
      return res.status(400).json({
        error: `These fields are required for ${partType.part_name}: ${missingRequired.join(', ')}`,
      });
    }

    // Which identifier is required follows from the part itself, so the
    // caller does not have to know the rule.
    if (partType.tracks_value && !part_value) {
      return res.status(400).json({
        error: `part_value is required for ${partType.part_name}`,
        example: { part_type_id, part_value: '16', quantity: 2 },
      });
    }
    if (!partType.tracks_value && !model_name) {
      return res.status(400).json({
        error: `model_name is required for ${partType.part_name}`,
        example: { part_type_id, model_name: 'HP Business Carry Case',
                   model_number: 'K2X10AA', quantity: 5 },
      });
    }
    // Without this, a stick fitted from this line carries no type into the
    // replacement history, and a later replacement returns it to stock with
    // "unknown type" forever - there is no way to recover it after the fact.
    if (partType.part_name === 'RAM' && !req.body.ram_type) {
      return res.status(400).json({
        error: 'ram_type is required for RAM',
        example: { part_type_id, part_value: '16', ram_type: 'DDR4', quantity: 2 },
      });
    }
    if (partType.part_name === 'Hard Disk' && (!req.body.disk_type || !req.body.disk_interface)) {
      return res.status(400).json({
        error: 'disk_type and disk_interface are required for Hard Disk',
        example: { part_type_id, part_value: '500', disk_type: 'SSD', disk_interface: 'NVMe', quantity: 1 },
      });
    }

    // Checked here so a typo gets a useful message rather than surfacing as a
    // raw constraint violation from the database.
    if (req.body.status) {
      const status = await partStatusModel.findByName(req.body.status);
      if (!status) {
        const valid = (await partStatusModel.findAll()).map((s) => s.status_name);
        return res.status(400).json({ error: `status must be one of: ${valid.join(', ')}` });
      }
    }
    if (req.body.disk_type && !['SSD', 'HDD'].includes(req.body.disk_type)) {
      return res.status(400).json({ error: "disk_type must be 'SSD' or 'HDD'" });
    }
    if (req.body.disk_interface &&
        !['SATA', 'M.2', 'NVMe', 'IDE'].includes(req.body.disk_interface)) {
      return res.status(400).json({
        error: 'disk_interface must be one of: SATA, M.2, NVMe, IDE',
      });
    }
     if (req.body.ram_type && !['DDR3', 'DDR4', 'DDR5'].includes(req.body.ram_type)) {
      return res.status(400).json({ error: 'ram_type must be one of: DDR3, DDR4, DDR5' });
    }

    const stock = await partStockModel.increment(
      part_type_id, part_value, req.body.status, quantity ?? 1, null,
      {
        model_name: req.body.model_name,
        model_number: req.body.model_number,
        disk_type: req.body.disk_type,
        disk_interface: req.body.disk_interface,
        ram_type: req.body.ram_type,
        location: req.body.location,
        remark: req.body.remark,
      }
    );

    // Only the fields actually attached to this part type are pulled from
    // the request, so an unrelated stray body field cannot end up stored.
    const customValues = {};
    for (const f of customFields) {
      if (req.body[f.field_key] !== undefined) customValues[f.field_key] = req.body[f.field_key];
    }
    if (Object.keys(customValues).length > 0) {
      await partCustomFieldModel.setValues(stock.stock_id, customValues);
      Object.assign(stock, customValues);
    }

    // Includes the disk detail, or a 500GB SSD and a 500GB spinning disk
    // would produce the same message.
    const label = [part_value, model_name, req.body.model_number,
                   req.body.disk_type, req.body.disk_interface, req.body.ram_type]
      .filter(Boolean).join(' ');

    res.status(201).json({
      message: `${quantity ?? 1} x ${partType.part_name} ${label} added to stock`,
      stock,
    });
  } catch (err) {
    next(err);
  }
}

// PUT /api/part-stock/:id  (admin)
// Sets the quantity outright - for a stock take, where counting is more
// reliable than adjusting. Also edits the model details and the active flag.
async function update(req, res, next) {
  const { quantity, status } = req.body;

  if (quantity !== undefined && quantity < 0) {
    return res.status(400).json({ error: 'quantity cannot be negative' });
  }
  if (status) {
    const statusRow = await partStatusModel.findByName(status);
    if (!statusRow) {
      const valid = (await partStatusModel.findAll()).map((s) => s.status_name);
      return res.status(400).json({ error: `status must be one of: ${valid.join(', ')}` });
    }
  }

  try {
    const stock = await partStockModel.updateLine(req.params.id, req.body);
    if (!stock) return res.status(404).json({ error: 'Stock line not found' });

    const customFields = await partCustomFieldModel.findByPartType(stock.part_type_id);
    const customValues = {};
    for (const f of customFields) {
      if (req.body[f.field_key] !== undefined) customValues[f.field_key] = req.body[f.field_key];
    }
    if (Object.keys(customValues).length > 0) {
      await partCustomFieldModel.setValues(stock.stock_id, customValues);
      Object.assign(stock, customValues);
    }

    // The edit made this line identical to another one already on the
    // shelf - they were merged, so the id in the response is not the one
    // that was requested. Said plainly so a frontend tracking the old id
    // doesn't silently keep pointing at a row that no longer exists.
    if (stock.merged_from) {
      return res.json({
        message: `Merged into existing stock line #${stock.stock_id} - line #${stock.merged_from} no longer exists`,
        merged: true,
        stock,
      });
    }

    res.json({ message: 'Stock updated', stock });
  } catch (err) {
    next(err);
  }
}

// DELETE /api/part-stock/:id  (admin)
async function remove(req, res, next) {
  try {
    const existing = await partStockModel.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Stock line not found' });

    // A line with parts still on it is probably not meant to be deleted -
    // setting the quantity to zero is the deliberate way to empty it.
    if (existing.quantity > 0 && req.query.confirm !== 'true') {
      return res.status(409).json({
        error: `That line still has ${existing.quantity} in stock`,
        hint: 'Set the quantity to 0 instead, or add ?confirm=true to remove the line entirely.',
      });
    }

    await partStockModel.remove(req.params.id);
    res.json({ message: 'Stock line removed' });
  } catch (err) {
    next(err);
  }
}

module.exports = { getAll, getSummary, getAvailable, add, update, remove };