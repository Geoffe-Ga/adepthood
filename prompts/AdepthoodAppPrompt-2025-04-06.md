# Adepthood App — Full Project Spec

**Adepthood** is a spiritual habit-tracking and personal development app that guides users through the 10-stage **APTITUDE** program. Based on Integral Theory, Spiral Dynamics, and an original model called **The Archetypal Wavelength**, it helps users **cultivate Free Will, transcend karmic cycles, and realize their fullest self**.

The experience is mystical, ritualistic, and deeply personal—an alchemical blend of **habit formation**, **inner practice**, **course learning**, and **AI-guided reflection**.

---

## Screens & Features

### 1. Habits Feature
1. **Home Screen**:
   - 2x5 grid of habits, each representing a stage of APTITUDE
   - One habit unlocked per stage and stays unlocked; others greyed out until that stage is unlocked
   - Each habit includes:
     - Emoji icon
     - Background color of its stage
     - Streak count
     - “Mark Complete” and “View Goals” buttons
   - Supports both **additive** (eg meditate daily) and **subtractive** (eg no alcohol) goals
   - Users define:
     - `target`, `target_unit`
     - `target_frequency`, `frequency_unit`
   - Created during Energy Scaffolding onboarding (see below)
   - Allow users to double tap on a Habit to mark it as complete for the day.
   - Allow users to long press on a Habit to edit it.
   - - Implement push notifications to remind users to complete their streaks.
   - Make notification frequency customizable per streak.
   - If the user doesn't log in for a few days, prompt them with, 'Missed you! Did you keep it up while you were gone?' Include options for 'Yes!' (backfill the missed days) or 'New start date' (open a calendar picker).
   - Notify users with milestones like 'You've been going for 10 days!' and allow them to toggle notifications for such events.
2. **Habit Stats**:
   - Show a detailed history of each streak, including a calendar view with marked completion days.
   - Display statistics like longest streak, current streak, and overall completion rate.
   - Display line graphs showing cumulative progress
   - Display bar graphs showing habit completion by "day of week" 

### 2. Course Feature
- Displays essays, summaries, prompts, and Practice/Habit instructions for current stage
- Content pulled from `StageContent` model, hosted on the Squarespace CMS
- Features:
  - “Mark as Read”
  - Journal links
  - Stage metadata
  - Drip-feed option

### 3. Journal Feature
- Chat interface with **BotMason**
  - I will provide a system prompt and documents to reference for BotMason
- Handles:
  - Reflection feedback
  - Prompts & encouragement
  - Explaining concepts
  - Allow users to search through journal entries by keywords.
- Tags entries: `habit_note`, `stage_reflection`, freeform
- AI usage metered via `offering_balance`

### 4. Map Feature
- Spiral or ladder view of 10 stages, like a skill tree
- Shows:
  - Progress
  - Past practices & goals
  - Stage summaries, including metadata in the `CourseStage` `data_model`
- Deep-link navigation to Course & Practice

### 5. Practice Feature
- Pick a Practice per stage (custom or recommended, as described in the `.docx` introduction attached)
- Timer-based (with sound cues)
- Tracks completions (target min 4x/week)
- Reflections can be journaled post-practice

### 6. Energy Scaffolding Onboarding to Habits Feature
- **The process for creating new Habits works like this:**
     1. The user enters in all the habits they'd like to create or destroy
     2. They assign a numerical value (-10 to 10) to how much of an energy investment each habit is
     3. They assign a numerical value (-10 to 10) to how much energy they'll get back from doing the habit regularly
     4. They hit "Go!" and the app orders those habits from highest net energy returned, with ties broken by lowest energy investment first and most energy returned second
     5. This displays a list of habits and dates, where the dates begin on an editable start date (calendar pop up) and then increase by 21 days for each subsequent habit down the list.
     6. They are given the opportunity to drag things around if their habit order isn't perfect for what they prefer
     7. They select icons for each habit and describe their goals for them, including a "Low Grit" goal, a "Clear Goal" and a "Stretch Goal", which are each times per day and days per week
---
## Navigation & Architecture
- Bottom tab nav:
  - Habits, Practice, Course, Journal, Map
- Deep links: Course → Journal, Map → Practice
- Progressive unlocks
- Responsive across mobile + web
- Use a modern, clean, and user-friendly design.
- Use an aesthetic that blends minimalism with elements of mysticism (e.g., soft gradients, symbolic icons).
---
## Tech Stack

- **Frontend**: React Native + Expo
- **Backend**: FastAPI + PostgreSQL
- **ORM**: SQLAlchemy + Pydantic
- **AI Assistant**: OpenAI or Local LLM
- **Hosting**: Undecided
- **CMS**: Squarespace

---

## Development Guidelines

You are helping me learn full-stack development.

- Teach clearly
- Always provide me with options for architecture, languages, systems, tools, etc, listing pros and cons. ***I am learning to be a professional software engineer and want to learn as much as possible.***
- Use clean, annotated code
- Favor scalable, modular design
- A fully functional codebase meeting all the specified requirements.
- Setup instructions, including dependencies and build steps.


---

## Files I Will Upload

- `APTITUDE_The_Liminal_Trickster_Mystics_Path.docx`
- `data_models.py`
- `Habits.tsx`

---

## Let’s Begin With

Please review Habits.tsx, which was written by a different LLM and provide suggestions and changes where needed to better align with the project spec.