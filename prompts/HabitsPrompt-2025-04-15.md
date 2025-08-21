### We are building the APTITUDE Webapp.

Your output should be clean, dry, well-formatted, functional, running,
production-ready code in a single Artifact that ties in perfectly to the
provided (and implied) supporting files. Be sure NOT to supply code in
either Snippets or in plain text. I can install any packages needed and I would
like
to run the code that you provide exactly as it is provided.
The final result should be a beautiful website that is mobile and desktop
friendly and that adheres to a style that mixes modern minimalism with a touch
of the mystical.
Please reference the attached files (made by ChatGPT) so you can make the
necessary critiques and changes to HabitsScreen.tsx in a single Artifact
window.
I've just uploaded HabitDefaults, Habits.types and HabitScreen.

- I am making a change to the interface model for Habits[]: the progress should
  be calculated through programmatically adding together all the floats that
  are recorded as goal completions (which is an array value that gets populated
  every time the user logs more units). This is because the progress will
  always be completed for all three goal_tiers at the same time.
- I am also concerned that the logic that dictates whether the app is
  completing the bar is working properly.
    - Additive Goals:
        - The lines that are meant to show units on the progress bar are
          impossible to see
        - It needs to be more clear what is happening when the Clear Goal is
          met and the bar resets for a Stretch Goal. Eg. Add the victory color
          and flash an alert that says "Achieved! Keep going for the Stretch
          Goal!"
        - When the Clear goal is met, the bar should start off 1/3rd full to
          represent the distance between Clear and Stretch targets.
    - Subtractive Goals:
        - When a goal isn't additive, ie when completing it involves abstaining
          from an unwanted habit you are trying to break, the progress bar
          should start completely full
        - Subtractive goals should display all three goal markers, Low, Clear
          and Stretch.
        - Generally the Stretch goal in a Subtractive goal will correspond to
          the fewest target units
        - The bar should start off completely full in the color of Victory (
          which you would normally only hit after completing the Clear goal and
          moving on to the Stretch Goal in an Additive goal)
        - As soon as the stretch goal is broken for a subtractive goal, the bar
          becomes its stage's color again
          Thanks!
