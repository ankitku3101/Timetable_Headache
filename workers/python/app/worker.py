import os
import json
import time
import datetime
import redis
import pymongo
from bson import ObjectId
from dotenv import load_dotenv
from solver import solve

load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), '../../..', 'backend', '.env'))

REDIS_URL   = os.environ.get('REDIS_URL', 'redis://localhost:6379')
MONGODB_URI = os.environ.get('MONGODB_URI')
QUEUE_KEY   = 'solver:jobs'

# ── Connections ───────────────────────────────────────────────
use_ssl = REDIS_URL.startswith('rediss://')
r = redis.Redis.from_url(REDIS_URL, ssl_cert_reqs=None if use_ssl else 'required', decode_responses=True)

mongo_client = pymongo.MongoClient(MONGODB_URI)
db_name = pymongo.uri_parser.parse_uri(MONGODB_URI).get('database') or 'headache_solver'
db = mongo_client[db_name]


def oid(s):
    return ObjectId(str(s))


def update_job(job_id, status, result=None, error=None, duration_ms=None):
    update = {'status': status, 'updated_at': datetime.datetime.utcnow()}
    if result is not None:
        update['result'] = result
    if error is not None:
        update['error'] = error
    if duration_ms is not None:
        update['duration_ms'] = duration_ms
    db.solverjobs.update_one({'_id': oid(job_id)}, {'$set': update})


def load_data(dept_id, semester_id, section_id=None):
    # If a section_id is provided, load only the subjects assigned to that section.
    # Otherwise load all department subjects.
    if section_id:
        section_doc = db.sections.find_one({'_id': oid(section_id)})
        if section_doc and section_doc.get('subjects'):
            subject_ids = section_doc['subjects']
            subject_list = list(db.subjects.find({'_id': {'$in': subject_ids}, 'active': True}))
        else:
            # Section has no overridden subjects — fall back to dept subjects
            subject_list = list(db.subjects.find({'dept_id': oid(dept_id), 'active': True}))
    else:
        subject_list = list(db.subjects.find({'dept_id': oid(dept_id), 'active': True}))

    faculty_list = list(db.faculties.find({'dept_id': oid(dept_id), 'status': 'active'}))
    room_list    = list(db.rooms.find({'active': True}))
    constraints  = list(db.constraints.find({
        'dept_id':     oid(dept_id),
        'semester_id': oid(semester_id),
        'status':      'active',
    }))

    # Convert ObjectId fields to strings so solver can handle them
    for doc in faculty_list + subject_list + room_list + constraints:
        doc['_id'] = str(doc['_id'])
        for key in ('dept_id', 'user_id', 'semester_id', 'created_by'):
            if key in doc and doc[key]:
                doc[key] = str(doc[key])

    return faculty_list, subject_list, room_list, constraints


def apply_faculty_allocation(faculty_list, subject_list, faculty_allocation):
    """
    Pre-bind faculty to subjects using the AI-suggested allocation.
    Returns a dict: {subject_id -> faculty_id} for the solver to use as hints.
    Validates that both IDs exist in the loaded lists before using them.
    """
    faculty_ids = {f['_id'] for f in faculty_list}
    subject_ids = {s['_id'] for s in subject_list}

    allocation_map = {}
    for alloc in faculty_allocation:
        fid = alloc.get('faculty_id')
        sid = alloc.get('subject_id')
        if fid in faculty_ids and sid in subject_ids:
            allocation_map[sid] = fid

    return allocation_map


def process_job(job):
    schedule_id      = job['schedule_id']
    job_id           = job['job_id']
    dept_id          = job['dept_id']
    semester_id      = job['semester_id']
    section_id       = job.get('section_id')
    faculty_alloc    = job.get('faculty_allocation')  # optional AI suggestions

    print(f'[WORKER] Processing job {job_id} for schedule {schedule_id}'
          + (f' section={section_id}' if section_id else ''))
    update_job(job_id, 'running')

    start = time.time()
    try:
        faculty_list, subject_list, room_list, constraints = load_data(
            dept_id, semester_id, section_id
        )

        if not faculty_list:
            raise ValueError(f'No faculty found for dept {dept_id}')
        if not subject_list:
            raise ValueError(f'No subjects found for dept {dept_id}')
        if not room_list:
            raise ValueError('No rooms available')

        # Build allocation hint from AI suggestion if provided
        allocation_map = {}
        if faculty_alloc:
            allocation_map = apply_faculty_allocation(faculty_list, subject_list, faculty_alloc)

        sessions, status = solve(faculty_list, subject_list, room_list, constraints, allocation_map)
        duration = int((time.time() - start) * 1000)

        if status == 'INFEASIBLE':
            update_job(job_id, 'failed',
                       error='CP-SAT returned INFEASIBLE — constraints cannot be satisfied',
                       duration_ms=duration)
            print(f'[WORKER] Job {job_id} INFEASIBLE')
            return

        # Post-solve: log all sessions for quick verification
        DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
        print(f'[WORKER] Session dump ({len(sessions)} total):')
        for sess in sessions:
            fid  = sess.get('faculty_id', '?')
            sid  = sess.get('subject_id', '?')
            day  = sess.get('day', '?')
            slot = sess.get('slot', '?')
            dur  = sess.get('duration_slots', 1)
            # Resolve names from loaded lists for readability
            fac_name  = next((f.get('name', fid) for f in faculty_list if str(f['_id']) == str(fid)), fid)
            subj_code = next((s.get('code', sid) for s in subject_list if str(s['_id']) == str(sid)), sid)
            subj_type = next((s.get('type', '') for s in subject_list if str(s['_id']) == str(sid)), '')
            day_name  = DAY_NAMES[day - 1] if isinstance(day, int) and 1 <= day <= 6 else str(day)
            print(f'[WORKER]   {fac_name:<25} {subj_code:<10} ({subj_type:<8}) {day_name} slot={slot} dur={dur}')

        # Write sessions back to schedule; preserve original_sessions as the immutable baseline
        db.schedules.update_one(
            {'_id': oid(schedule_id)},
            {'$set': {'sessions': sessions, 'original_sessions': sessions, 'status': 'draft'}}
        )

        update_job(job_id, 'done',
                   result={'session_count': len(sessions), 'solver_status': status},
                   duration_ms=duration)
        print(f'[WORKER] Job {job_id} done — {len(sessions)} sessions ({status}) in {duration}ms')

    except Exception as e:
        duration = int((time.time() - start) * 1000)
        update_job(job_id, 'failed', error=str(e), duration_ms=duration)
        print(f'[WORKER] Job {job_id} failed: {e}')


def main():
    print(f'[WORKER] Listening on queue: {QUEUE_KEY}')
    while True:
        try:
            result = r.brpop(QUEUE_KEY, timeout=5)
            if result:
                _, payload = result
                job = json.loads(payload)
                process_job(job)
        except Exception as e:
            print(f'[WORKER] Queue error: {e}')
            time.sleep(2)


if __name__ == '__main__':
    main()
