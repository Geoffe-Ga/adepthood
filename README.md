# Adepthood

Adepthood is a React Native + FastAPI app that guides users through the 36-week **APTITUDE** program, a structured path of habit-building, meditative practices, and personal growth toward Free Will and Self-Actualization.

## ✨ Features

- 📚 **Course** — Explore educational content stage by stage through the APTITUDE program
- 📊 **Habits** — Track cumulative habits with energy scaffolding, streaks, and goals
- 🧘 **Practices** — Complete timed meditations unique to each stage, with sound cues and progress tracking
- 📓 **Journal** — Reflect daily and chat with Robot Mason, your Liminal Trickster Mystic guide
- 🗺️ **Map** — Visualize your growth across the 10 stages of APTITUDE in a skill-tree style


## 🛠️ Tech Stack

- **Frontend**: [React Native](https://reactnative.dev/) with [Expo](https://expo.dev/)
- **Backend**: [FastAPI](https://fastapi.tiangolo.com/) with PostgreSQL
- **Mobile & Web**: Runs on iOS, Android, and Web via Expo

## 🗂️ Repository Structure

```
.
├── backend/   # FastAPI service
├── frontend/  # React Native + Expo client
├── prompts/   # LLM prompt history and specification documents
├── scripts/   # Development and CI helper scripts
├── AGENTS.md  # Necessary instructions for AI collaborators
```

## 🚀 Getting Started

Run the development setup script to install shared tooling:

```bash
bash scripts/dev-setup.sh
```
 **Prerequisites** (Handled by Setup Script)
- Node.js (v18+)
- Python (3.10+)
- PostgreSQL

### Frontend
```bash
cd frontend
npm install
npx expo start
```

### Backend
```bash
cd backend
pip install -r requirements.txt
uvicorn src.main:app --reload
```

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
