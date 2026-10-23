import assert from 'node:assert/strict';

const prior = 'Existing reviewed summary must survive failed requests.';
export const aiScenario = {
  responses: [
    { mode: 'failed' },
    { mode: 'empty' },
    { mode: 'partial', text: 'Incomplete answer must not overwrite the old summary.' },
    { mode: 'wait-for-cancel' },
    {
      mode: 'success',
      text: '- Alex will ship the revised onboarding flow on Friday.\n  - Two days of work, including the shortcut.',
    },
    { mode: 'success', text: 'The deadline is Friday. [1]' },
  ],
};

export async function ai(h) {
  const page = await h.launch();
  const meeting = await h.create(
    'E2E AI recovery',
    'Alex will ship the revised onboarding flow on Friday.',
  );
  await h.call('update', meeting.id, { summary: prior });
  await h.open(meeting.title);
  for (const pattern of ['Fixture usage limit', 'empty response', 'before ChatGPT finished']) {
    await page.getByRole('button', { name: 'Enhance notes', exact: true }).first().click();
    await page.getByRole('alert').filter({ hasText: pattern }).waitFor();
    const current = (await h.state()).meetings.find((m) => m.id === meeting.id);
    assert.equal(current.summary, prior);
    assert.equal(current.notes, meeting.notes);
    assert.deepEqual(current.versions, [], 'Failed responses must not create revisions');
    await page.getByRole('button', { name: 'Dismiss error', exact: true }).click();
  }
  await page.getByRole('button', { name: 'Enhance notes', exact: true }).first().click();
  await page.getByText('Unfinished fixture response', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).waitFor({ state: 'hidden' });
  assert.equal((await h.state()).meetings.find((m) => m.id === meeting.id).summary, prior);
  if (await page.getByRole('button', { name: 'Dismiss error', exact: true }).count())
    await page.getByRole('button', { name: 'Dismiss error', exact: true }).click();
  await page.getByRole('button', { name: 'Enhance notes', exact: true }).first().click();
  const success = await h.waitForState(
    (s, id) => s.meetings.find((m) => m.id === id).summary.includes('Alex will ship'),
    meeting.id,
  );
  const enhanced = success.meetings.find((m) => m.id === meeting.id);
  assert.equal(enhanced.versions[0].text, prior);
  assert.equal(enhanced.notes, meeting.notes);
  // My own line stays dark; the detail nested under it keeps the AI color.
  await page.locator('.prose.enhanced li.own').waitFor();
  const colors = await page.locator('.prose.enhanced').evaluate((el) => {
    const own = el.querySelector('li.own');
    const color = (node) => node && getComputedStyle(node).color;
    return { own: color(own), nested: color(own.querySelector('li')), ai: color(el) };
  });
  assert.ok(colors.nested, 'the fixture nests a detail under my own line');
  assert.notEqual(colors.own, colors.ai);
  assert.equal(colors.nested, colors.ai, 'nested additions are not shown as my own');
  await page.getByRole('button', { name: /^Chat with this meeting/ }).click();
  await page
    .getByRole('textbox', { name: 'Ask a question', exact: true })
    .fill('What is the deadline?');
  await page.getByRole('button', { name: 'Send question', exact: true }).click();
  await page.getByText('The deadline is Friday.', { exact: false }).waitFor();
  const messages = await h.call('messages', 'meeting:' + meeting.id);
  assert.equal(messages.length, 2);
  assert.equal(messages[1].sources[0].id, meeting.id);
  await h.screenshot('ai-recovered');
  await h.restart();
  const persisted = (await h.state()).meetings.find((m) => m.id === meeting.id);
  assert.equal(persisted.summary, enhanced.summary);
  assert.equal((await h.call('messages', 'meeting:' + meeting.id)).length, 2);
  h.assertNoRendererErrors();
}
