---
type: "query"
date: "2026-07-18T00:05:07.635445+00:00"
question: "Which module computes habit streaks and what depends on it?"
contributor: "graphify"
outcome: "useful"
source_nodes: ["streaks.py", "current_consecutive_streak()", "habit_stats.py", "checkin.py"]
---

# Q: Which module computes habit streaks and what depends on it?

## Answer

backend/src/domain/streaks.py holds the streak logic (current_consecutive_streak, subtractive_current_streak, subtractive_longest_streak); habit_stats.py, checkin.py, and goal.py import from it. Verified by reading backend/src/domain/streaks.py.

## Outcome

- Signal: useful

## Source Nodes

- streaks.py
- current_consecutive_streak()
- habit_stats.py
- checkin.py
