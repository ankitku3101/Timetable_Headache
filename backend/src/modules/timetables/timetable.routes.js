const router = require('express').Router();
const controller = require('./timetable.controller');
const { authenticate, authorize } = require('../../common/middleware/auth.middleware');

router.use(authenticate);

router.get('/', controller.getAll);
router.post('/generate', authorize('admin', 'hod'), controller.generate);
router.get('/:scheduleId', controller.getById);
router.get('/:scheduleId/status', controller.getStatus);
router.get('/:scheduleId/stream', controller.stream);
router.get('/:scheduleId/explain', controller.explainConflict);
router.delete('/:scheduleId', authorize('admin', 'hod'), controller.remove);
router.post('/:scheduleId/lock', authorize('admin', 'hod'), controller.lock);
router.post('/:scheduleId/publish', authorize('admin'), controller.publish);
router.get('/:scheduleId/sessions/:sessionIdx/alternatives', authorize('admin', 'hod'), controller.getAlternatives);
router.patch('/:scheduleId/sessions/:sessionIdx/move', authorize('admin', 'hod'), controller.moveSession);
router.post('/:scheduleId/reset', authorize('admin', 'hod'), controller.reset);

module.exports = router;
