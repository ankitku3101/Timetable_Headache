# Headache Solver — University Timetable Optimizer

Automated university timetable generation. Admins configure departments, faculty, subjects, rooms, and constraints; a constraint-solving engine generates conflict-free timetables in seconds instead of days of manual scheduling.

For a plain-language walkthrough of what the system does and how to demo it, see [HOW_IT_WORKS.md](HOW_IT_WORKS.md). For the system design rationale, see [architecture.md](architecture.md). For a quick project summary, see [About.md](About.md).

## Tech stack

| Layer | Tech |
|---|---|
| Frontend | Next.js + TypeScript + Tailwind + shadcn/ui |
| Backend | Express.js (modular monolith) |
| Database | MongoDB Atlas |
| Queue | Redis |
| Solver | Python + OR-Tools CP-SAT (worker) |
| Streaming | Server-Sent Events (generation progress) |
| AI | Anthropic API (constraint parsing, conflict explanation) |

## Project structure

```
frontend/          Next.js app (deployed on Vercel)
backend/            Express API (Docker, deployed on AWS EC2)
workers/python/    CP-SAT solver worker (Docker, deployed on AWS EC2)
docker-compose.yml  Backend + worker + Redis + Caddy stack (used on the EC2 host)
Caddyfile           Reverse proxy / automatic HTTPS config
```

## Local development

Requires Node.js 22+, Python 3.11+, and running instances of MongoDB and Redis (or connection strings to hosted ones).

### Backend

```bash
cd backend
cp .env.example .env   # fill in MONGODB_URI, REDIS_URL, JWT_SECRET, etc.
npm install
npm run dev             # nodemon, http://localhost:8080
```

### Worker

```bash
cd workers/python
python -m venv venv && venv\Scripts\activate   # or `source venv/bin/activate` on macOS/Linux
pip install -r requirements.txt
cp .env.example .env    # same MONGODB_URI and REDIS_URL as the backend
python app/worker.py
```

### Frontend

```bash
cd frontend
npm install
npm run dev              # http://localhost:3000, expects NEXT_PUBLIC_API_BASE_URL (defaults to http://localhost:8080/api/v1)
```

## Deployment

- **Frontend**: Vercel, auto-deployed from `main`.
- **Backend + worker + Redis**: a single AWS EC2 instance running the [docker-compose.yml](docker-compose.yml) stack, fronted by Caddy for automatic HTTPS. See [architecture.md § Deployment](architecture.md#3-deployment) for the full breakdown.
- **Database**: MongoDB Atlas (unchanged regardless of compute provider).

Backend/worker changes are deployed manually: SSH into the EC2 instance and run `git pull && docker compose up -d --build`.

## API docs

See [backend/API_DOCS.md](backend/API_DOCS.md).

## Contributors

[![Contributors](https://contrib.rocks/image?repo=Adyasha56/Timetable_Headache)](https://github.com/Adyasha56/Timetable_Headache/graphs/contributors)
