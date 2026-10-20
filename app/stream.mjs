export async function consumeResponse(body, onDelta = () => {}) {
  let buffer = '',
    text = '',
    completed = false;
  const decoder = new TextDecoder();
  const event = (block) => {
    const data = block
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart())
      .join('\n');
    if (!data || data === '[DONE]') return;
    const e = JSON.parse(data);
    if (e.type === 'response.output_text.delta') {
      text += e.delta;
      onDelta(e.delta);
    }
    if (e.type === 'response.completed') {
      if (e.response?.status && e.response.status !== 'completed')
        throw new Error('The response did not complete.');
      completed = true;
    }
    if (['error', 'response.failed', 'response.incomplete'].includes(e.type))
      throw new Error(
        e.response?.error?.message ??
          e.error?.message ??
          e.message ??
          'ChatGPT could not complete the response. Check your plan usage and try again.',
      );
  };
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r/g, '');
    let end;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      event(buffer.slice(0, end));
      buffer = buffer.slice(end + 2);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) event(buffer);
  if (!completed)
    throw new Error('Connection ended before ChatGPT finished. Your previous notes are unchanged.');
  if (!text.trim()) throw new Error('ChatGPT returned an empty response.');
  return text;
}
