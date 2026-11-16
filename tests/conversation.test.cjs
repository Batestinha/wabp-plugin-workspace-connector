const test = require('node:test');
const assert = require('node:assert/strict');
const { privateWorkspaceConversation } = require('../dist/conversation');

test('personal workflow replies stay private across continuations while explicit group publications retain their destination', () => {
  const actions = [
    { kind: 'reply', text: 'Next field?', route: { kind: 'origin', fallback: 'origin' } },
    { kind: 'choice', prompt: 'Which option?', options: [], route: { kind: 'current', fallback: 'none' } },
    { kind: 'reply', text: 'Published result', route: { kind: 'scope_chat', scopeId: 'authorized-scope', fallback: 'none' } },
    { kind: 'noop' }
  ];
  const result = privateWorkspaceConversation({ actions });
  assert.deepEqual(result.actions.slice(0, 2).map(action => action.route), [
    { kind: 'actor_private', fallback: 'none' }, { kind: 'actor_private', fallback: 'none' }
  ]);
  assert.deepEqual(result.actions.slice(2), actions.slice(2));
  assert.equal(actions[0].route.kind, 'origin');
  assert.deepEqual(privateWorkspaceConversation(result), result);
});
