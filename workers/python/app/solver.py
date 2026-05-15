from ortools.sat.python import cp_model


def solve(faculty_list, subject_list, room_list, constraints, allocation_map=None):
    """
    Inputs:
      faculty_list    : [{ _id, availability[[bool]*8]*6, max_hours_per_week, expertise, preferences }]
      subject_list    : [{ _id, sessions_per_week, session_duration_slots, room_type_required, type, name, code }]
      room_list       : [{ _id, type, blocked_slots:[{day,slot}] }]
      constraints     : [{ type, parsed_json }]
      allocation_map  : { subject_id -> faculty_id }  (AI-suggested pre-binding, optional)

    Returns:
      sessions : [{ faculty_id, subject_id, room_id, day, slot, duration_slots, batch }]
      status   : "OPTIMAL" | "FEASIBLE" | "INFEASIBLE"
    """

    DAYS  = 6   # Mon–Sat
    SLOTS = 8   # 8 periods/day
    MAX_CONSECUTIVE = 3

    # ── PRE-PROCESS CONSTRAINTS ───────────────────────────────
    # Build lookup: faculty name (lowercase) → index in faculty_list
    faculty_name_index = {
        fac.get('name', '').lower(): i for i, fac in enumerate(faculty_list)
    }
    # Build lookup: subject code (uppercase) → index in subject_list
    subject_code_index = {
        subj.get('code', '').upper(): i for i, subj in enumerate(subject_list)
    }

    def _match_faculty_name(query_name):
        """
        Return list of faculty indices whose name matches query_name.
        Matching strategy (most-specific first):
          1. Exact full-name match.
          2. Query is a substring of a stored name or vice-versa.
          3. Any significant word (len > 2) in the query appears in a stored name.
        Returns all matches found at the first level that produces hits.
        """
        q = query_name.lower().strip()
        if not q:
            return []
        # Level 1 – exact
        if q in faculty_name_index:
            return [faculty_name_index[q]]
        # Level 2 – substring
        lvl2 = [fidx for fname, fidx in faculty_name_index.items()
                if q in fname or fname in q]
        if lvl2:
            return lvl2
        # Level 3 – significant-word overlap
        q_words = {w for w in q.split() if len(w) > 2}
        lvl3 = [fidx for fname, fidx in faculty_name_index.items()
                if q_words & {w for w in fname.split() if len(w) > 2}]
        return lvl3

    def _clean_days(raw):
        """Convert raw day list to validated ints in [0, DAYS). Silently drop bad values."""
        out = []
        for v in (raw or []):
            try:
                d = int(v)
                if 0 <= d < DAYS:
                    out.append(d)
            except (TypeError, ValueError):
                pass
        return out

    def _clean_slots(raw):
        """Convert raw slot list to validated ints in [0, SLOTS). Silently drop bad values."""
        out = []
        for v in (raw or []):
            try:
                t = int(v)
                if 0 <= t < SLOTS:
                    out.append(t)
            except (TypeError, ValueError):
                pass
        return out

    # Parsed constraint rules extracted from DB constraints
    extra_unavailable = {}   # (f_idx, d, t) → True  (block this slot for this faculty)
    extra_max_consecutive = {}  # f_idx → max_consecutive override
    subject_time_blocks = {}    # (s_idx, d, t) → True  (block this slot for this subject)

    DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

    print(f'[SOLVER] Processing {len(constraints)} constraint(s) from DB')
    for c in constraints:
        if c.get('status') != 'active':
            continue
        try:
            pj = c.get('parsed_json') or {}
            if not isinstance(pj, dict):
                continue
            rule = pj.get('rule') or {}
            entities = pj.get('entities') or {}
            if not isinstance(rule, dict):
                continue

            faculty_name_query = entities.get('faculty_name') or ''
            # Resolve faculty by name
            f_indices = _match_faculty_name(faculty_name_query)

            # Resolve subject by code
            s_code = (entities.get('subject_code') or '').upper().strip()
            s_indices = [subject_code_index[s_code]] if s_code in subject_code_index else []

            unavail_days  = _clean_days(rule.get('unavailable_days'))
            unavail_slots = _clean_slots(rule.get('unavailable_slots'))
            max_consec    = rule.get('max_consecutive')

            # --- Diagnostic log for every constraint ---
            matched_names = [faculty_list[fi]['name'] for fi in f_indices] if f_indices else []
            print(f'[SOLVER] Constraint: "{pj.get("summary", c.get("_id"))}"')
            if faculty_name_query:
                if f_indices:
                    print(f'[SOLVER]   Faculty query "{faculty_name_query}" → matched {matched_names} (indices {f_indices})')
                else:
                    print(f'[SOLVER]   Faculty query "{faculty_name_query}" → NO MATCH in faculty list')
                    print(f'[SOLVER]   Available faculty names: {list(faculty_name_index.keys())}')
            if unavail_days:
                day_names = [DAY_NAMES[d] for d in unavail_days if 0 <= d < len(DAY_NAMES)]
                print(f'[SOLVER]   Blocking days: {unavail_days} ({day_names})')
            if unavail_slots:
                print(f'[SOLVER]   Blocking slots: {unavail_slots}')
            if not f_indices and not s_indices:
                print(f'[SOLVER]   WARNING: constraint has no matched faculty or subject — will be ignored')

            # Apply faculty unavailability
            if f_indices and (unavail_days or unavail_slots):
                for fi in f_indices:
                    if unavail_days and not unavail_slots:
                        # Block entire day for faculty
                        for d in unavail_days:
                            for t in range(SLOTS):
                                extra_unavailable[(fi, d, t)] = True
                    elif unavail_slots and not unavail_days:
                        # Block specific slots on all days
                        for t in unavail_slots:
                            for d in range(DAYS):
                                extra_unavailable[(fi, d, t)] = True
                    else:
                        # Block specific slots on specific days
                        for d in unavail_days:
                            for t in unavail_slots:
                                extra_unavailable[(fi, d, t)] = True

            # Apply max consecutive override for faculty
            if f_indices and max_consec is not None:
                for fi in f_indices:
                    extra_max_consecutive[fi] = int(max_consec)

            # Apply subject timing blocks
            if s_indices and (unavail_days or unavail_slots):
                for si in s_indices:
                    if unavail_days and not unavail_slots:
                        for d in unavail_days:
                            for t in range(SLOTS):
                                subject_time_blocks[(si, d, t)] = True
                    elif unavail_slots and not unavail_days:
                        for t in unavail_slots:
                            for d in range(DAYS):
                                subject_time_blocks[(si, d, t)] = True
                    else:
                        for d in unavail_days:
                            for t in unavail_slots:
                                subject_time_blocks[(si, d, t)] = True

        except Exception as exc:
            print(f'[SOLVER] Skipping malformed constraint (id={c.get("_id")}): {exc}')
            continue

    print(f'[SOLVER] Constraints applied: {len(extra_unavailable)} faculty slot-blocks, '
          f'{len(subject_time_blocks)} subject slot-blocks')

    model = cp_model.CpModel()

    F = len(faculty_list)
    S = len(subject_list)
    R = len(room_list)

    if allocation_map is None:
        allocation_map = {}

    # Per-subject slot duration (how many consecutive slots each session occupies)
    durations = [max(1, int(subj.get('session_duration_slots', 1))) for subj in subject_list]

    # Per-subject batch count — labs split students into batches that run as separate sessions
    batch_counts = [max(1, int(subj.get('batch_count', 1))) for subj in subject_list]

    # ── ELIGIBILITY ───────────────────────────────────────────────

    def faculty_can_teach(fac, subj):
        # Hard block: never assign faculty to a subject from a different department
        if str(fac.get('dept_id', '')) != str(subj.get('dept_id', '')):
            return False
        s_id = str(subj.get('_id', ''))
        if allocation_map and s_id in allocation_map:
            return str(fac.get('_id', '')) == allocation_map[s_id]
        expertise = [e.lower() for e in fac.get('expertise', [])]
        if not expertise:
            return True
        subj_name = subj.get('name', '').lower()
        subj_code = subj.get('code', '').lower()
        for kw in expertise:
            if kw in subj_name or kw in subj_code:
                return True
        if fac.get('type') == 'lab_assistant':
            return subj.get('type') == 'lab'
        return False

    eligible = {}
    for s in range(S):
        for f in range(F):
            eligible[(s, f)] = faculty_can_teach(faculty_list[f], subject_list[s])

    # Fallback: if no faculty eligible for a subject, allow all
    for s in range(S):
        if not any(eligible[(s, f)] for f in range(F)):
            print(f'[SOLVER] Fallback: no eligible faculty for "{subject_list[s].get("code","?")} {subject_list[s].get("name","?")}" — allowing all faculty')
            for f in range(F):
                eligible[(s, f)] = True

    # Log which subjects each constrained faculty is eligible for
    constrained_faculty = set(fi for (fi, d, t) in extra_unavailable)
    for fi in constrained_faculty:
        fname = faculty_list[fi].get('name', f'idx={fi}')
        eligible_subjects = [
            f'{subject_list[s].get("code","?")}({subject_list[s].get("type","?")})'
            for s in range(S) if eligible[(s, fi)]
        ]
        print(f'[SOLVER] Constrained faculty "{fname}" is eligible for: {eligible_subjects}')

    # ── VARIABLES ─────────────────────────────────────────────────
    # x[s,f,r,d,t] = 1 means subject s by faculty f in room r on day d starting at slot t.
    # For a subject with duration D, t ranges from 0 to SLOTS-D (the session occupies t..t+D-1).
    x = {}
    for s in range(S):
        dur = durations[s]
        for f in range(F):
            if not eligible[(s, f)]:
                continue
            for r in range(R):
                for d in range(DAYS):
                    for t in range(SLOTS - dur + 1):
                        x[(s, f, r, d, t)] = model.NewBoolVar(f'x_{s}_{f}_{r}_{d}_{t}')

    # ── HELPERS ───────────────────────────────────────────────────

    def sessions_covering_faculty(f, d, phys_slot):
        """All x-vars where faculty f is busy during physical slot phys_slot on day d."""
        result = []
        for s in range(S):
            if not eligible[(s, f)]:
                continue
            dur = durations[s]
            for ts in range(max(0, phys_slot - dur + 1), min(phys_slot + 1, SLOTS - dur + 1)):
                for r in range(R):
                    if (s, f, r, d, ts) in x:
                        result.append(x[(s, f, r, d, ts)])
        return result

    def sessions_covering_room(r, d, phys_slot):
        """All x-vars where room r is occupied during physical slot phys_slot on day d."""
        result = []
        for s in range(S):
            dur = durations[s]
            for ts in range(max(0, phys_slot - dur + 1), min(phys_slot + 1, SLOTS - dur + 1)):
                for f in range(F):
                    if eligible[(s, f)] and (s, f, r, d, ts) in x:
                        result.append(x[(s, f, r, d, ts)])
        return result

    # ── HARD CONSTRAINTS ─────────────────────────────────────────

    # 1. Each subject gets exactly sessions_per_week * batch_count sessions total.
    #    For batch subjects (labs), each "batch" is a separate scheduling unit so the
    #    solver places batch_count independent sessions per week (one per batch group).
    for s_idx, subj in enumerate(subject_list):
        needed = subj.get('sessions_per_week', 1) * batch_counts[s_idx]
        dur = durations[s_idx]
        terms = [x[(s_idx, f, r, d, t)]
                 for f in range(F) if eligible[(s_idx, f)]
                 for r in range(R)
                 for d in range(DAYS)
                 for t in range(SLOTS - dur + 1)
                 if (s_idx, f, r, d, t) in x]
        if terms:
            model.Add(sum(terms) == needed)

    # 2. Faculty can cover at most one session at each physical slot
    for f in range(F):
        for d in range(DAYS):
            for T in range(SLOTS):
                terms = sessions_covering_faculty(f, d, T)
                if terms:
                    model.Add(sum(terms) <= 1)

    # 3. Room can host at most one session at each physical slot
    for r in range(R):
        for d in range(DAYS):
            for T in range(SLOTS):
                terms = sessions_covering_room(r, d, T)
                if terms:
                    model.Add(sum(terms) <= 1)

    # 4. Faculty availability (block sessions covering unavailable physical slots)
    for f_idx, fac in enumerate(faculty_list):
        avail = fac.get('availability', [[True] * SLOTS for _ in range(DAYS)])
        for d in range(DAYS):
            row = avail[d] if d < len(avail) else [True] * SLOTS
            for T in range(SLOTS):
                if T < len(row) and not row[T]:
                    for term in sessions_covering_faculty(f_idx, d, T):
                        model.Add(term == 0)

    # 4b. Constraint-derived faculty unavailability (from parsed DB constraints)
    for (fi, d, T), _ in extra_unavailable.items():
        for term in sessions_covering_faculty(fi, d, T):
            model.Add(term == 0)

    # 4c. Constraint-derived subject time blocks
    for (si, d, T), _ in subject_time_blocks.items():
        dur = durations[si]
        for f in range(F):
            if not eligible[(si, f)]:
                continue
            for r in range(R):
                for ts in range(max(0, T - dur + 1), min(T + 1, SLOTS - dur + 1)):
                    if (si, f, r, d, ts) in x:
                        model.Add(x[(si, f, r, d, ts)] == 0)

    # 5. Room type must match subject requirement
    for s_idx, subj in enumerate(subject_list):
        required_type = subj.get('room_type_required')
        if required_type:
            dur = durations[s_idx]
            for r_idx, room in enumerate(room_list):
                if room.get('type', '').lower() != required_type.lower():
                    for f in range(F):
                        if not eligible[(s_idx, f)]:
                            continue
                        for d in range(DAYS):
                            for t in range(SLOTS - dur + 1):
                                if (s_idx, f, r_idx, d, t) in x:
                                    model.Add(x[(s_idx, f, r_idx, d, t)] == 0)

    # 6. Room blocked slots (block sessions that cover a blocked physical slot)
    for r_idx, room in enumerate(room_list):
        for blocked in room.get('blocked_slots', []):
            d, T = blocked.get('day', -1), blocked.get('slot', -1)
            if 0 <= d < DAYS and 0 <= T < SLOTS:
                for term in sessions_covering_room(r_idx, d, T):
                    model.Add(term == 0)

    # 7. Faculty workload: total teaching hours (a dur-slot session = dur hours)
    for f_idx, fac in enumerate(faculty_list):
        max_h = fac.get('max_hours_per_week', 20)
        terms = []
        for s in range(S):
            if not eligible[(s, f_idx)]:
                continue
            dur = durations[s]
            for r in range(R):
                for d in range(DAYS):
                    for t in range(SLOTS - dur + 1):
                        if (s, f_idx, r, d, t) in x:
                            terms.append(x[(s, f_idx, r, d, t)] * dur)
        if terms:
            model.Add(sum(terms) <= max_h)

    # 8. Max consecutive teaching slots — build occupied[f,d,T] indicators then window-check
    occupied = {}
    for f in range(F):
        for d in range(DAYS):
            for T in range(SLOTS):
                terms = sessions_covering_faculty(f, d, T)
                if terms:
                    occ = model.NewBoolVar(f'occ_{f}_{d}_{T}')
                    occupied[(f, d, T)] = occ
                    model.Add(sum(terms) == occ)  # safe: sum in {0,1} from constraint 2

    for f_idx in range(F):
        max_consec = extra_max_consecutive.get(f_idx, MAX_CONSECUTIVE)
        for d in range(DAYS):
            for start_t in range(SLOTS - max_consec + 1):
                window = [occupied[(f_idx, d, T)]
                          for T in range(start_t, start_t + max_consec)
                          if (f_idx, d, T) in occupied]
                if window:
                    model.Add(sum(window) <= max_consec)

    # ── SOFT CONSTRAINTS ─────────────────────────────────────────
    penalties = []

    # Penalty 1: Faculty teaching during avoid_slots
    for f_idx, fac in enumerate(faculty_list):
        for slot_pref in fac.get('preferences', {}).get('avoid_slots', []):
            d, T = slot_pref.get('day', -1), slot_pref.get('slot', -1)
            if 0 <= d < DAYS and 0 <= T < SLOTS:
                penalties.extend(sessions_covering_faculty(f_idx, d, T))

    # Penalty 2: Spread sessions — penalise more sessions of same subject on same day
    # than there are batches (e.g., a single-batch subject must not repeat on the same day;
    # a 3-batch lab may have up to 3 sessions per day, one per batch).
    for s_idx, subj in enumerate(subject_list):
        dur = durations[s_idx]
        bc  = batch_counts[s_idx]
        max_per_week = subj.get('sessions_per_week', 1) * bc
        for d in range(DAYS):
            day_vars = [x[(s_idx, f, r, d, t)]
                        for f in range(F) if eligible[(s_idx, f)]
                        for r in range(R)
                        for t in range(SLOTS - dur + 1)
                        if (s_idx, f, r, d, t) in x]
            if len(day_vars) >= 2:
                day_count = model.NewIntVar(0, max_per_week, f'dc_{s_idx}_{d}')
                model.Add(day_count == sum(day_vars))
                overcrowded = model.NewIntVar(0, max_per_week, f'oc_{s_idx}_{d}')
                model.Add(overcrowded >= day_count - bc)
                penalties.append(overcrowded)

    # Penalty 3: Spread sessions across the day — penalise >1 session in same (day, slot)
    for d in range(DAYS):
        for t in range(SLOTS):
            slot_vars = [x[(s, f, r, d, t)]
                         for s in range(S)
                         for f in range(F) if eligible[(s, f)]
                         for r in range(R)
                         if (s, f, r, d, t) in x]
            if len(slot_vars) >= 2:
                slot_count = model.NewIntVar(0, S, f'sc_{d}_{t}')
                model.Add(slot_count == sum(slot_vars))
                overcrowded_slot = model.NewIntVar(0, S, f'ocs_{d}_{t}')
                model.Add(overcrowded_slot >= slot_count - 1)
                penalties.append(overcrowded_slot)

    if penalties:
        model.Minimize(sum(penalties))

    # ── SOLVE ─────────────────────────────────────────────────────
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = 60
    solver.parameters.num_search_workers = 4

    status = solver.Solve(model)

    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return [], 'INFEASIBLE'

    sessions = []
    # Track how many sessions per subject have been emitted so we can assign batch numbers.
    subject_session_count = [0] * S
    for s_idx, subj in enumerate(subject_list):
        dur = durations[s_idx]
        bc  = batch_counts[s_idx]
        for f_idx, fac in enumerate(faculty_list):
            if not eligible[(s_idx, f_idx)]:
                continue
            for r_idx, room in enumerate(room_list):
                for d in range(DAYS):
                    for t in range(SLOTS - dur + 1):
                        if (s_idx, f_idx, r_idx, d, t) in x and solver.Value(x[(s_idx, f_idx, r_idx, d, t)]) == 1:
                            batch_num = (subject_session_count[s_idx] % bc) + 1
                            subject_session_count[s_idx] += 1
                            sessions.append({
                                'faculty_id':     str(fac['_id']),
                                'subject_id':     str(subj['_id']),
                                'room_id':        str(room['_id']),
                                'day':            d + 1,   # 1=Mon … 6=Sat
                                'slot':           t,
                                'duration_slots': dur,
                                'is_locked':      False,
                                'batch':          batch_num,
                            })

    status_str = 'OPTIMAL' if status == cp_model.OPTIMAL else 'FEASIBLE'
    return sessions, status_str
