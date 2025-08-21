### Summary
Create a web application called **Adepthood** that guides users through the **APTITUDE** program. This program, known as ***Adepthood: Praxis and Theory for Integrating, Transcending and Unbridling from Determinism Effectively,*** helps users develop **Free Will and Self-Actualization**. It celebrates and integrates the 'Growing Up' stages from Integral Theory, combined with an original model called **The Archetypal Wavelength**, which addresses oscillations between poles like Mania/Depression or Attraction/Aversion. The goal is to help users progress from suffering and unskillful cravings, reactivity and karma towards greater **Wholeness and Equanimity**.

The Adepthood app consists of four main screens: **Journal**, **Course**, **Habits**, and **Map**. Each screen should have a distinct purpose and aesthetic, but remain cohesive under a mystical, yet user-friendly interface.
### Habits screen
Create a React Native application that clones much of the functionality of the iOS "Streaks" app. The app should allow users to track habits, set goals, and log their progress daily. Include the following features:
1. **Home Screen**:
   - Display a grid of user-defined streaks ("Habits") with progress indicators.
   - If more than 10 Habits are created, include pagination via swiping
   - Show the icon for each Habit, the current streak count for that Habit, and completion status for the day.
   - Allow users to double tap on a Habit to mark it as complete for the day.
   - Allow users to long press on a Habit to edit it.
   - The icons for 10 Habits should fit on the screen once onboarding is done
   - During onboarding, after showing all ten habits on the screen for a moment, the user taps again and whichever habits start dates (defined in 21 day increments earlier) have not yet arisen do not get displayed.
2. **Habit Stats**:
   - Show a detailed history of each streak, including a calendar view with marked completion days.
   - Display statistics like longest streak, current streak, and overall completion rate.
   - Display line graphs showing cumulative progress
   - Display bar graphs showing habit completion by "day of week"
3. **Notifications**:
   - Implement push notifications to remind users to complete their streaks.
   - Make notification frequency customizable per streak.
4. **Missed Days Recovery**:
   - If the user doesn't log in for a few days, prompt them with, 'Missed you! Did you keep it up while you were gone?' Include options for 'Yes!' (backfill the missed days) or 'New start date' (open a calendar picker).
5. **Milestones and Encouragement**:
   - Notify users with milestones like 'You've been going for 10 days!' and allow them to toggle notifications for such events.
6. **UI/UX Design**:
   - Use a modern, clean, and user-friendly design.
   - Optimize for responsiveness on both iOS and Android devices, as well ask desktop browser interfaces.
7. **Local Storage & Cloud Sync**:
   - Use local storage for offline functionality.
   - Include Firebase or another cloud backend for optional account-based sync.
8. **Onboarding**:
   - **The process for creating new Habits works like this:**
     1. The user enters in all the habits they'd like to create or destroy
     2. They assign a numerical value (-10 to 10) to how much of an energy investment each habit is
     3. They assign a numerical value (-10 to 10) to how much energy they'll get back from doing the habit regularly
     4. They hit "Go!" and the app orders those habits from highest net energy returned, with ties broken by lowest energy investment first and most energy returned second
     5. This displays a list of habits and dates, where the dates begin on an editable start date (calendar pop up) and then increase by 21 days for each subsequent habit down the list.
     6. They are given the opportunity to drag things around if their habit order isn't perfect for what they prefer
     7. They select icons for each habit and describe their goals for them, including a "Low Grit" goal, a "Clear Goal" and a "Stretch Goal", which are each times per day and days per week


### Journal Screen
Create a screen called Journal where users can chat with a virtual assistant called RoboMason about their journey through the APTITUDE program. This screen should include the following features:

1. **Chat Interface**:
   - A conversational UI similar to a chat app where users can type questions or reflections and receive responses from BotMason.
   - BotMason should respond intelligently based on keywords related to the APTITUDE program, The Archetypal Wavelength, and the transition from 'Liminal Creep' to 'Whole Adept.'
2. **Bot Customization**:
   - I will provide a system prompt and documents to reference for BotMason
3. **Journal History**:
   - Store and display past conversations in a scrollable feed.
   - Allow users to search through journal entries by keywords.
4. **Weekly Reflection Prompts**:
   - Include an optional feature where BotMason provides weekly prompts for self-reflection and journaling based on the documents submitted to it.
   - Save user responses as part of the journal history.
5. **UI/UX Design**:
   - Use an aesthetic that blends minimalism with elements of mysticism (e.g., soft gradients, symbolic icons).
   - Include easy-to-use text input and buttons for sending messages.

### Course Screen
Create a React Native screen called Course that serves as an educational space for users to read about the stage of the APTITUDE program they are currently working on. This screen should include the following features:

1. **Stage-Specific Content**:
   - Dynamically load and display content (short essays) related to the user’s current stage of APTITUDE.
   - Include a title, subheadings, and text for each essay.
2. **Navigation Menu**:
   - Allow users to navigate between stages (locked until unlocked by progress) or revisit past stages.
   - Highlight the current stage for clarity.
3. **Interactive Elements**:
   - Add a 'Reflection' button at the end of each essay that redirects users to the Journal screen for further exploration.
   - Include a 'Mark as Read' button to track progress through the course content.
4. **Progress Tracker**:
   - Display a progress bar at the top of the screen indicating how much content the user has completed in their current stage.
5. **UI/UX Design**:
   - Use clean typography for readability and include small, symbolic graphics representing the stage's themes.
   - Ensure compatibility with both light and dark modes.

### Map Screen
   Create a React Native screen called Map to visually represent the 10 stages of APTITUDE and their associated practices, qualities, and characteristics. This screen should include the following features:

1. **Interactive Stage Map**:
   - Display a vertical, spiraling progression of the 10 stages of APTITUDE, inspired by Ken Wilber’s 'Growing Up' stages and Clare Graves' Spiral Dynamics.
     - I will provide documents describing these stages, but broadly, they are
       1. Beige: Survival, "Active Yes-And-Ness"
       2. Purple: Magick, "Receptive Yes-And-Ness"
       3. Red: Power, "Self-Love"
       4. Blue: Conformity "Universal Love"
       5. Orange: Achievist "Intellectual Understanding"
       6. Green: Pluralist "Embodied Understanding"
       7. Yellow: Integrative "Systems Wisdom"
       8. Teal: Nondual "Transcendent Wisdom"
       9. Ultraviolet: Effortless Being "Unity of Being"
       10. Clear Light: Pure Awareness "Emptiness and Awareness"
   - Make each stage clickable to reveal detailed information (like links to the Course material) and a library of infographics (that I have already created).
2. **Stage Details**:
   - When a stage is selected, display a popup or new panel showing:
     - Stage name and description.
     - Practices associated with that stage.
     - Key qualities and characteristics.
     - Challenges and goals.
3. **Progress Indicator**:
   - Visually indicate the user’s current stage (e.g., highlighted or with an icon) and any completed stages.
4. **Stage Connections**:
   - Illustrate relationships between stages with lines or arcs that emphasize continuity and evolution.
5. **Quick Actions**:
   - Add buttons to 'Go to Course' or 'Open Journal' directly from the Map for seamless navigation.
6. **UI/UX Design**:
   - Create a mystical and aspirational aesthetic with thematic colors and symbolic designs.
   - Use smooth animations for transitions between stages and panels to enhance the user experience.
7. **Responsive Layout**:
   - Ensure the map adjusts well to different screen sizes and orientations."

------
**Overall Requirements:**
- Integrate all four screens (Journal, Course, Habits, Map) into a cohesive application architecture.
- Provide a clean, well-structured codebase with modular components and clear documentation.
- Ensure navigation flows smoothly between screens (e.g., from Course to Journal, from Map to Course, etc.).
- Maintain visual and thematic consistency throughout the app while giving each screen a distinct purpose.
- Optimize performance for desktop, iOS AND Android devices.

**Deliverables:**
- Begin with a roadmap to deployment that breaks the project into actionable steps like "Decide on X" or "Use LLM to code y."
- Always provide me with options for architecture, languages, systems, tools, etc, listing pros and cons. ***I am learning to be a professional software engineer and want to learn as much as possible.***
- A fully functional codebase meeting all the specified requirements.
- Setup instructions, including dependencies and build steps.
- Clear inline comments and documentation for components and logic.
- Python backend
