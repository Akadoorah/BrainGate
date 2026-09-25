# Recording the demo

`demo.tape` records the README's GIF from a real BrainGate session on your own subscriptions.
[VHS](https://github.com/charmbracelet/vhs) types the commands; every answer is the provider's own.

```bash
brew install vhs          # macOS; other platforms: see the VHS README
vhs docs/demo/demo.tape   # from the repository root
```

The result is `docs/assets/demo.gif`.

## What it does

1. Off camera, `setup.sh` creates `~/bg-demo` (or `$BRAINGATE_DEMO_DIR`): a one-file repository
   whose idle timeout is a minute instead of an hour, registered as the BrainGate project `bg-demo`.
   Every run resets that directory to its starting state, so the tape can be re-recorded. Only that
   directory is touched; your model catalogue, acceptances and quota history are left alone.
2. On camera: a question, the plan, `/why`, a second opinion from Grok on the same goal, then back to
   Claude to apply the fix in the workspace.

It spends a few small requests on the providers involved. It needs Claude Code and Grok Build
signed in; to use Codex instead, change `/use grok` to `/use codex` in the tape.

## If it stops

VHS waits up to four minutes for each answer, then fails with `timeout waiting for ...` and the
last line it saw.

- **`last value was: >`**: BrainGate refused the request and returned to the prompt, so the plan
  question never came. Run `cd ~/bg-demo && braingate` yourself, type the same request, and read
  the refusal.
- **A provider is slow:** raise `Set WaitTimeout` in the tape.
- **The GIF is too long:** VHS records real time, including the time a provider takes to answer.
  Speed it up afterwards, for example with
  `ffmpeg -i docs/assets/demo.gif -vf "setpts=0.5*PTS" docs/assets/demo-fast.gif`.
