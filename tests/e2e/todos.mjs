import assert from 'node:assert/strict';

const mine = 'I will send the pricing draft by Friday.';
const theirs = 'I can update the onboarding page.';
const vague = 'We should book a room for the offsite.';
const items = (...list) => JSON.stringify({ items: list });
const send = { task: 'Send the pricing draft', assignee: 'me', due: 'by Friday', quote: mine };
const update = {
  task: 'Update the onboarding page',
  assignee: 'other',
  owner: 'Priya',
  quote: theirs,
};
const book = { task: 'Book a room for the offsite', assignee: 'unclear', quote: vague };

export const todosScenario = {
  responses: [
    { mode: 'success', text: '## Pricing\n- Draft goes out Friday' },
    { mode: 'success', text: '## Pricing\n- Draft goes out Friday, rewritten' },
  ],
  todoResponses: [
    { mode: 'success', text: items(send, update, book) },
    // Enhancing again: this scan tries to undo everything the user did.
    {
      mode: 'success',
      text: items({ ...send, assignee: 'other' }, { ...update, assignee: 'me' }, book),
    },
    { mode: 'wait-for-cancel' },
    { mode: 'success', text: items({ task: 'Call the supplier', assignee: 'unclear', quote: '' }) },
  ],
};

async function transcribe(h, id) {
  for (const [text, source, speaker, timestamp] of [
    [mine, 'microphone', 'You', 12],
    [theirs, 'system', 'Meeting audio', 44],
    [vague, 'system', 'Meeting audio', 90],
  ])
    await h.call('transcript', id, { text, source, speaker, timestamp });
}
const row = (page, text) => page.locator('.todo-row').filter({ hasText: text });
const openTodos = (page) =>
  page
    .getByRole('navigation', { name: 'Notebook' })
    .getByRole('button', { name: /^Todos/ })
    .click();

export async function todos(h) {
  const page = await h.launch();

  // Enhancing finds the todos on its own; mine and unclear are listed, others' are not.
  const meeting = await h.create('E2E pricing sync', 'Pricing');
  await transcribe(h, meeting.id);
  await page.getByRole('button', { name: 'Enhance notes', exact: true }).first().click();
  await h.waitForState((s) => s.todos.length === 3 && !s.todoProgress.running);
  await page.getByRole('button', { name: 'Back to Home', exact: true }).click();
  await page
    .getByRole('navigation', { name: 'Notebook' })
    .getByRole('button', { name: /^Todos/ })
    .filter({ hasText: '2' })
    .waitFor();
  await openTodos(page);
  await page.getByRole('heading', { name: 'Todos', exact: true }).waitFor();
  await row(page, 'Send the pricing draft').waitFor();
  await row(page, 'by Friday').waitFor();
  const unsure = row(page, 'Book a room for the offsite');
  await unsure.getByText('Might not be yours', { exact: true }).waitFor();
  await row(page, 'Send the pricing draft')
    .getByText('Might not be yours')
    .waitFor({ state: 'hidden' });
  assert.equal(await row(page, 'Update the onboarding page').isVisible(), false);
  await page.getByRole('textbox', { name: 'What do people call you in meetings?' }).waitFor();
  await h.screenshot('todos');

  // Names are saved once and the prompt goes away.
  await page
    .getByRole('textbox', { name: 'What do people call you in meetings?' })
    .fill('Sam, 小山');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await h.waitForState((s) => s.settings.myNames === 'Sam, 小山');
  await page
    .getByRole('textbox', { name: 'What do people call you in meetings?' })
    .waitFor({ state: 'hidden' });

  // The source opens the transcript at that line, and Back returns here.
  await row(page, 'Send the pricing draft').locator('.todo-source').click();
  await page.locator('.transcript-segment.focused').filter({ hasText: mine }).waitFor();
  await page.getByRole('button', { name: 'Close transcript', exact: true }).click();
  await page.getByRole('button', { name: 'Back to Todos', exact: true }).click();
  await page.getByRole('heading', { name: 'Todos', exact: true }).waitFor();

  // What the user decides.
  await row(page, 'Send the pricing draft')
    .getByRole('checkbox', { name: 'Mark “Send the pricing draft” as done' })
    .click();
  await h.waitForState((s) => s.todos.find((t) => t.text === send.task).doneAt);
  await page.getByText('Assigned to others').click();
  await row(page, 'Update the onboarding page')
    .getByRole('button', { name: '“Update the onboarding page” is mine' })
    .click();
  await h.waitForState((s) => s.todos.find((t) => t.text === update.task).assignee === 'me');
  await row(page, 'Book a room for the offsite')
    .getByRole('button', { name: '“Book a room for the offsite” is not a todo' })
    .click();
  await h.waitForState((s) => s.todos.find((t) => t.text === book.task).dismissedAt);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await h.waitForState((s) => !s.todos.find((t) => t.text === book.task).dismissedAt);
  await row(page, 'Book a room for the offsite')
    .getByRole('button', { name: '“Book a room for the offsite” is not a todo' })
    .click();
  await h.waitForState((s) => s.todos.find((t) => t.text === book.task).dismissedAt);

  // Enhancing again scans again, and none of that is undone.
  await page.locator('.todo-meeting').filter({ hasText: 'E2E pricing sync' }).first().click();
  const scanned = (await h.state()).todoScans[meeting.id].at;
  await page.getByRole('button', { name: 'Enhance notes', exact: true }).first().click();
  await h.waitForState((s, { id, at }) => s.todoScans[id].at !== at && !s.todoProgress.running, {
    id: meeting.id,
    at: scanned,
  });
  const after = (await h.state()).todos;
  assert.equal(after.length, 3);
  assert.ok(after.find((t) => t.text === send.task).doneAt, 'the tick survives');
  assert.equal(after.find((t) => t.text === send.task).assignee, 'me', 'mine stays mine');
  assert.equal(after.find((t) => t.text === update.task).assignee, 'me', 'my change survives');
  assert.ok(after.find((t) => t.text === book.task).dismissedAt, 'dismissed stays dismissed');

  // Past meetings wait for the button, and stop when told to.
  await page.getByRole('button', { name: 'Back to Todos', exact: true }).click();
  await page
    .getByRole('navigation', { name: 'Notebook' })
    .getByRole('button', { name: 'Home' })
    .click();
  await h.create('E2E older call', 'Own note from the call');
  await h.create('E2E oldest call', 'Another own note');
  await page.getByRole('button', { name: 'Back to Home', exact: true }).click();
  await openTodos(page);
  await page.getByText('2 meetings not read for todos', { exact: true }).waitFor();
  await page.getByText('Uses 2 requests from your AI plan.', { exact: true }).waitFor();
  await page.getByRole('combobox', { name: 'Meetings to read' }).selectOption('all');
  const requests = () => h.state().then((s) => Object.keys(s.todoScans).length);
  assert.equal(await requests(), 1, 'nothing is read until asked');
  await page.getByRole('button', { name: 'Find todos', exact: true }).click();
  await page.getByText('Finding todos… 0 of 2 meetings', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await h.waitForState((s) => !s.todoProgress.running);
  assert.equal(await requests(), 1, 'a stopped scan saves nothing');
  await page.getByRole('button', { name: 'Find todos', exact: true }).click();
  await h.waitForState((s) => !s.todoProgress.running && Object.keys(s.todoScans).length === 3);
  await row(page, 'Call the supplier').waitFor();

  // A restart keeps it all; deleting forever removes.
  const reopened = await h.restart();
  await openTodos(reopened);
  await row(reopened, 'Update the onboarding page').waitFor();
  await h.call('update', meeting.id, { deletedAt: true });
  await h.call('delete-forever', [meeting.id]);
  const gone = await h.waitForState((s) => !s.todos.some((t) => t.meetingId === meeting.id));
  assert.equal(gone.todoScans[meeting.id], undefined);
  await row(reopened, 'Update the onboarding page').waitFor({ state: 'hidden' });
  await h.screenshot('todos-after-delete');
  h.assertNoRendererErrors();
}
