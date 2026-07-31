const searchModel = require('../models/searchModel');

async function universalSearch(req, res, next) {
  const term = req.query.q;
  if (!term || term.trim() === '') {
    return res.status(400).json({
      error: 'Query parameter "q" is required, e.g. /api/search?q=Fongmoua',
    });
  }
  try {
    const results = await searchModel.searchAll(term);
    res.json({ query: term, count: results.length, results });
  } catch (err) {
    next(err);
  }
}

module.exports = { universalSearch };
