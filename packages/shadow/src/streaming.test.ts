import test from "node:test";
import assert from "node:assert/strict";
import { ContractTextStream, LineBuffer, ProviderStreamReader, readStreamLine, streamDialectFor } from "./streaming.js";

/** Lines copied from a real `claude --output-format stream-json --include-partial-messages` run. */
const CLAUDE_DELTA = '{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"ok"}},"session_id":"x"}';
const CLAUDE_THINKING = '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hm"}}}';
const CLAUDE_SIGNATURE = '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"EqsDCrIBCBEYAipA"}}}';
const CLAUDE_ASSISTANT = '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}}';
const CLAUDE_RESULT = '{"type":"result","subtype":"success","result":"{\\"kind\\":\\"work\\"}","usage":{"input_tokens":10,"output_tokens":4}}';

/** Lines copied from a real `grok --output-format streaming-json` run. */
const GROK_TEXT = '{"type":"text","data":"ok"}';
const GROK_THOUGHT = '{"type":"thought","data":"The user"}';
const GROK_TOOLS = '{"type":"available_commands","tools":["read_file","grep"]}';
const GROK_END = '{"type":"end","stopReason":"end_turn","usage":{"input_tokens":22448,"output_tokens":37}}';

/**
 * Lines copied from a real `codex exec --json -C <dir> --sandbox read-only --model gpt-6-astra -`
 * run, codex-cli 0.153.4, 2026-09-19, on a throwaway repository holding one canary file.
 *
 * There are no deltas in this stream and no flag that produces any: `--json` prints whole events,
 * so the finest granularity this build offers is one completed item at a time.
 */
const CODEX_THREAD = '{"type":"thread.started","thread_id":"01a0ba7c-5dce-7fd2-a002-953a9aa9d711"}';
const CODEX_TURN_STARTED = '{"type":"turn.started"}';
const CODEX_NARRATION = '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"I\'ll read canary.txt for the ID.\\n"}}';
const CODEX_COMMAND_STARTED = '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc \'cat canary.txt\'","aggregated_output":"","exit_code":null,"status":"in_progress"}}';
const CODEX_COMMAND_DONE = '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc \'cat canary.txt\'","aggregated_output":"The distinctive id is BG-CANARY-7741-ZQ.\\nSecond line: the project name is Rehla.\\n","exit_code":0,"status":"completed"}}';
const CODEX_ANSWER = '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"The distinctive ID is BG-CANARY-7741-ZQ."}}';
const CODEX_TURN_COMPLETED = '{"type":"turn.completed","usage":{"input_tokens":45225,"cached_input_tokens":29440,"cache_write_input_tokens":0,"output_tokens":65,"reasoning_output_tokens":0}}';

/**
 * Lines copied from a real
 * `agy --output-format stream-json --model gemini-3.8-flash-medium --effort medium -p='…'` run,
 * agy 1.2.7, 2026-09-19, same repository. Truncated only where a field held a whole file.
 */
const AGY_INIT = '{"event":"init","conversation_id":"73961df0-0d11-40ed-9fe7-842abf43eb6a","init":{"model":"gemini-3.8-flash-medium","cwd":"/tmp/repo","tools":["ask_permission","run_command","view_file"]}}';
const AGY_TOOL_ACTIVE = '{"event":"step_update","step_update":{"conversation_id":"73961df0-0d11-40ed-9fe7-842abf43eb6a","step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"ls -la"}}}}';
const AGY_TOOL_DONE = '{"event":"step_update","step_update":{"conversation_id":"73961df0-0d11-40ed-9fe7-842abf43eb6a","step_index":2,"state":"DONE","step_type":"tool","tool_name":"run_command","duration_seconds":0.162732,"tool_info":{"name":"run_command","parameters":{"CommandLine":"ls -la"},"output":"total 0\\r\\ndrwxr-xr-x  …"}}}';
const AGY_DELTA = (index: number, text: string) => `{"event":"step_update","step_update":{"conversation_id":"73961df0-0d11-40ed-9fe7-842abf43eb6a","step_index":${String(index)},"state":"ACTIVE","step_type":"agent_response","text_delta":${JSON.stringify(text)}}}`;
const AGY_STEP_DONE = '{"event":"step_update","step_update":{"conversation_id":"73961df0-0d11-40ed-9fe7-842abf43eb6a","step_index":1,"state":"DONE","step_type":"agent_response","duration_seconds":2.759107,"usage":{"input_tokens":11891,"output_tokens":493,"thinking_tokens":392,"cache_read_tokens":0,"total_tokens":12384}}}';
const AGY_RESULT = '{"event":"result","result":{"conversation_id":"73961df0-0d11-40ed-9fe7-842abf43eb6a","status":"SUCCESS","response":"The distinctive ID is `BG-CANARY-7741-ZQ`.\\n","duration_seconds":18.739201,"num_turns":1,"usage":{"input_tokens":79004,"output_tokens":1501,"thinking_tokens":876,"cache_read_tokens":0,"total_tokens":80505}}}';

test("a provider whose stream shape nobody has watched has no dialect", () => {
  assert.equal(streamDialectFor("anthropic"), "anthropic");
  assert.equal(streamDialectFor("xai"), "xai");
  // Watched on 2026-09-19, one real read each; the fixtures above are those runs.
  assert.equal(streamDialectFor("google"), "google");
  assert.equal(streamDialectFor("openai"), "openai");
  assert.equal(streamDialectFor("github-copilot"), null);
});

test("Codex streams whole messages, and the answer of record survives the thinning", () => {
  const reader = new ProviderStreamReader("openai");
  // The session id and the accounting are read from the retained output after the run.
  assert.equal(reader.read(CODEX_THREAD).retain, true);
  assert.equal(reader.read(CODEX_TURN_STARTED).retain, false);

  const narration = reader.read(CODEX_NARRATION);
  assert.equal(narration.answer, "I'll read canary.txt for the ID.\n", "the narration reaches the terminal while the run is still working");
  assert.equal(narration.retain, true, "every agent_message is retained: the parse reads the last one");

  // A `cat` of the workspace is not an answer and nothing reads it back, so it costs no cap.
  assert.equal(reader.read(CODEX_COMMAND_STARTED).retain, false);
  const commandDone = reader.read(CODEX_COMMAND_DONE);
  assert.equal(commandDone.retain, false);
  assert.equal(commandDone.answer, null);

  const answer = reader.read(CODEX_ANSWER);
  assert.equal(answer.answer, "The distinctive ID is BG-CANARY-7741-ZQ.");
  // Without this the answer of record would be the narration with the answer glued to it.
  assert.equal(answer.restart, true);
  assert.equal(reader.read(CODEX_TURN_COMPLETED).retain, true);
});

test("a Codex reasoning item is activity, never an answer", () => {
  const verdict = readStreamLine("openai", '{"type":"item.completed","item":{"id":"item_3","type":"reasoning","text":"considering the file"}}');
  assert.equal(verdict.thinking, true);
  assert.equal(verdict.answer, null);
  assert.equal(verdict.retain, false, "the invoker's parser refuses a reasoning item as an answer, so retaining it buys nothing");
});

test("Antigravity's text deltas are the answer; its tool steps are not", () => {
  const reader = new ProviderStreamReader("google");
  assert.equal(reader.read(AGY_INIT).retain, true, "the conversation id is what a goal resumes on");
  assert.equal(reader.read(AGY_TOOL_ACTIVE).retain, false);
  // `tool_info.output` is whatever the tool read — a whole file, in the measured run.
  assert.equal(reader.read(AGY_TOOL_DONE).retain, false);
  assert.equal(reader.read(AGY_DELTA(12, "The distinctive ID in [c")).answer, "The distinctive ID in [c");
  assert.equal(reader.read(AGY_DELTA(12, "anary.txt]")).answer, "anary.txt]");
  // A step that reports only its usage carries no text.
  assert.equal(reader.read(AGY_STEP_DONE).answer, null);
  assert.equal(reader.read(AGY_RESULT).retain, true, "the answer of record, its conversation id and its usage are all in this line");
});

test("a new Antigravity step is a new answer, so narration is not glued to the reply", () => {
  const reader = new ProviderStreamReader("google");
  assert.equal(reader.read(AGY_DELTA(3, "Let me look at the file.")).restart, undefined, "the first text step starts nothing over");
  const second = reader.read(AGY_DELTA(12, "The distinctive ID is"));
  assert.equal(second.restart, true);
  assert.equal(second.answer, "The distinctive ID is");
  assert.equal(reader.read(AGY_DELTA(12, " BG-CANARY-7741-ZQ.")).restart, undefined, "the same step continues the same answer");
});

test("Claude's text deltas are the answer, and nothing else is retained from them", () => {
  const delta = readStreamLine("anthropic", CLAUDE_DELTA);
  assert.equal(delta.answer, "ok");
  assert.equal(delta.retain, false);
  assert.equal(readStreamLine("anthropic", CLAUDE_THINKING).thinking, true);
  assert.equal(readStreamLine("anthropic", CLAUDE_THINKING).answer, null);
  // The single largest thing in the stream, and the parse never reads it.
  assert.equal(readStreamLine("anthropic", CLAUDE_SIGNATURE).retain, false);
  // Whole messages repeat what the deltas already carried.
  assert.equal(readStreamLine("anthropic", CLAUDE_ASSISTANT).retain, false);
  // The envelope is what usage and the fallback parse read.
  assert.equal(readStreamLine("anthropic", CLAUDE_RESULT).retain, true);
});

test("Grok's text pieces are the answer; its thoughts and tool list are not", () => {
  assert.equal(readStreamLine("xai", GROK_TEXT).answer, "ok");
  assert.equal(readStreamLine("xai", GROK_THOUGHT).thinking, true);
  assert.equal(readStreamLine("xai", GROK_THOUGHT).answer, null);
  assert.equal(readStreamLine("xai", GROK_TOOLS).retain, false, "the tool list is repeated on every connection and says nothing about the run");
  assert.equal(readStreamLine("xai", GROK_END).retain, true);
});

test("a line that is not JSON is kept, because a failure is usually one", () => {
  const verdict = readStreamLine("xai", "Error: Couldn't set model 'nope'");
  assert.equal(verdict.retain, true);
  assert.equal(verdict.answer, null);
});

test("the readable field is streamed out of the contract JSON as it is built", () => {
  const prose = new ContractTextStream();
  // Exactly how a schema-constrained answer arrives: JSON, a fragment at a time.
  assert.equal(prose.push('{"kind":"wo'), "", "nothing is shown before the field even appears");
  assert.equal(prose.push('rk","output":"He'), "He");
  assert.equal(prose.push("llo"), "llo");
  assert.equal(prose.push(' there"}'), " there");
  assert.equal(prose.push("anything after"), "", "the field ended, so nothing more belongs to it");
});

test("an escape split across two fragments is decoded, not lost", () => {
  const prose = new ContractTextStream();
  assert.equal(prose.push('{"output":"line\\'), "line", "a lone backslash waits for what it escapes");
  assert.equal(prose.push('nnext"}'), "\nnext");
});

test("a unicode escape waits for all four of its digits", () => {
  const prose = new ContractTextStream();
  assert.equal(prose.push('{"output":"\\u00'), "");
  assert.equal(prose.push('e9"}'), "é");
});

test("a rationale or a summary is prose too, and a contract without any shows nothing", () => {
  assert.equal(new ContractTextStream().push('{"kind":"judge","rationale":"because"}'), "because");
  assert.equal(new ContractTextStream().push('{"kind":"review","verdict":"approve","findings":[]}'), "");
});

test("a chunk that ends mid-line keeps the remainder for the next one", () => {
  const buffer = new LineBuffer();
  assert.deepEqual([...buffer.take('{"a":1}\n{"b":')], ['{"a":1}']);
  assert.deepEqual([...buffer.take('2}\n')], ['{"b":2}']);
  assert.equal(buffer.flush(), "");
});

test("a final line with no newline is not dropped", () => {
  const buffer = new LineBuffer();
  assert.deepEqual([...buffer.take('{"a":1}')], []);
  assert.equal(buffer.flush(), '{"a":1}');
});

/**
 * The shape a schema-constrained Claude run actually produces when it does not narrate: the
 * contract arrives as the input of the tool the schema is filled through.
 */
const TOOL_START = '{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t1","name":"StructuredOutput","input":{}}}}';
const TOOL_DELTA = (partial: string) => `{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":${JSON.stringify(partial)}}}}`;
const OTHER_TOOL_START = '{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t2","name":"Grep","input":{}}}}';
const BLOCK_STOP = '{"type":"stream_event","event":{"type":"content_block_stop","index":0}}';

test("a run that answers through the schema tool still streams its answer", () => {
  const reader = new ProviderStreamReader("anthropic");
  assert.equal(reader.read(TOOL_START).restart, true);
  assert.equal(reader.read(TOOL_DELTA('{"kind":"work","output":"He')).answer, '{"kind":"work","output":"He');
  assert.equal(reader.read(TOOL_DELTA('llo"}')).answer, 'llo"}');
});

test("another tool's input is not the answer, though it arrives as the same kind of delta", () => {
  const reader = new ProviderStreamReader("anthropic");
  reader.read(OTHER_TOOL_START);
  // A Grep pattern would otherwise be shown to the operator as if it were the reply.
  assert.equal(reader.read(TOOL_DELTA('{"pattern":"TODO"}')).answer, null);
  reader.read(BLOCK_STOP);
  reader.read(TOOL_START);
  assert.equal(reader.read(TOOL_DELTA('{"kind":"work"}')).answer, '{"kind":"work"}');
});

test("prose and tool fragments are both answers, and a block boundary separates them", () => {
  const reader = new ProviderStreamReader("anthropic");
  reader.read('{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}');
  assert.equal(reader.read(CLAUDE_DELTA).answer, "ok");
  assert.equal(reader.read(CLAUDE_THINKING).thinking, true);
  // The envelope still reaches the retained output through the stateless path.
  assert.equal(reader.read(CLAUDE_RESULT).retain, true);
});

test("the stateful reader leaves the other dialect exactly as it was", () => {
  const reader = new ProviderStreamReader("xai");
  assert.equal(reader.read(GROK_TEXT).answer, "ok");
  assert.equal(reader.read(GROK_THOUGHT).thinking, true);
  assert.equal(reader.read(GROK_END).retain, true);
});
