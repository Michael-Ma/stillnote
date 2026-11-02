import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
    {
      mode: 'success',
      text: items({
        task: 'Call the supplier',
        assignee: 'unclear',
        due: 'in the new year',
        dueDate: '2099-01-05',
        quote: '',
      }),
    },
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
const dayFromNow = (days) => {
  const at = new Date();
  at.setDate(at.getDate() + days);
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
};
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
  await h.screenshot('todos');

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
    .getByRole('button', { name: 'Delete “Book a room for the offsite”' })
    .click();
  await h.waitForState((s) => s.todos.find((t) => t.text === book.task).dismissedAt);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await h.waitForState((s) => !s.todos.find((t) => t.text === book.task).dismissedAt);
  await row(page, 'Book a room for the offsite')
    .getByRole('button', { name: 'Delete “Book a room for the offsite”' })
    .click();
  await h.waitForState((s) => s.todos.find((t) => t.text === book.task).dismissedAt);

  // The user's own words, and their own todos, need no AI and no meeting.
  await row(page, 'Update the onboarding page')
    .getByRole('button', { name: 'Edit “Update the onboarding page”' })
    .click();
  const editing = page.locator('.todo-row.editing');
  await editing.getByRole('textbox', { name: 'Todo', exact: true }).fill('Rewrite onboarding');
  await page.keyboard.press('Escape');
  await editing.waitFor({ state: 'hidden' });
  assert.equal(
    (await h.state()).todos.some((t) => t.text === 'Rewrite onboarding'),
    false,
  );
  await row(page, 'Update the onboarding page')
    .getByRole('button', { name: 'Edit “Update the onboarding page”' })
    .click();
  await editing.getByRole('textbox', { name: 'Todo', exact: true }).fill('Rewrite onboarding');
  await page.keyboard.press('Enter');
  await row(page, 'Rewrite onboarding').waitFor();

  const adding = page.getByRole('textbox', { name: 'Add a todo', exact: true });
  await adding.fill('Book the dentist');
  await adding.press('Enter');
  await row(page, 'Book the dentist').waitFor();
  assert.equal(await adding.inputValue(), '', 'the box is ready for the next one');
  await adding.fill('Renew the passport');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await row(page, 'Renew the passport').waitFor();
  await page
    .locator('.todo-group')
    .first()
    .getByRole('heading', { name: 'Added by you', exact: true })
    .waitFor();
  await page
    .getByRole('navigation', { name: 'Notebook' })
    .getByRole('button', { name: /^Todos/ })
    .filter({ hasText: '3' })
    .waitFor();

  // A deadline is a day, set while adding or later.
  await adding.fill('Pay the invoice');
  await page.getByRole('textbox', { name: 'Deadline', exact: true }).fill(dayFromNow(1));
  await adding.press('Enter');
  await row(page, 'Pay the invoice').getByText('Tomorrow', { exact: true }).waitFor();
  await row(page, 'Book the dentist')
    .getByRole('button', { name: 'Edit “Book the dentist”' })
    .click();
  await editing.getByRole('textbox', { name: 'Deadline', exact: true }).fill(dayFromNow(-2));
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await row(page, 'Book the dentist').locator('.todo-overdue').waitFor();

  // An important todo leads its group, and shows without the pointer on it.
  await row(page, 'Pay the invoice')
    .getByRole('button', { name: 'Mark “Pay the invoice” as important' })
    .click();
  await page
    .locator('.todo-group')
    .first()
    .locator('.todo-row')
    .first()
    .filter({ hasText: 'Pay the invoice' })
    .waitFor();
  await page.mouse.move(1, 1);
  await page.locator('h1').click();
  const flag = row(page, 'Pay the invoice').getByRole('button', {
    name: 'Remove “Pay the invoice” from important',
  });
  await flag.waitFor();
  assert.equal(await flag.evaluate((button) => getComputedStyle(button).opacity), '1');
  await h.screenshot('todos-added');
  await row(page, 'Renew the passport')
    .getByRole('button', { name: 'Delete “Renew the passport”' })
    .click();
  await h.waitForState((s) => !s.todos.some((t) => t.text === 'Renew the passport'));
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await row(page, 'Renew the passport').waitFor();
  await row(page, 'Renew the passport')
    .getByRole('button', { name: 'Delete “Renew the passport”' })
    .click();
  await h.waitForState((s) => !s.todos.some((t) => t.text === 'Renew the passport'));

  // One click puts a todo with a deadline in the calendar, says which, and can be taken back.
  const helperSaw = (op) =>
    readFileSync(join(h.dataDir, 'adapter-events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((event) => event.type === 'native-command' && event.op === op);
  const toCalendar = (text) =>
    row(page, text).getByRole('button', { name: `Add “${text}” to calendar` });
  const linked = (text) => (s) => s.todos.find((t) => t.text === text)?.calendarEventId;
  await toCalendar('Pay the invoice').click();
  await page.getByRole('status').filter({ hasText: 'Added to Home.' }).waitFor();
  assert.deepEqual(
    helperSaw('save-event').map(({ title, date, eventId }) => [title, date, eventId]),
    [['Pay the invoice', dayFromNow(1), undefined]],
    'only the words and the day go to the calendar',
  );
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await h.waitForState((s) => !linked('Pay the invoice')(s));
  assert.equal(helperSaw('remove-event').length, 1);
  await toCalendar('Pay the invoice').click();
  await row(page, 'Pay the invoice')
    .getByRole('img', { name: 'In your calendar', exact: true })
    .waitFor();
  assert.equal(await toCalendar('Pay the invoice').count(), 0);

  // The event follows the todo; one deleted in Calendar stays deleted; a refusal is said.
  await row(page, 'Pay the invoice')
    .getByRole('button', { name: 'Edit “Pay the invoice”' })
    .click();
  await editing.getByRole('textbox', { name: 'Deadline', exact: true }).fill(dayFromNow(3));
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await editing.waitFor({ state: 'hidden' });
  const moved = helperSaw('save-event').at(-1);
  assert.deepEqual([moved.date, moved.eventId], [dayFromNow(3), 'fixture-event']);
  assert.ok(linked('Pay the invoice')(await h.state()));

  await adding.fill('Event deleted in Calendar');
  await page.getByRole('textbox', { name: 'Deadline', exact: true }).fill(dayFromNow(2));
  await adding.press('Enter');
  await toCalendar('Event deleted in Calendar').click();
  await h.waitForState(linked('Event deleted in Calendar'));
  await row(page, 'Event deleted in Calendar')
    .getByRole('button', { name: 'Edit “Event deleted in Calendar”' })
    .click();
  await editing.getByRole('textbox', { name: 'Deadline', exact: true }).fill(dayFromNow(4));
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await h.waitForState((s) => !linked('Event deleted in Calendar')(s));
  await toCalendar('Event deleted in Calendar').waitFor();

  await adding.fill('Calendar refused this');
  await page.getByRole('textbox', { name: 'Deadline', exact: true }).fill(dayFromNow(2));
  await adding.press('Enter');
  await toCalendar('Calendar refused this').click();
  await page
    .getByRole('alert')
    .getByText('Allow Calendar access in System Settings → Privacy & Security.', { exact: true })
    .waitFor();
  assert.equal(linked('Calendar refused this')(await h.state()), null);
  assert.equal(await toCalendar('Calendar refused this').isEnabled(), true);
  for (const text of ['Event deleted in Calendar', 'Calendar refused this']) {
    await row(page, text)
      .getByRole('button', { name: `Delete “${text}”` })
      .click();
    await h.waitForState((s, gone) => !s.todos.some((t) => t.text === gone), text);
  }

  // Enhancing again scans again, and none of that is undone.
  await page.locator('.todo-meeting').filter({ hasText: 'E2E pricing sync' }).first().click();
  const scanned = (await h.state()).todoScans[meeting.id].at;
  await page.getByRole('button', { name: 'Enhance notes', exact: true }).first().click();
  await h.waitForState((s, { id, at }) => s.todoScans[id].at !== at && !s.todoProgress.running, {
    id: meeting.id,
    at: scanned,
  });
  const after = (await h.state()).todos;
  assert.equal(after.length, 5);
  assert.ok(after.find((t) => t.text === send.task).doneAt, 'the tick survives');
  assert.equal(after.find((t) => t.text === send.task).assignee, 'me', 'mine stays mine');
  const rewritten = after.find((t) => t.text === 'Rewrite onboarding');
  assert.equal(rewritten.assignee, 'me', 'my change survives');
  assert.equal(rewritten.foundAs, update.task, 'and the scan knows it, so it is not repeated');
  assert.ok(after.find((t) => t.text === book.task).dismissedAt, 'deleted stays deleted');

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
  const range = page.getByRole('combobox', { name: 'Meetings to read' });
  const scan = page.getByRole('button', { name: 'Find todos', exact: true });
  assert.equal((await range.boundingBox()).height, (await scan.boundingBox()).height);
  await h.screenshot('todos-scan');
  await range.selectOption('all');
  const requests = () => h.state().then((s) => Object.keys(s.todoScans).length);
  assert.equal(await requests(), 1, 'nothing is read until asked');
  await page.getByRole('button', { name: 'Find todos', exact: true }).click();
  await page.getByText('Finding todos… 0 of 2 meetings', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await h.waitForState((s) => !s.todoProgress.running);
  assert.equal(await requests(), 1, 'a stopped scan saves nothing');
  await page.getByRole('button', { name: 'Find todos', exact: true }).click();
  await h.waitForState((s) => !s.todoProgress.running && Object.keys(s.todoScans).length === 3);
  await row(page, 'Call the supplier').getByText('Jan 5, 2099', { exact: true }).waitFor();

  // The same todos by deadline, each saying which meeting it came from.
  await page.getByRole('tab', { name: 'By deadline', exact: true }).click();
  const part = (name) =>
    page.locator('.todo-group').filter({ has: page.getByRole('heading', { name, exact: true }) });
  await part('Overdue').locator('.todo-row').filter({ hasText: 'Book the dentist' }).waitFor();
  await part('Upcoming')
    .locator('.todo-row')
    .first()
    .filter({ hasText: 'Pay the invoice' })
    .waitFor();
  await part('Upcoming')
    .locator('.todo-row')
    .last()
    .filter({ hasText: 'Call the supplier' })
    .waitFor();
  await part('No deadline')
    .locator('.todo-row')
    .filter({ hasText: 'Rewrite onboarding' })
    .getByRole('button', { name: 'E2E pricing sync', exact: true })
    .waitFor();
  await h.screenshot('todos-by-deadline');

  // A restart keeps it all; deleting forever removes.
  const reopened = await h.restart();
  await openTodos(reopened);
  await reopened.getByRole('tab', { name: 'By deadline', exact: true, selected: true }).waitFor();
  await row(reopened, 'Rewrite onboarding').waitFor();
  await row(reopened, 'Book the dentist').waitFor();
  await h.call('update', meeting.id, { deletedAt: true });
  await h.call('delete-forever', [meeting.id]);
  const gone = await h.waitForState((s) => !s.todos.some((t) => t.meetingId === meeting.id));
  assert.equal(gone.todoScans[meeting.id], undefined);
  await row(reopened, 'Rewrite onboarding').waitFor({ state: 'hidden' });
  await row(reopened, 'Book the dentist').waitFor();
  await h.screenshot('todos-after-delete');
  h.assertNoRendererErrors();
}
