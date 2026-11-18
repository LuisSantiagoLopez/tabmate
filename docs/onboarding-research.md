# What Tabmate takes from Wispr Flow's onboarding

Researched 18 November 2026. I read Wispr's own setup docs and design write-ups by other people.
I did not install Wispr Flow, so the things I took from screen teardowns (marked *teardown*) were not checked in the app.

## 10 takeaways

1. **Make people do it, don't just show them.** Wispr has a "Try it yourself" step with fake Gmail and Notion boxes. You dictate there before you reach the main app. Tabmate does the same: the user exports from a fake CRM inside the welcome flow. [Wispr setup guide][setup], [Wispr UX reference][uxref]
2. **The try-it step comes before the home screen.** You only reach the Flow Hub after the practice step. Tabmate: the guided demo is screen 2, before pinning or Claude. [setup]
3. **One job per screen.** Sign in, mic, mic test, shortcut, languages, practice, data choice: each is its own screen. Tabmate: one idea per screen, with Back and Next. [setup], [ScreensDesign teardown][sd] *teardown*
4. **Ask for things right before they are needed.** Wispr asks for the mic right before the mic test, not at the start. Tabmate: "pin it" and "press Esc to stop" come after the demo, when the user has just seen Tabmate act. [sd] *teardown*
5. **Show it's working right away.** Wispr's mic test shows bars that "stay low when you're silent and rise when you speak." Tabmate: the coach mark reacts to each click, and the step dots fill as you go. [uxref]
6. **Short, action-first buttons.** "Get started", "Try Flow", "Let's do it", "Start Flowing". Tabmate: "Let's try it", "Show me", "I pinned it", "Start using Tabmate". [sd], [setup]
7. **Every hard step can be skipped, but the core one is encouraged.** Practice demos can be skipped. Tabmate: "Skip the demo" is small text, and "Connect to Claude" is optional and folded away. [setup]
8. **Tell people the setup will remember them.** Done steps are skipped, and Wispr resumes where you left off. Tabmate: the guided demo checks what Tabmate already learned and starts at the right step. [setup]
9. **When something is missing, one card and one button fixes it.** "Almost there!" shows one **Finish setup** button. Tabmate: if a step is missed (for example, the user clicked the wrong thing), the coach mark says exactly what to click next. [Try Flow in your apps][tryapps]
10. **End on a clear "you're ready" moment, and keep it calm.** iOS ends on a "you're ready" screen with **Start Flowing**. Wispr also cut its single fake-Slack demo down to a few clear use cases (as reported by someone writing from Wispr). Tabmate: a short check-mark moment, no confetti, then one button. [setup], [Attio Atlas][atlas]

## Not confirmed

- Progress dots and the exact animations in Wispr's desktop app. The sources do not describe them. The brief asked for progress dots, so Tabmate has them anyway.
- One tester said Wispr's onboarding was long and that its final mic test was broken on v1.5.433 ([whisper-det][wd]). Lesson: keep the flow short and test every step for real. That is why Tabmate's flow has an end-to-end test.

[setup]: https://docs.wisprflow.ai/articles/3152211871-setup-guide
[tryapps]: https://docs.wisprflow.ai/articles/7523910584-try-flow-in-your-apps-ios-post-onboarding-experience
[uxref]: https://cdn.jsdelivr.net/npm/@agent-native/core@0.124.6/corpus/templates/clips/desktop/design-refs/wispr-ux.md
[sd]: https://screensdesign.com/apps/wispr-flow-ai-voice-keyboard/
[atlas]: https://atlas.attio.com/replace-the-workflow
[wd]: https://whisper-det.pages.dev/reviews/wispr-flow/
