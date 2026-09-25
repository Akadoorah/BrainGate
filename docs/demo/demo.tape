# The README's demo, recorded from a real session on your own subscriptions.
#
#   brew install vhs
#   vhs docs/demo/demo.tape          # run from the repository root
#
# It spends a few small requests on the providers you have signed in to. Every answer shown is
# the real one; nothing here is scripted except the typing. See docs/demo/README.md.

Output docs/assets/demo.gif

Require braingate
Require git

Set Shell "bash"
Set FontSize 20
Set Width 1400
Set Height 820
Set Padding 24
Set Theme "Dracula"
Set TypingSpeed 45ms
# A provider can take a while to answer; each wait below allows for that.
Set WaitTimeout 4m
Set WaitPattern />\s*$/

# Off camera: a short prompt, and the demo project back at its starting state.
Hide
Type "export PS1='$ ' && bash docs/demo/setup.sh >/dev/null && cd ~/bg-demo"
Enter
Wait+Line /\$\s*$/
# Drop the previous recording's thread and goal, so this one starts from nothing.
Type "braingate"
Enter
Wait
Type "/forget"
Enter
Wait
Type "/new"
Enter
Wait
Type "/exit"
Enter
Sleep 2s
Type "reset"
Enter
Sleep 1s
Show

Type "braingate"
Sleep 300ms
Enter
Wait
Sleep 1s

# 1. A question. The plan is shown before anything is spent.
Type "Why does the app log users out after one minute instead of an hour? Two sentences."
Sleep 300ms
Enter
Wait+Line /Run it\?/
Sleep 2s
Type "y"
Enter
Wait
Sleep 2s

# 2. Why that worker.
Type "/why"
Enter
Wait
Sleep 3s

# 3. A second opinion from another provider, on the same goal.
Type "/use grok"
Enter
Wait
Sleep 1s
Type "Do you agree with that diagnosis? One sentence."
Sleep 300ms
Enter
Wait+Line /Run it\?/
Sleep 2s
Type "y"
Enter
Wait
Sleep 2s

# 4. Back to automatic routing: BrainGate picks whoever can do the write now, and it lands in the
#    workspace. (/auto rather than /use claude, so a provider at its limit does not stop the take.)
Type "/auto"
Enter
Wait
Sleep 1s
Type "Apply the fix"
Sleep 300ms
Enter
Wait+Line /Run it\?/
Sleep 2s
Type "y"
Enter
Wait
Sleep 3s

Hide
Type "/exit"
Enter
