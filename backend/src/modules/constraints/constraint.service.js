const AppError = require('../../common/errors/AppError');
const repo = require('./constraint.repository');
const { parseConstraintText } = require('../../integrations/gemini');

const getAll = async (query) => {
  const { semesterId, deptId, type, page = 1, limit = 20 } = query;
  const filter = {};
  if (semesterId) filter.semester_id = semesterId;
  if (deptId) filter.dept_id = deptId;
  if (type) filter.type = type;
  const [data, total] = await repo.findAll(filter, parseInt(page), parseInt(limit));
  return { data, total, page: parseInt(page), limit: parseInt(limit) };
};

const getById = async (id) => {
  const constraint = await repo.findById(id);
  if (!constraint) throw new AppError('Constraint not found', 404, 'NOT_FOUND');
  return constraint;
};

const create = async (data, userId) => {
  let payload = { ...data, created_by: userId };

  // Auto-parse raw_text via Gemini if no parsed_json was supplied
  if (data.raw_text && !data.parsed_json) {
    try {
      const context = { dept: data.dept_id, semester: data.semester_id };
      const parsed_json = validateParsedJson(
        await parseConstraintText(data.raw_text, context),
        data.raw_text
      );
      payload.parsed_json = parsed_json;
      payload.type = parsed_json.type || payload.type || 'soft';
      payload.weight = parsed_json.weight || payload.weight || 1;
    } catch (err) {
      // Log but don't block — constraint saves without parsed_json, solver will skip it
      console.warn('[constraint.service] Gemini parse failed during create, saving without parsed_json:', err.message);
    }
  }

  return repo.create(payload);
};

const update = async (id, data) => {
  const constraint = await repo.update(id, data);
  if (!constraint) throw new AppError('Constraint not found', 404, 'NOT_FOUND');
  return constraint;
};

const remove = async (id) => {
  const constraint = await repo.remove(id);
  if (!constraint) throw new AppError('Constraint not found', 404, 'NOT_FOUND');
};

const VALID_TYPES = new Set(['hard', 'soft']);

const validateParsedJson = (parsed_json, raw_text) => {
  if (!parsed_json || typeof parsed_json !== 'object' || Array.isArray(parsed_json)) {
    throw new AppError('Constraint parsing returned invalid structure', 422, 'PARSE_ERROR');
  }
  if (!parsed_json.rule || typeof parsed_json.rule !== 'object') {
    throw new AppError(
      `Could not extract a structured rule from: "${raw_text}". Try rephrasing the constraint.`,
      422,
      'PARSE_ERROR'
    );
  }
  if (!VALID_TYPES.has(parsed_json.type)) {
    parsed_json.type = 'soft';
  }
  if (!parsed_json.entities || typeof parsed_json.entities !== 'object') {
    parsed_json.entities = {};
  }
  return parsed_json;
};

// LLM: parse raw text → structured constraint JSON, optionally save it
const parse = async ({ raw_text, semester_id, dept_id, auto_save }, userId) => {
  const context = { dept: dept_id, semester: semester_id };
  const parsed_json = validateParsedJson(
    await parseConstraintText(raw_text, context),
    raw_text
  );

  if (!auto_save) return { raw_text, parsed_json };

  const saved = await repo.create({
    semester_id,
    dept_id,
    raw_text,
    parsed_json,
    type: parsed_json.type,
    weight: parsed_json.weight || 1,
    status: 'active',
    created_by: userId,
  });

  return { raw_text, parsed_json, saved };
};

module.exports = { getAll, getById, create, update, remove, parse };
