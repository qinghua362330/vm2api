import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  responsesToChatCompletion,
  responsesToTextCompletion,
  responsesTextOf,
} from '../../src/lib/protocol/codex-convert.mjs'

/**
 * 非流式的 OpenAI 兼容形状。
 *
 * 流式那条路早就把 Codex 事件翻成 `chat.completion.chunk`，非流式却把 Responses
 * 对象原样回给客户端：`{"response":{...,"output_text":"ok"}}`。OpenAI SDK 找不到
 * `choices` 就会报错 —— 既然 key 要发出去，这个形状必须对。
 */

const responsesBody = {
  response: {
    id: 'resp_1',
    model: 'gpt-5.6-terra',
    output_text: 'ok',
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
    usage: { input_tokens: 12, output_tokens: 3 },
  },
}

test('chat.completion 形状：choices[0].message.content + usage 换算', () => {
  const out = responsesToChatCompletion(responsesBody, { model: 'gpt-5.6-terra' })
  assert.equal(out.object, 'chat.completion')
  assert.equal(out.model, 'gpt-5.6-terra')
  assert.equal(out.choices[0].message.role, 'assistant')
  assert.equal(out.choices[0].message.content, 'ok')
  assert.equal(out.choices[0].finish_reason, 'stop')
  assert.deepEqual(out.usage, { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 })
})

test('text_completion 形状给 choices[0].text', () => {
  const out = responsesToTextCompletion(responsesBody)
  assert.equal(out.object, 'text_completion')
  assert.equal(out.choices[0].text, 'ok')
})

test('没有 output_text 时从 output[].content[].text 拼正文', () => {
  const body = {
    response: {
      id: 'resp_2',
      output: [{ content: [{ text: 'a' }, { text: 'b' }] }],
    },
  }
  assert.equal(responsesTextOf(body), 'ab')
  assert.equal(responsesToChatCompletion(body).choices[0].message.content, 'ab')
})

test('空正文不炸（上游只回了错误以外的空结果）', () => {
  const out = responsesToChatCompletion({})
  assert.equal(out.choices[0].message.content, '')
  assert.equal(out.usage, undefined)
})

test('handle-codex 非流式分支真的按入站协议转换', () => {
  const src = fs.readFileSync(new URL('../../src/lib/protocol/handle-codex.mjs', import.meta.url), 'utf8')
  assert.match(src, /protocol === 'openai\.chat'\) return json\(res, 200, responsesToChatCompletion/)
  assert.match(src, /protocol === 'openai\.completions'\)\s*\n?\s*return json\(res, 200, responsesToTextCompletion/)
})
