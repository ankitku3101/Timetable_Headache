const service = require('./timetable.service');
const { success } = require('../../common/utils/response');
const { setupSSE } = require('../../integrations/sse');

const getAll = async (req, res, next) => {
  try {
    const result = await service.getAll(req.query);
    success(res, result.data, 200, { total: result.total, page: result.page, limit: result.limit });
  } catch (err) { next(err); }
};

const getById = async (req, res, next) => {
  try { success(res, await service.getById(req.params.scheduleId)); } catch (err) { next(err); }
};

const generate = async (req, res, next) => {
  try { success(res, await service.generate(req.body), 202); } catch (err) { next(err); }
};

const getStatus = async (req, res, next) => {
  try { success(res, await service.getStatus(req.params.scheduleId)); } catch (err) { next(err); }
};

const stream = async (req, res, next) => {
  try {
    const { scheduleId } = req.params;
    const { send, close } = setupSSE(res);
    send('connected', { scheduleId });
    const cancel = await service.streamStatus(scheduleId, send, close);
    req.on('close', cancel);
  } catch (err) { next(err); }
};

const lock = async (req, res, next) => {
  try { success(res, await service.lock(req.params.scheduleId)); } catch (err) { next(err); }
};

const publish = async (req, res, next) => {
  try { success(res, await service.publish(req.params.scheduleId)); } catch (err) { next(err); }
};

const explainConflict = async (req, res, next) => {
  try { success(res, await service.explainScheduleConflict(req.params.scheduleId)); } catch (err) { next(err); }
};

const remove = async (req, res, next) => {
  try { success(res, await service.remove(req.params.scheduleId)); } catch (err) { next(err); }
};

const moveSession = async (req, res, next) => {
  try {
    const { scheduleId, sessionIdx } = req.params;
    const { new_day, new_slot } = req.body;
    success(res, await service.moveSession(scheduleId, sessionIdx, new_day, new_slot));
  } catch (err) { next(err); }
};

const getAlternatives = async (req, res, next) => {
  try {
    const { scheduleId, sessionIdx } = req.params;
    success(res, await service.getSessionAlternatives(scheduleId, sessionIdx));
  } catch (err) { next(err); }
};

const reset = async (req, res, next) => {
  try { success(res, await service.reset(req.params.scheduleId)); } catch (err) { next(err); }
};

module.exports = { getAll, getById, generate, getStatus, stream, lock, publish, explainConflict, remove, moveSession, getAlternatives, reset };
