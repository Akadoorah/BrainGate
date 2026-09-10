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

test("a provider whose stream shape nobody has watched has no dialect", () => {
  assert.equal(streamDialectFor("anthropic"), "anthropic");
  assert.equal(streamDialectFor("xai"), "xai");
  assert.equal(streamDialectFor("google"), null);
  assert.equal(streamDialectFor("openai"), null);
  assert.equal(streamDialectFor("github-copilot"), null);
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
