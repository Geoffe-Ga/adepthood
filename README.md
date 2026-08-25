# Adepthood

Adepthood is a React Native + FastAPI app whose floor is a **journal-first personal knowledge base** that, over time, becomes a _Higher Self_ — reflecting your own past reflections back to you in the language of the **APTITUDE** program and the Archetypal Wavelength. Arranged around that floor are optional, self-chosen **depths** — prompted journaling, habit scaffolding, a practice ramp, the course reading, and the Digital Sangha. Nothing is gated, nothing is mandatory, and there is no gamified pressure: **you choose your depth**. A single 36-week Archetypal Wavelength cadence (eight stages × 3 weeks + Unity & Emptiness × 6 weeks) paces whichever depths are turned on, and it loops — the Map reads as a wheel of wholeness, not a ladder to climb.

See [`NORTH-STAR.md`](./NORTH-STAR.md) for the full product thesis ("Graduated Engagement") and [`frontend/src/design/DESIGN.md`](./frontend/src/design/DESIGN.md) for the "Candle & Ink" visual north star (the implemented design system). Root [`DESIGN.md`](./DESIGN.md) is an external inspiration reference — an analysis of the Anthropic / Claude.com marketing-site aesthetic that informed the Candle & Ink vocabulary.

## ✨ Features

**The floor — always on:**

- 📓 **Journal & Higher Self** — Write freely; each entry folds into your private corpus. Over time, **Get Resonance**: anchored margin notes (Marginalia) reflect your own past wisdom back to you in the language of the APTITUDE program and the Archetypal Wavelength. Journaling about a habit or practice you actually did surfaces a one-tap **"check it off?"** suggestion — a resonant invitation, always declinable, never a nag.
- 🏠 **Today** — A home hub that gathers what is live for you across whichever optional depths you have turned on.

**Optional depths — choose any, in any order:**

- 📊 **Habits** — Opt into cumulative habits with energy scaffolding, streaks, and tiered goals so the stack never overwhelms.
- 🧘 **Practices** — Stage practices (mindfulness, breathwork, movement) with an immersive session player — timed cues and sound bells.
- 📚 **Course** — Read the teachings Aspect by Aspect in a native Markdown reader, drip-fed at the stage cadence.
- 🗺️ **Map** — A Wheel of Wholeness showing balance across the ten Aspects — which facets are full, which are thin, where you are out of balance.
- 🌐 **Digital Sangha** — Community for those who want company on the path, oriented from the start toward returning people to embodied life.


## 🛠️ Tech Stack

- **Frontend**: [React Native](https://reactnative.dev/) with [Expo](https://expo.dev/)
- **Backend**: [FastAPI](https://fastapi.tiangolo.com/) with PostgreSQL
- **Mobile & Web**: Runs on iOS, Android, and Web via Expo

## 🗂️ Repository Structure

```
.
├── backend/       # FastAPI service
├── frontend/      # React Native + Expo client (design system in src/design/)
├── docs/          # Architecture decision records and content guide
├── prompts/       # LLM prompt history and specification documents
├── scripts/       # Development and CI helper scripts
├── AGENTS.md      # Necessary instructions for AI collaborators
├── NORTH-STAR.md  # Product thesis — "Graduated Engagement"
├── DESIGN.md      # External inspiration reference — Anthropic/Claude.com marketing-site analysis
```

The "Candle & Ink" design system (tokens, theme, and its own `DESIGN.md`) lives in
`frontend/src/design/`.

## 🚀 Getting Started

Run the development setup script to install shared tooling:

```bash
bash scripts/dev-setup.sh
```
 **Prerequisites** (Handled by Setup Script)
- Node.js (v20 — see `frontend/.nvmrc`)
- Python (3.11+ — CI runs 3.11, 3.12, 3.13)
- PostgreSQL

### Frontend
```bash
cd frontend
npm install
npx expo start
```

To run the web build, pass a port the backend's CORS allowlist accepts:

```bash
npx expo start --web --port 8080
```

`DEV_ORIGINS` in `backend/src/main.py` allows `localhost:3000` and
`localhost:8080` only. Expo's own default is 8081, so a bare `--web` is
CORS-blocked on every request and the app reports itself offline rather than
naming the real cause.

### Backend
```bash
cd backend
pip install -r requirements.txt
PYTHONPATH=src uvicorn main:app --reload
```

#### A local account

Every account-creation path — password signup and both social sign-ins —
requires a Gumroad-verified APTITUDE license, so a fresh local database has no
way in. Seed one account instead:

```bash
cd backend
PYTHONPATH=src python -m scripts.create_dev_account --email dev@example.com
```

It creates the user, comps it course access, and prints the generated password
(pass `--password` to choose your own). Log in with those credentials and the
journal is reachable.

The address is folded and validated exactly as the login route folds and
validates its payload — lower-cased, stripped, and parsed as an email — so what
gets written is what a later login request will find. An address the API would
reject is refused here rather than stored, because a row nobody can address is
worse than no row: `dev@localhost.test` and other RFC 6761 reserved names read
as local but are refused by the API, which is why the default is the
documentation domain `example.com`.

The command **refuses** unless the machine proves it is local, and every
condition vetoes on its own: `ENV` must explicitly be `development`,
`DATABASE_URL` must resolve to loopback (or be a SQLite file), no
`GUMROAD_API_TOKEN` / `GUMROAD_WEBHOOK_SECRET` may be configured, and no
platform-injected `RAILWAY_*` variable may be present. A refusal writes nothing
and never opens a database connection. Nothing in the signup route changes —
there is no runtime flag and nothing to leave switched on.

The grant is recorded as a comp with no sale link, so a seeded account stays
distinguishable from a real purchase forever after.

To exercise the Gumroad integration (license verification and the sale
webhook), set `GUMROAD_API_TOKEN`, `GUMROAD_WEBHOOK_SECRET`,
`GUMROAD_APTITUDE_PRODUCT_IDS`, `GUMROAD_TOKEN_PACK_PRODUCT_IDS`, and
`GUMROAD_TOKEN_PACK_SIZES` — see
`backend/.env.example` for what each does and the [Gumroad API docs](https://gumroad.com/api)
for how to obtain a seller token.

## 📖 Program Background

APTITUDE is a 36-week **developmental** journey based on Ken Wilber's _Integral Theory_,
Clare Graves' _Spiral Dynamics_, five years of intensive _research_, 10 years of _practice_,
and 20 years of deep self-examination in talk _therapy_.

Each stage introduces **habits**, **practices**, and **exercises** to progressively build stability, resilience, and alignment with Source.

## 🤝 Contributing

Pull requests are welcome. For significant changes, open an issue first to discuss what you’d like to add.

## 📜 License

[MIT](LICENSE)

---
*“Hospice the old world, midwife the new.”*
