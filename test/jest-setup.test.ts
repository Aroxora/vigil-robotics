// Simple Jest test to verify the setup works
describe('Jest Setup Test', () => {
  it('should pass a basic test', () => {
    expect(1 + 1).toBe(2);
  });

  it('should handle async operations', async () => {
    const result = await Promise.resolve('success');
    expect(result).toBe('success');
  });

  it('should have access to Jest globals', () => {
    expect(jest).toBeDefined();
    expect(expect).toBeDefined();
    expect(describe).toBeDefined();
    expect(it).toBeDefined();
  });
});