import { createTodoTools, getCurrentTodos, clearCurrentTodos } from '../src/tools/todoTools.js';

describe('TodoWrite', () => {
  let handler: (args: Record<string, unknown>) => Promise<string>;

  beforeEach(() => {
    clearCurrentTodos();
    const tool = createTodoTools().find((t) => t.name === 'TodoWrite');
    if (!tool) throw new Error('TodoWrite tool not found');
    handler = tool.handler as (args: Record<string, unknown>) => Promise<string>;
  });

  it('replaces the list each call (state is total, not append)', async () => {
    await handler({
      todos: [
        { content: 'Read auth code', status: 'completed' },
        { content: 'Fix race condition', status: 'in_progress' },
        { content: 'Write tests', status: 'pending' },
      ],
    });
    expect(getCurrentTodos().length).toBe(3);
    expect(getCurrentTodos()[1].status).toBe('in_progress');

    // Replace with a single item — old list must be gone.
    await handler({
      todos: [{ content: 'Only this one', status: 'pending' }],
    });
    expect(getCurrentTodos().length).toBe(1);
    expect(getCurrentTodos()[0].content).toBe('Only this one');
  });

  it('renders a plan with status markers', async () => {
    const out = await handler({
      todos: [
        { content: 'Task one', status: 'completed' },
        { content: 'Task two', status: 'in_progress', activeForm: 'Working on task two' },
        { content: 'Task three', status: 'pending' },
      ],
    });
    expect(out).toContain('Task one');
    // While in_progress, render uses activeForm if provided.
    expect(out).toContain('Working on task two');
    expect(out).toContain('Task three');
  });

  it('skips entries without content', async () => {
    await handler({
      todos: [
        { content: '', status: 'pending' },
        { status: 'pending' },
        { content: 'Real task', status: 'pending' },
      ],
    });
    expect(getCurrentTodos().length).toBe(1);
    expect(getCurrentTodos()[0].content).toBe('Real task');
  });

  it('coerces unknown status to pending', async () => {
    await handler({
      todos: [
        { content: 'Task A', status: 'wontfix' },
        { content: 'Task B', status: 'in-progress' }, // hyphenated form
      ],
    });
    expect(getCurrentTodos()[0].status).toBe('pending');
    expect(getCurrentTodos()[1].status).toBe('in_progress');
  });

  it('warns when more than one task is in_progress', async () => {
    const out = await handler({
      todos: [
        { content: 'Task A', status: 'in_progress' },
        { content: 'Task B', status: 'in_progress' },
        { content: 'Task C', status: 'pending' },
      ],
    });
    expect(out).toMatch(/2 tasks are in_progress/);
  });

  it('handles empty list (clearing the plan)', async () => {
    await handler({ todos: [{ content: 'Foo', status: 'pending' }] });
    expect(getCurrentTodos().length).toBe(1);
    await handler({ todos: [] });
    expect(getCurrentTodos().length).toBe(0);
  });

  it('rejects non-array todos input gracefully', async () => {
    await handler({ todos: 'not an array' as unknown as object });
    expect(getCurrentTodos().length).toBe(0);
  });
});
