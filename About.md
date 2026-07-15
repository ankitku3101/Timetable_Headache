# Timetable Optimizer — About

## What it is

A university timetable generation system where admins, HODs, and faculty configure schedules, and an optimization engine automatically generates conflict-free timetables.

---

## Core Idea

The hard scheduling problem (semester timetable) is solved by a **Python CP-SAT solver** (Google OR-Tools). Daily operational changes (absences, room blocks) use a **lightweight greedy algorithm** — never the heavy solver.

---

## Stack at a Glance

| What | Tech |
|---|---|
| Frontend | Next.js + TypeScript + Tailwind + shadcn/ui (Vercel) |
| Backend | Express.js (modular monolith, Docker on AWS EC2) |
| Database | MongoDB Atlas |
| Queue | Redis (Docker container on the same EC2 instance) |
| Solver | Python OR-Tools CP-SAT (worker, Docker on AWS EC2) |
| Streaming | SSE (Server-Sent Events) |
| AI | Gemini API (2 use cases only) |

---

## Two LLM Touchpoints

The Gemini API is intentionally limited to:
1. **Constraint parsing** — convert natural language rules into structured constraints
2. **Conflict explanation** — explain why a timetable is infeasible

---

## Key Design Rules

- Published timetables are **immutable**
- Daily overrides are **append-only**
- Express **orchestrates**, Python **solves** — logic is never mixed
- One Redis job per department — workers run in parallel

---

## Implementation Phases

### Phase 1
Core CRUD + single CP-SAT worker + static timetable grid UI

### Phase 2
SSE streaming + conflict panel UI + LLM constraint parsing

### Phase 3
Daily overrides + greedy substitute/room-swap logic + calendar blocking

### Phase 4
Cross-department reconciliation + exports + analytics + fairness metrics

LOGIN PAGE
    ↓
ADMIN DASHBOARD
    ├── Setup (one time, start of year)
    │     ├── Departments      → create CSE, CIVIL, ECE...
    │     ├── Rooms            → Room 311, CS Lab 1...
    │     ├── Users            → create HOD + faculty accounts
    │     ├── Faculty          → availability grids, expertise
    │     ├── Subjects         → sessions/week, lab/theory
    │     └── Calendar         → semester dates, holidays
    │
    ├── Timetable (per semester)
    │     ├── Constraints      → type or use AI to add rules
    │     ├── Generate         → click button → watch SSE progress bar
    │     ├── Review grid      → day×slot timetable view
    │     ├── Lock → Publish   → goes live
    │     └── Export           → PDF for notice board, iCal for phones
    │
    ├── Daily Operations (every day)
    │     ├── Mark absent      → system suggests substitute
    │     ├── Block room       → maintenance/event
    │     └── Extra class      → makeup session
    │
    └── Settings
          ├── Audit Log        → who did what
          ├── Notifications    → bell icon, unread count
          └── New Semester     → rollover button

