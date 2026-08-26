const viewColumnModel = require('../models/viewColumnModel');
const customFieldModel = require('../models/customFieldModel');
const softwareLicenseModel = require("../models/softwareLicenseModel");
const equipmentModel = require("../models/equipmentModel");
const categoryModel = require("../models/categoryModel");
const departmentModel = require("../models/departmentModel");

// Per-category views over the single dbo.equipment table.
//
// /api/equipment/cctv returns the columns an admin has configured for CCTV;
// /laptop returns the laptop set. The data is not duplicated - only the
// selection of columns differs - so search, borrow, audit and the recycle bin
// are untouched.
//
// Column definitions come from dbo.category_view_column, so adding a category
// and choosing its columns is done from the dashboard rather than in code.

// Values that come from a join rather than from dbo.equipment. They appear in
// every response, so a form that loads a record and posts it back naturally
// includes them - which is normal, not a mistake. They are skipped on write
// rather than rejected, since the API already knows they are read-only.
//
// A device's department and location follow its owner: set owner_id and both
// update automatically.
const DERIVED_READONLY = [
  "owner_name",
  "owner_position",
  "owner_department",
  "owner_department_name",
  "owner_location",
  "owner_staff_code",
  "owner_sex",
  "category_name",
  "status_name",
  "department_code",
  "department_name",
  "is_assignable",
  "is_borrowable",
  "current_borrow_id",
  "current_borrower",
  "borrowed_on",
  "due_back",
  "equipment_id",
];

const SERVER_TYPES = ["Cloud", "Physical"];

// equipment_id is always included; a view without it gives the frontend no way
// to open or edit a row.
function project(
  row,
  columns,
  customFields = [],
  customValues = {},
  licenses = null,
) {
  if (!row) return null;
  const out = { equipment_id: row.equipment_id };
  for (const col of columns) out[col.field_name] = row[col.field_name] ?? null;
  // Custom values are merged in alongside the real columns, so the frontend
  // does not need to know which is which.
  for (const f of customFields)
    out[f.field_key] = customValues[f.field_key] ?? null;

  // Licences travel with the row so a list can show them as columns without a
  // request per device - 200 laptops would otherwise mean 200 extra calls.
  if (licenses !== null) {
    out.software_licenses = licenses;
    // Flattened for a simple table: one cell each rather than an array the
    // frontend has to join itself.
    out.license_names = licenses.map((l) => l.product_name).join(", ") || null;
    out.license_date_start =
      licenses.length === 1 ? licenses[0].date_start : null;
    out.license_date_expire =
      licenses.length === 1 ? licenses[0].date_expire : null;
    out.license_status = licenses.length === 1 ? licenses[0].status : null;
  }
  return out;
}

function headersFor(columns, customFields = [], includeLicenses = false) {
  return [
    { field: "equipment_id", header: "No." },
    ...columns.map((c) => ({ field: c.field_name, header: c.header_text })),
    // Custom fields come last and are flagged, so the frontend can render
    // them differently if it wants - but they arrive in the same shape.
    ...customFields.map((f) => ({
      field: f.field_key,
      header: f.field_label,
      custom: true,
    })),
    ...(includeLicenses
      ? [
          { field: "license_names", header: "Software License", license: true },
          {
            field: "license_date_start",
            header: "License Start",
            license: true,
          },
          {
            field: "license_date_expire",
            header: "License Expire",
            license: true,
          },
          { field: "license_status", header: "License Status", license: true },
        ]
      : []),
  ];
}

// GET /api/equipment/views
async function getViews(req, res, next) {
  try {
    const views = await viewColumnModel.listViews();
    res.json({
      views: views.map((v) => ({
        key: v.view_key,
        label: v.category_name,
        category: v.category_name,
        column_count: v.column_count,
        item_count: v.item_count,
        configured: v.column_count > 0,
      })),
    });
  } catch (err) {
    next(err);
  }
}

// GET /api/equipment/:view
async function getByView(req, res, next) {
  const viewKey = String(req.params.view || "").toLowerCase();

  try {
    const category = await viewColumnModel.findCategoryByViewKey(viewKey);
    if (!category) {
      const all = await viewColumnModel.listViews();
      return res.status(404).json({
        error: `No view called "${viewKey}"`,
        available: all.map((v) => v.view_key),
      });
    }

    const columns = await viewColumnModel.findByCategory(category.category_id);
    if (columns.length === 0) {
      // A newly created category starts here - it exists, but nobody has said
      // what its list should show yet.
      return res.status(409).json({
        error: `The ${category.category_name} view has no columns configured yet`,
        hint: `An admin can set them with PUT /api/view-columns/${category.category_id}`,
        category_id: category.category_id,
      });
    }

    const rows = await equipmentModel.findAll({
      ...req.query,
      category: category.category_name,
    });

    const customFields = await customFieldModel.findByCategory(
      category.category_id,
    );
    // One query for the whole page rather than one per row.
    const customValues =
      customFields.length > 0
        ? await customFieldModel.getValuesForMany(
            rows.map((r) => r.equipment_id),
          )
        : {};

    // Licences are included by default. Pass ?licenses=false on a large list
    // if they are not being displayed, to save the extra query.
    const wantLicenses = req.query.licenses !== "false";
    const licensesByEquipment = wantLicenses
      ? await softwareLicenseModel.getLicensesForMany(
          rows.map((r) => r.equipment_id),
        )
      : {};

    res.json({
      view: viewKey,
      label: category.category_name,
      category: category.category_name,
      // Headers travel with the data so the frontend does not hardcode a layout
      // per category - if an admin reorders the columns, the table follows.
      columns: headersFor(columns, customFields, wantLicenses),
      count: rows.length,
      items: rows.map((r) =>
        project(
          r,
          columns,
          customFields,
          customValues[r.equipment_id] || {},
          wantLicenses ? licensesByEquipment[r.equipment_id] || [] : null,
        ),
      ),
    });
  } catch (err) {
    next(err);
  }
}

// POST /api/equipment/:view
async function createInView(req, res, next) {
  const viewKey = String(req.params.view || "").toLowerCase();

  try {
    const category = await viewColumnModel.findCategoryByViewKey(viewKey);
    if (!category)
      return res.status(404).json({ error: `No view called "${viewKey}"` });

    const columns = await viewColumnModel.findByCategory(category.category_id);
    const editable = columns
      .filter((c) => c.is_editable)
      .map((c) => c.field_name);

    const customFields = await customFieldModel.findByCategory(
      category.category_id,
    );
    const customKeys = customFields.map((f) => f.field_key);

    const missing = customFields
      .filter((f) => f.is_required && !req.body[f.field_key])
      .map((f) => f.field_label);
    if (missing.length > 0) {
      return res.status(400).json({
        error: `These fields are required for ${category.category_name}: ${missing.join(", ")}`,
      });
    }

    if (req.body.server_type && !SERVER_TYPES.includes(req.body.server_type)) {
      return res.status(400).json({
        error: `server_type must be one of: ${SERVER_TYPES.join(", ")}`,
      });
    }

    // Fields outside this category are rejected rather than ignored - sending
    // cpu to /cctv is a mistake worth surfacing, not swallowing.
    // status, location and remark are always accepted even when not configured
    // as columns - the borrow and stock features depend on status, and every
    // device has a location. Making them optional was a mistake.
    const ALWAYS_WRITABLE = [
      "status",
      "location",
      "remark",
      "category",
      "category_id",
      "owner_id",
      "department",
      "license_id",
    ];
    const rejected = Object.keys(req.body).filter(
      (k) =>
        !editable.includes(k) &&
        !customKeys.includes(k) &&
        !ALWAYS_WRITABLE.includes(k) &&
        !DERIVED_READONLY.includes(k),
    );
    if (rejected.length > 0) {
      return res.status(400).json({
        error: `These fields do not apply to ${category.category_name}: ${rejected.join(", ")}`,
        allowed: editable,
      });
    }

    // Strip the read-only ones before they reach the model, so a posted-back
    // record cannot try to write a joined value onto dbo.equipment.
    const writable = { ...req.body };
    for (const key of DERIVED_READONLY) delete writable[key];

    if (req.body.equipment_code) {
      const clash = await equipmentModel.findByEquipmentCode(
        req.body.equipment_code,
      );
      if (clash) {
        return res.status(409).json({
          error: `Asset code "${req.body.equipment_code}" is already used by equipment_id ${clash.equipment_id}`,
        });
      }
    }
    if (req.body.service_tag) {
      const clash = await equipmentModel.findByServiceTag(req.body.service_tag);
      if (clash) {
        return res.status(409).json({
          error: `Service tag "${req.body.service_tag}" is already used by equipment_id ${clash.equipment_id}`,
        });
      }
    }

    let department_id = req.body.department_id;
    if (!department_id && req.body.department) {
      const dept = await departmentModel.findByCode(req.body.department);
      if (!dept) {
        return res
          .status(400)
          .json({ error: `Unknown department "${req.body.department}"` });
      }
      department_id = dept.department_id;
    }

    const created = await equipmentModel.createStock({
      ...writable,
      category_id: category.category_id,
      department_id,
    });

    const customValues = {};
    for (const key of customKeys) {
      if (req.body[key] !== undefined) customValues[key] = req.body[key];
    }
    if (Object.keys(customValues).length > 0) {
      await customFieldModel.setValues(created.equipment_id, customValues);
    }

    const full = await equipmentModel.findById(created.equipment_id);
    res.status(201).json({
      message: `${category.category_name} added`,
      view: viewKey,
      equipment_id: created.equipment_id,
      item: project(full || created, columns, customFields, customValues),
    });
  } catch (err) {
    next(err);
  }
}

// PUT /api/equipment/:view/:id
async function updateInView(req, res, next) {
  const viewKey = String(req.params.view || "").toLowerCase();

  try {
    const category = await viewColumnModel.findCategoryByViewKey(viewKey);
    if (!category)
      return res.status(404).json({ error: `No view called "${viewKey}"` });

    const columns = await viewColumnModel.findByCategory(category.category_id);
    const editable = columns
      .filter((c) => c.is_editable)
      .map((c) => c.field_name);

    const customFields = await customFieldModel.findByCategory(
      category.category_id,
    );
    const customKeys = customFields.map((f) => f.field_key);

    if (req.body.server_type && !SERVER_TYPES.includes(req.body.server_type)) {
      return res.status(400).json({
        error: `server_type must be one of: ${SERVER_TYPES.join(", ")}`,
      });
    }

    const ALWAYS_WRITABLE = [
      "status",
      "location",
      "remark",
      "owner_id",
      "department",
      "department_id",
      "license_id",
    ];
    const rejected = Object.keys(req.body).filter(
      (k) =>
        !editable.includes(k) &&
        !customKeys.includes(k) &&
        !ALWAYS_WRITABLE.includes(k) &&
        !DERIVED_READONLY.includes(k),
    );
    if (rejected.length > 0) {
      return res.status(400).json({
        error: `These fields do not apply to ${category.category_name}: ${rejected.join(", ")}`,
        allowed: editable,
      });
    }

    const writable = { ...req.body };
    for (const key of DERIVED_READONLY) delete writable[key];

    const existing = await equipmentModel.findById(req.params.id);
    if (!existing)
      return res.status(404).json({ error: "Equipment not found" });

    // Editing a laptop through the camera view would let camera-only rules
    // apply to it, so the category has to match.
    if (existing.category_name !== category.category_name) {
      return res.status(400).json({
        error: `Equipment ${req.params.id} is a ${existing.category_name}, not a ${category.category_name}`,
        hint: `Use /api/equipment/${String(existing.category_name).toLowerCase().replace(/ /g, "-")}/${req.params.id}`,
      });
    }

    await equipmentModel.update(req.params.id, writable);

    const customValues = {};
    for (const key of customKeys) {
      if (req.body[key] !== undefined) customValues[key] = req.body[key];
    }
    if (Object.keys(customValues).length > 0) {
      await customFieldModel.setValues(req.params.id, customValues);
    }

    const updated = await equipmentModel.findById(req.params.id);
    const allValues = await customFieldModel.getValues(req.params.id);
    const valueMap = {};
    for (const v of allValues) valueMap[v.field_key] = v.field_value;

    res.json({
      message: `${category.category_name} updated`,
      view: viewKey,
      item: project(updated, columns, customFields, valueMap),
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { getViews, getByView, createInView, updateInView };