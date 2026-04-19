---
name: Web-first deployment strategy
description: Adepthood is deploying as a web app on Railway first, mobile (EAS) later
type: project
---

Deploying Adepthood as a web app on Railway first, before mobile/EAS.

**Why:** User wants to launch as a web app initially. Mobile (Expo EAS) is a follow-up.

**How to apply:** When working on deployment, infra, or CORS config, prioritize the web app flow. Frontend will be an Expo web build served by nginx on Railway alongside the FastAPI backend. Two Railway services (frontend + backend) plus managed PostgreSQL.
