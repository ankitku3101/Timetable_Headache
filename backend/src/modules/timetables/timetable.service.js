const AppError = require('../../common/errors/AppError');
const repo = require('./timetable.repository');
const Schedule = require('./schedule.model');
const { dispatchSolverJob } = require('./queue.service');
const { explainConflict } = require('../../integrations/gemini');
const notificationService = require('../notifications/notification.service');
const User = require('../users/user.model');
const checker = require('./constraint-checker.service');

const getAll = async (query) => {
  const { semesterId, deptId, status, page = 1, limit = 20 } = query;
  const filter = {};
  if (semesterId) filter.semester_id = semesterId;
  if (deptId) filter.dept_id = deptId;
  if (status) filter.status = status;
  const [data, total] = await repo.findSchedules(filter, parseInt(page), parseInt(limit));
  return { data, total, page: parseInt(page), limit: parseInt(limit) };
};

const getById = async (id) => {
  const schedule = await repo.findScheduleById(id);
  if (!schedule) throw new AppError('Schedule not found', 404, 'NOT_FOUND');
  return schedule;
};

const generate = async ({ semester_id, dept_id, section_id, faculty_allocation }) => {
  const scheduleData = { semester_id, dept_id, status: 'draft' };
  if (section_id) scheduleData.section_id = section_id;

  const schedule = await repo.createSchedule(scheduleData);

  const job = await repo.createSolverJob({
    schedule_id: schedule._id,
    dept_id,
    status: 'pending',
    queue_name: 'solver:jobs',
  });

  // Dispatch to Redis — Python worker picks this up
  const payload = {
    schedule_id: schedule._id.toString(),
    job_id: job._id.toString(),
    dept_id: dept_id.toString(),
    semester_id: semester_id.toString(),
  };
  if (section_id) payload.section_id = section_id.toString();
  // Optional: pass AI-suggested allocation so worker can pre-bind faculty to subjects
  if (faculty_allocation && Array.isArray(faculty_allocation)) {
    payload.faculty_allocation = faculty_allocation;
  }

  await dispatchSolverJob(payload);

  return { scheduleId: schedule._id, jobId: job._id, status: 'pending', section_id: section_id || null };
};

const getStatus = async (scheduleId) => {
  const jobs = await repo.findJobsBySchedule(scheduleId);
  if (!jobs.length) throw new AppError('No jobs found for this schedule', 404, 'NOT_FOUND');
  return jobs;
};

// SSE: polls job status from DB every 2s and streams updates to client
const streamStatus = async (scheduleId, send, onClose) => {
  const interval = setInterval(async () => {
    try {
      const jobs = await repo.findJobsBySchedule(scheduleId);
      if (!jobs.length) {
        send('error', { message: 'No jobs found' });
        clearInterval(interval);
        onClose();
        return;
      }

      const statuses = jobs.map((j) => ({
        jobId: j._id,
        dept_id: j.dept_id,
        status: j.status,
        error: j.error || null,
      }));

      const allSettled = jobs.every((j) => j.status === 'done' || j.status === 'failed');
      const anyRunning = jobs.some((j) => j.status === 'running');
      const anyPending = jobs.some((j) => j.status === 'pending');
      const anyFailed  = jobs.some((j) => j.status === 'failed');

      if (anyPending && !anyRunning) send('pending', { jobs: statuses });
      if (anyRunning) send('running', { jobs: statuses });

      if (allSettled) {
        clearInterval(interval);
        send(anyFailed ? 'failed' : 'completed', { jobs: statuses });
        onClose();
      }
    } catch {
      clearInterval(interval);
      onClose();
    }
  }, 2000);

  return () => clearInterval(interval);
};

const remove = async (scheduleId) => {
  const schedule = await repo.findScheduleById(scheduleId);
  if (!schedule) throw new AppError('Schedule not found', 404, 'NOT_FOUND');
  if (schedule.status === 'published') {
    throw new AppError('Published schedules cannot be deleted', 400, 'INVALID_STATE');
  }
  await repo.deleteSchedule(scheduleId);
  return { deleted: true };
};

const lock = async (scheduleId) => {
  const schedule = await repo.findScheduleById(scheduleId);
  if (!schedule) throw new AppError('Schedule not found', 404, 'NOT_FOUND');
  if (schedule.status !== 'draft') {
    throw new AppError('Only draft schedules can be locked', 400, 'INVALID_STATE');
  }
  return repo.updateSchedule(scheduleId, { 'sessions.$[].is_locked': true });
};

const publish = async (scheduleId) => {
  const schedule = await repo.findScheduleById(scheduleId);
  if (!schedule) throw new AppError('Schedule not found', 404, 'NOT_FOUND');
  if (schedule.status === 'published') {
    throw new AppError('Schedule is already published', 400, 'INVALID_STATE');
  }
  const updated = await repo.updateSchedule(scheduleId, {
    status: 'published',
    published_at: new Date(),
    version: schedule.version + 1,
  });

  // Notify all faculty in this department
  try {
    const deptId = schedule.dept_id?._id ?? schedule.dept_id;
    const facultyUsers = await User.find({ dept_id: deptId, role: 'faculty', status: 'active' }, '_id');
    const deptName = schedule.dept_id?.name ?? 'your department';
    await Promise.all(
      facultyUsers.map((u) =>
        notificationService.create(
          u._id,
          'timetable_published',
          'Timetable Published',
          `The timetable for ${deptName} has been published.`,
          schedule._id,
          'Schedule'
        )
      )
    );
  } catch (_) { /* non-critical — don't fail publish if notification errors */ }

  return updated;
};

const explainScheduleConflict = async (scheduleId) => {
  const jobs = await repo.findJobsBySchedule(scheduleId);
  const failedJobs = jobs.filter((j) => j.status === 'failed');
  if (!failedJobs.length) throw new AppError('No failed jobs to explain', 400, 'NO_CONFLICT');

  const explanation = await explainConflict({
    schedule_id: scheduleId,
    failed_jobs: failedJobs.map((j) => ({ dept_id: j.dept_id, error: j.error })),
  });

  return { explanation };
};

const moveSession = async (scheduleId, sessionIdx, newDay, newSlot) => {
  const schedule = await repo.findScheduleById(scheduleId);
  if (!schedule) throw new AppError('Schedule not found', 404, 'NOT_FOUND');
  if (schedule.status === 'published') {
    throw new AppError('Published timetables cannot be edited', 400, 'INVALID_STATE');
  }

  const idx = parseInt(sessionIdx, 10);
  if (Number.isNaN(idx) || idx < 0 || idx >= schedule.sessions.length) {
    throw new AppError('Invalid session index', 400, 'INVALID');
  }

  const day  = parseInt(newDay, 10);
  const slot = parseInt(newSlot, 10);
  if (Number.isNaN(day) || Number.isNaN(slot)) {
    throw new AppError('new_day and new_slot must be integers', 400, 'INVALID');
  }

  const deptId     = schedule.dept_id?._id     ?? schedule.dept_id;
  const semesterId = schedule.semester_id?._id  ?? schedule.semester_id;

  const result = await checker.validateMove({
    sessions:   schedule.sessions,
    movingIdx:  idx,
    newDay:     day,
    newSlot:    slot,
    deptId,
    semesterId,
  });

  if (!result.valid) {
    throw new AppError(result.reason, 400, 'CONSTRAINT_VIOLATION');
  }

  await Schedule.findByIdAndUpdate(scheduleId, {
    $set: {
      [`sessions.${idx}.day`]:  day,
      [`sessions.${idx}.slot`]: slot,
    },
  });

  return { moved: true };
};

const getSessionAlternatives = async (scheduleId, sessionIdx) => {
  const schedule = await repo.findScheduleById(scheduleId);
  if (!schedule) throw new AppError('Schedule not found', 404, 'NOT_FOUND');

  const idx = parseInt(sessionIdx, 10);
  if (Number.isNaN(idx) || idx < 0 || idx >= schedule.sessions.length) {
    throw new AppError('Invalid session index', 400, 'INVALID');
  }

  const deptId     = schedule.dept_id?._id     ?? schedule.dept_id;
  const semesterId = schedule.semester_id?._id  ?? schedule.semester_id;

  return checker.getAlternatives({
    sessions:   schedule.sessions,
    movingIdx:  idx,
    deptId,
    semesterId,
  });
};

const reset = async (scheduleId) => {
  const schedule = await repo.findScheduleById(scheduleId);
  if (!schedule) throw new AppError('Schedule not found', 404, 'NOT_FOUND');
  if (schedule.status === 'published') {
    throw new AppError('Published timetables cannot be reset', 400, 'INVALID_STATE');
  }
  if (!schedule.original_sessions?.length) {
    throw new AppError('No original snapshot available for this timetable', 400, 'NO_SNAPSHOT');
  }
  await Schedule.findByIdAndUpdate(scheduleId, {
    $set: { sessions: schedule.original_sessions },
  });
  return { reset: true };
};

module.exports = { getAll, getById, generate, getStatus, streamStatus, remove, lock, publish, explainScheduleConflict, moveSession, getSessionAlternatives, reset };
